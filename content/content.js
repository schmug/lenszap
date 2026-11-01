// SPDX-License-Identifier: Apache-2.0
//
// Content script for the LensPub Zapper.
//
// NOT A LENSPUB ENGINE. A conforming Lens Engine never hides content by
// default (spec/lenspub-protocol.md Section 7.3). This tool does exactly that,
// on purpose; see docs/explorations/semantic-zapper.md Section 5 for why it is
// a separate tool and which LensPub rules it keeps anyway. On every page it:
//   1. splits the page into blocks (paragraphs, list items, cards, sidebars,
//      and, on sites with a rule in core/segment.js, the site's own items);
//   2. scores each block against the reader's interest topics, with the
//      lexical scorer or a model on this machine, visible blocks first and a
//      few at a time, so blocks are judged and zapped as the answers arrive;
//   3. hides blocks it is confident are off-lens, by attribute + stylesheet,
//      never by removing or rewriting nodes;
//   4. keeps a ledger of every hidden block with its reasoning, and checks
//      after every pass that what is hidden equals what the ledger lists;
//   5. never hides page controls, corrections, or primary sources, or anything
//      the scorer returned nothing for.
// The controls live in Chrome's side panel (sidepanel/), which reads the
// ledger from here and sends actions back. On the page itself this script
// draws only the hover popover, the scoring spark, and training labels, all
// inside a closed shadow root. Page text is only ever written with textContent.

(async () => {
  if (window.top !== window) return;

  const url = (p) => chrome.runtime.getURL(p);
  const [{ decide, checkLedger }, { scoreLexical, LEXICAL_SCORER_ID }, { siteRule, groupWithFollowing, scoringOrder }, { toExample }] =
    await Promise.all([
      import(url('core/decide.js')),
      import(url('core/lexical-scorer.js')),
      import(url('core/segment.js')),
      import(url('core/train.js'))
    ]);
  const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
  const host = location.hostname;
  const rule = siteRule(host);

  let state = await send('get-state', { host });
  if (!state || state.error) return;

  // --- Page model ----------------------------------------------------------

  const blocks = new Map(); // id → { els: Element[], text }
  const scores = new Map(); // id → scorer output
  const restored = new Set(); // ids restored on this page (never persisted)
  const labels = new Map(); // id → 'keep' | 'zap', marked in training mode on this page
  let decisions = [];
  let decisionById = new Map();
  let scorerId = state.settings.scorer === 'lexical' ? LEXICAL_SCORER_ID : 'model (not yet run)';
  let modelError = null;
  let ledgerFailure = null;
  let nextId = 1;
  // Slider positions the side panel is previewing on this page, before they are stored.
  let preview = {};
  const ui = { before: false, train: false };

  const topics = () => (state.lens.interpretation.priorities ?? []).map((p) => p.topic);
  const draftWeights = () => preview.draftWeights ?? state.draftWeights;
  const priorities = () =>
    (state.lens.interpretation.priorities ?? []).map((p) => ({
      topic: p.topic,
      weight: p.topic in draftWeights() ? draftWeights()[p.topic] : p.weight
    }));
  const threshold = () => preview.threshold ?? state.site.threshold ?? state.settings.threshold;
  const paused = () => state.site.paused === true;
  const pct = (x) => `${Math.round(x * 100)}%`;

  // --- Segmentation ----------------------------------------------------------

  const MIN_CHARS = 40;
  const MAX_CONTAINER_CHARS = 1200;
  // Text elements: always one block, however long.
  const LEAFY = new Set(['P', 'BLOCKQUOTE', 'PRE', 'DD', 'FIGCAPTION']);
  // Elements that are one block when short and holding one item, and are
  // split into their children otherwise. A table cell holding a whole list of
  // stories is a container, not a paragraph.
  const CONTAINER = new Set(['ARTICLE', 'SECTION', 'ASIDE', 'DIV', 'TR', 'TD', 'LI', 'FIGURE', 'UL', 'OL']);
  // Never zapped and never descended into: page controls and chrome.
  const STRUCTURAL = [
    'nav', 'header', 'footer', 'form', 'dialog', 'menu', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'video', 'audio', 'iframe',
    'input', 'textarea', 'select', 'button', '[role="dialog"]', '[role="alertdialog"]',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
    '[role="menu"]', '[aria-modal="true"]', '[contenteditable="true"]',
    ...(rule?.structural ? [rule.structural] : [])
  ].join(',');
  // A container holding one of these is split into its parts instead.
  const SPLIT_IF_CONTAINS = [
    'h1, form, input, textarea, select, dialog, [role="dialog"], nav, [data-lpz-id]',
    ...(rule?.structural ? [rule.structural] : [])
  ].join(',');

  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  function hasSeveralItems(el) {
    let n = 0;
    for (const c of el.children) if (norm(c.textContent).length >= MIN_CHARS && ++n >= 2) return true;
    return false;
  }

  function register(els, text) {
    const id = `b${nextId++}`;
    for (const el of els) el.setAttribute('data-lpz-id', id);
    blocks.set(id, { els, text });
    return id;
  }

  /** Find new blocks; returns their ids. Blocks already registered are kept. */
  function scan() {
    for (const [id, b] of blocks) {
      if (!b.els.some((el) => el.isConnected)) {
        blocks.delete(id);
        scores.delete(id);
        restored.delete(id);
        labels.delete(id);
      }
    }
    const added = [];
    if (rule) {
      for (const item of document.querySelectorAll(rule.item)) {
        if (item.hasAttribute('data-lpz-id') || item.closest(STRUCTURAL)) continue;
        // Cell by cell, so "1." and the title do not run together.
        const text = norm([...item.children].map((c) => c.textContent).join(' ') || item.textContent);
        if (!text) continue;
        const els = groupWithFollowing(
          item,
          (s) => s.matches(rule.stop) || s.hasAttribute('data-lpz-id') || s.matches(STRUCTURAL) || !!s.querySelector(SPLIT_IF_CONTAINS)
        );
        added.push(register(els, text));
      }
    }
    (function walk(el) {
      for (const child of el.children) {
        if (child === overlayHost || child.hasAttribute('data-lpz-id')) continue;
        if (child.matches(STRUCTURAL)) continue;
        const text = norm(child.textContent);
        if (text.length < MIN_CHARS) continue;
        if (child.getClientRects().length === 0) continue; // not rendered
        const tag = child.tagName;
        const role = child.getAttribute('role');
        const containerish = CONTAINER.has(tag) || role === 'article' || role === 'listitem';
        // A container of several text-bearing children (a list, a sidebar of
        // cards, a comment thread) is split so each item is judged on its own.
        const selectable =
          (LEAFY.has(tag) ||
            (containerish && text.length <= MAX_CONTAINER_CHARS && !hasSeveralItems(child))) &&
          !child.querySelector(SPLIT_IF_CONTAINS);
        if (selectable) added.push(register([child], text));
        else walk(child);
      }
    })(document.body);
    return added;
  }

  // --- Scoring: visible blocks first, a few at a time ---------------------------

  const queue = []; // ids waiting for the model
  const active = new Set(); // ids being scored right now
  const progress = { done: 0, total: 0 };
  let inFlight = 0;
  let generation = 0; // bumped to drop answers from a superseded run

  const setAttr = (b, name, value) => {
    for (const el of b.els) {
      if (value == null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  };

  function sortQueue() {
    const items = queue.filter((id) => blocks.has(id)).map((id) => {
      const r = blocks.get(id).els[0].getBoundingClientRect();
      return { id, top: r.top, bottom: r.bottom };
    });
    queue.splice(0, queue.length, ...scoringOrder(items, innerHeight));
  }

  function enqueue(ids) {
    ids = ids.filter((id) => blocks.has(id));
    if (ids.length === 0) return;
    if (state.settings.scorer === 'lexical') {
      scorerId = LEXICAL_SCORER_ID;
      for (const s of scoreLexical(ids.map((id) => ({ id, text: blocks.get(id).text })), topics())) scores.set(s.id, s);
      return;
    }
    queue.push(...ids);
    progress.total += ids.length;
    sortQueue();
    pump();
  }

  function stopScoring() {
    queue.length = 0;
    active.clear();
    drawSparks();
    progress.done = progress.total = 0;
  }

  function pump() {
    const gen = generation;
    const m = state.settings.model;
    const limit = Math.min(8, Math.max(1, Number(m.concurrency) || 4));
    // A decision model answers one block per request; a chat model takes a few.
    const per = m.api === 'systemone' ? 1 : 6;
    while (!modelError && inFlight < limit && queue.length) {
      const ids = queue.splice(0, per).filter((id) => blocks.has(id));
      if (ids.length === 0) continue;
      inFlight++;
      ids.forEach((id) => active.add(id));
      drawSparks();
      send('score-model', { blocks: ids.map((id) => ({ id, text: blocks.get(id).text })), topics: topics() })
        .then((res) => {
          if (gen !== generation) return;
          if (!res || res.error) throw new Error(res?.error ?? 'no answer from the extension');
          scorerId = res.scorer;
          for (const s of res.scores) if (s) scores.set(s.id, s);
        })
        .catch((err) => {
          // Blocks without scores are never zapped: a failed model hides nothing.
          if (gen === generation) {
            modelError = String(err?.message ?? err);
            stopScoring();
          }
        })
        .finally(() => {
          if (gen !== generation) return;
          inFlight--;
          ids.forEach((id) => active.delete(id));
          drawSparks();
          progress.done += ids.length;
          if (!queue.length && !inFlight) progress.done = progress.total = 0;
          apply();
          pump();
        });
    }
    report();
  }

  function rescoreAll() {
    generation++;
    stopScoring();
    inFlight = 0;
    modelError = null;
    scores.clear();
    enqueue([...blocks.keys()]);
    apply();
  }

  // --- Applying decisions, with the zap animation, and the ledger check --------

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const ZAP_MS = 650;
  const UNZAP_MS = 450;
  const animating = () => state.settings.animate !== false && !reduceMotion.matches && !ui.before && !paused();
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.width > 0;
  };
  const isHidden = (b) => b.els[0].hasAttribute('data-lpz-zapped') || b.els[0].hasAttribute('data-lpz-zapping');

  function setZap(b, on) {
    if (on === isHidden(b)) return;
    if (on) {
      setAttr(b, 'data-lpz-unzap', null);
      if (!animating() || !b.els.some(inView)) {
        setAttr(b, 'data-lpz-zapped', '');
        return;
      }
      // The block flashes, then vanishes. It counts as hidden from the start,
      // so the ledger check sees it either way.
      setAttr(b, 'data-lpz-zapping', '');
      setTimeout(() => {
        if (!b.els[0].hasAttribute('data-lpz-zapping')) return; // un-zapped meanwhile
        setAttr(b, 'data-lpz-zapping', null);
        setAttr(b, 'data-lpz-zapped', '');
      }, ZAP_MS);
    } else {
      setAttr(b, 'data-lpz-zapping', null);
      setAttr(b, 'data-lpz-zapped', null);
      if (animating()) {
        setAttr(b, 'data-lpz-unzap', '');
        setTimeout(() => setAttr(b, 'data-lpz-unzap', null), UNZAP_MS);
      }
    }
  }

  function apply() {
    const scored = [...blocks.keys()].filter((id) => scores.has(id)).map((id) => scores.get(id));
    // Paused: blocks are still scored and decided, so resuming is instant and
    // the panel can say what would be hidden, but nothing on the page changes.
    decisions = ledgerFailure
      ? []
      : decide({ scores: scored, priorities: priorities(), threshold: threshold(), scorer: scorerId, restored });
    decisionById = new Map(decisions.map((d) => [d.id, d]));
    const zap = new Set(paused() ? [] : decisions.filter((d) => d.zap).map((d) => d.id));
    for (const [id, b] of blocks) setZap(b, zap.has(id));

    const hidden = new Set(
      [...document.querySelectorAll('[data-lpz-zapped], [data-lpz-zapping]')].map((el) => el.getAttribute('data-lpz-id'))
    );
    const check = checkLedger(hidden, zap);
    if (!check.ok) {
      ledgerFailure = check;
      document.querySelectorAll('[data-lpz-zapped], [data-lpz-zapping]').forEach((el) => {
        el.removeAttribute('data-lpz-zapped');
        el.removeAttribute('data-lpz-zapping');
      });
      decisions = [];
      decisionById = new Map();
    }
    drawSparks();
    if (paused() && tipFor && !ui.train) hideTip();
    else if (tipFor) renderTip(tipFor);
    report();
  }

  // --- Reporting to the side panel ------------------------------------------------

  const snippet = (id) => {
    const t = blocks.get(id)?.text ?? '';
    return t.length > 160 ? `${t.slice(0, 160)}…` : t;
  };

  function snapshot() {
    const entry = (d) => ({ id: d.id, snippet: snippet(d.id), offLens: d.offLens, trace: d.trace });
    return {
      host,
      blocks: blocks.size,
      scorer: scorerId,
      progress: { ...progress },
      modelError,
      ledgerFailure: !!ledgerFailure,
      paused: paused(),
      threshold: threshold(),
      before: ui.before,
      train: ui.train,
      rule: rule?.name ?? null,
      labelled: { keep: [...labels.values()].filter((l) => l === 'keep').length, zap: [...labels.values()].filter((l) => l === 'zap').length },
      zapped: paused() ? [] : decisions.filter((d) => d.zap).map(entry),
      wouldZap: paused() ? decisions.filter((d) => d.zap).map(entry) : [],
      restored: decisions.filter((d) => d.exempt === 'restored').map(entry)
    };
  }

  // Coalesced: a slider drag or a burst of model answers sends one update.
  let reportTimer = null;
  function report() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      send('page-update', { page: snapshot() }).catch(() => {});
    }, 60);
  }

  function showBlock(id) {
    const b = blocks.get(id);
    if (!b) return;
    b.els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setAttr(b, 'data-lpz-flash', '');
    setTimeout(() => setAttr(b, 'data-lpz-flash', null), 1600);
  }

  function setBefore(on) {
    ui.before = on;
    document.documentElement.classList.toggle('lpz-before', on);
  }

  function setTrain(on) {
    ui.train = on;
    document.documentElement.classList.toggle('lpz-train', on);
    // Training shows zapped blocks too, so wrong zaps can be marked Keep.
    setBefore(on);
    unpin();
    if (!on) for (const [, b] of blocks) setAttr(b, 'data-lpz-label', null);
    else for (const [id, l] of labels) if (blocks.has(id)) setAttr(blocks.get(id), 'data-lpz-label', l);
  }

  const pageActions = {
    get: () => snapshot(),
    restore: ({ id }) => { restored.add(id); apply(); showBlock(id); },
    unrestore: ({ id }) => { restored.delete(id); apply(); },
    'restore-all': () => { decisions.filter((d) => d.zap).forEach((d) => restored.add(d.id)); apply(); },
    show: ({ id }) => showBlock(id),
    before: ({ on }) => { setBefore(on); apply(); },
    train: ({ on }) => { setTrain(on); apply(); },
    preview: ({ values }) => { preview = { ...preview, ...values }; apply(); },
    'end-preview': () => { preview = {}; apply(); },
    retry: () => { modelError = null; enqueue([...blocks.keys()].filter((id) => !scores.has(id))); apply(); }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'page-action' || !pageActions[msg.action]) return false;
    sendResponse(pageActions[msg.action](msg) ?? snapshot());
    return false;
  });

  // --- On-page layer: hover popover, scoring sparks, training choices -------------

  const overlayHost = document.createElement('lenspub-zapper');
  // Inline and !important, so page stylesheets cannot move or hide the layer.
  for (const [k, v] of Object.entries({
    all: 'initial', position: 'fixed', inset: '0', 'z-index': '2147483647', display: 'block', 'pointer-events': 'none'
  })) overlayHost.style.setProperty(k, v, 'important');
  const shadow = overlayHost.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(await (await fetch(url('content/overlay.css'))).text());
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    /* an unstyled popover still works */
  }

  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'text') el.textContent = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const sparks = h('div', { class: 'sparks' });
  const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
  shadow.append(sparks, tip);
  document.documentElement.append(overlayHost);

  // Scoring spark: a short bright dash races round the edge of each block the
  // model is judging, over a faint track. Drawn on this layer, not on the page.
  const sparkEls = new Map(); // id → svg
  let sparkFrame = 0;
  function unionRect(b) {
    const rects = b.els.map((el) => el.getBoundingClientRect()).filter((r) => r.width || r.height);
    if (!rects.length) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    return { left, top, width: Math.max(...rects.map((r) => r.right)) - left, height: Math.max(...rects.map((r) => r.bottom)) - top };
  }
  function drawSparks() {
    const show = state.settings.animate !== false && !reduceMotion.matches && !paused();
    for (const [id, svg] of sparkEls) {
      if (!show || !active.has(id)) {
        svg.remove();
        sparkEls.delete(id);
      }
    }
    if (show) {
      for (const id of active) {
        if (sparkEls.has(id) || !blocks.has(id)) continue;
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('class', 'spark');
        for (const cls of ['track', 'run', 'run trail']) {
          const r = document.createElementNS(SVG, 'rect');
          r.setAttribute('class', cls);
          r.setAttribute('pathLength', '100');
          r.setAttribute('rx', '6');
          svg.append(r);
        }
        sparks.append(svg);
        sparkEls.set(id, svg);
      }
    }
    if (sparkEls.size && !sparkFrame) sparkFrame = requestAnimationFrame(placeSparks);
  }
  function placeSparks() {
    sparkFrame = 0;
    for (const [id, svg] of sparkEls) {
      const r = blocks.has(id) ? unionRect(blocks.get(id)) : null;
      if (!r) {
        svg.style.display = 'none';
        continue;
      }
      const pad = 3;
      const w = Math.round(r.width + pad * 2);
      const hgt = Math.round(r.height + pad * 2);
      svg.style.display = '';
      svg.style.transform = `translate(${Math.round(r.left - pad)}px, ${Math.round(r.top - pad)}px)`;
      if (svg.dataset.size !== `${w}x${hgt}`) {
        svg.dataset.size = `${w}x${hgt}`;
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(hgt));
        for (const rect of svg.children) {
          rect.setAttribute('x', '1');
          rect.setAttribute('y', '1');
          rect.setAttribute('width', String(Math.max(0, w - 2)));
          rect.setAttribute('height', String(Math.max(0, hgt - 2)));
        }
      }
    }
    if (sparkEls.size) sparkFrame = requestAnimationFrame(placeSparks);
  }

  // Hover popover: score and reason for any block. In training mode a click
  // pins it, with Keep and Zap buttons.
  let tipFor = null;
  let pinned = false;
  let hoverTimer = null;
  let hoverId = null;

  function hideTip() {
    if (pinned) return;
    clearTimeout(hoverTimer);
    if (hoverId && blocks.has(hoverId)) setAttr(blocks.get(hoverId), 'data-lpz-hover', null);
    hoverId = tipFor = null;
    tip.hidden = true;
  }
  function unpin() {
    pinned = false;
    tip.classList.remove('pinned');
    hideTip();
  }

  async function label(id, l) {
    const ex = toExample(scores.get(id), l, topics());
    if (!ex) return;
    labels.set(id, l);
    setAttr(blocks.get(id), 'data-lpz-label', l);
    await send('train-add', { example: ex });
    unpin();
    report();
  }

  function renderTip(id) {
    const b = blocks.get(id);
    if (!b) return hideTip();
    const d = decisionById.get(id);
    const s = scores.get(id);
    const parts = [];
    let verdict;
    let cls;
    if (paused()) [verdict, cls] = ['Paused on this site', 'muted'];
    else if (active.has(id) || queue.includes(id)) [verdict, cls] = ['Scoring…', 'muted'];
    else if (!d) [verdict, cls] = [modelError ? 'Not scored (the model failed)' : 'Not scored yet', 'muted'];
    else if (d.zap) [verdict, cls] = ['Zapped', 'off'];
    else if (d.exempt === 'restored') [verdict, cls] = ['Restored by you', 'on'];
    else if (d.exempt) [verdict, cls] = ['Never zapped', 'on'];
    else [verdict, cls] = ['Kept', 'on'];
    parts.push(h('div', { class: 'tip-head' }, h('span', { class: `pill ${cls}`, text: verdict }),
      d ? h('span', { class: 'big', text: `${pct(d.offLens)} off-lens` }) : null));
    if (d) {
      parts.push(h('div', { class: 'meter', title: `Zap at ${pct(threshold())}` },
        h('div', { class: `fill ${d.zap ? 'off' : ''}`, style: `width:${Math.round(d.offLens * 100)}%` }),
        h('div', { class: 'mark', style: `left:${Math.round(threshold() * 100)}%` })));
      parts.push(h('div', { class: 'tip-note', text: `Zaps at ${pct(threshold())} or more` }));
    }
    if (s && !s.unscored && s.matches) {
      const weights = new Map(priorities().map((p) => [p.topic, p.weight]));
      const rows = Object.entries(s.matches).sort((a, b2) => b2[1] - a[1]);
      parts.push(h('table', { class: 'matches' },
        h('tbody', {}, rows.map(([t, m]) => {
          const w = weights.get(t) ?? 0;
          return h('tr', {},
            h('td', { class: 'topic', text: t }),
            h('td', { class: 'num', text: pct(m) }),
            h('td', { class: `num w ${w < 0 ? 'neg' : ''}`, text: `${w > 0 ? '+' : ''}${w.toFixed(2)}` }));
        }))));
    }
    if (d) parts.push(h('div', { class: 'why', text: d.trace }));
    if (ui.train) {
      const can = toExample(s, 'keep', topics());
      const mine = labels.get(id);
      parts.push(can
        ? h('div', { class: 'train' },
            h('span', { text: mine ? `You marked: ${mine === 'keep' ? 'Keep' : 'Zap'}` : pinned ? 'Should this stay?' : 'Click to mark it' }),
            pinned ? h('button', { class: 'keep', text: 'Keep', on: { click: () => label(id, 'keep') } }) : null,
            pinned ? h('button', { class: 'zap', text: 'Zap', on: { click: () => label(id, 'zap') } }) : null,
            pinned ? h('button', { class: 'skip', text: '×', 'aria-label': 'Close', on: { click: unpin } }) : null)
        : h('div', { class: 'train' }, h('span', { text: s?.evidence ? 'Corrections and sources are never zapped, so there is nothing to train.' : 'Not scored, so it cannot be marked.' })));
    }
    tip.replaceChildren(...parts);
    tip.hidden = false;
    tipFor = id;
    placeTip(b);
  }

  function placeTip(b) {
    const r = unionRect(b);
    if (!r) return;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const x = Math.max(8, Math.min(r.left, innerWidth - tw - 8));
    let y = r.top + r.height + 6;
    if (y + th > innerHeight - 8) y = r.top - th - 6;
    if (y < 8) y = Math.min(innerHeight - th - 8, Math.max(8, r.top + 8));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  document.addEventListener('pointerover', (e) => {
    if (pinned || ((paused() || state.settings.hoverInfo === false) && !ui.train)) return;
    const el = e.target instanceof Element ? e.target.closest('[data-lpz-id]') : null;
    const id = el?.getAttribute('data-lpz-id') ?? null;
    if (id === hoverId) return;
    hideTip();
    if (!id || !blocks.has(id)) return;
    hoverId = id;
    setAttr(blocks.get(id), 'data-lpz-hover', '');
    hoverTimer = setTimeout(() => renderTip(id), ui.train ? 120 : 250);
  }, true);
  document.documentElement.addEventListener('pointerleave', hideTip);
  addEventListener('scroll', () => { if (tipFor && !pinned) hideTip(); else if (pinned && tipFor) placeTip(blocks.get(tipFor)); }, { passive: true, capture: true });

  // Training mode: a click on a block marks it instead of following links.
  document.addEventListener('click', (e) => {
    if (!ui.train) return;
    if (e.composedPath().includes(overlayHost)) return; // a click on the popover itself
    const el = e.target instanceof Element ? e.target.closest('[data-lpz-id]') : null;
    if (!el) {
      unpin();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const id = el.getAttribute('data-lpz-id');
    pinned = false;
    hideTip();
    hoverId = id;
    setAttr(blocks.get(id), 'data-lpz-hover', '');
    pinned = true;
    tip.classList.add('pinned');
    renderTip(id);
  }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && pinned) unpin(); });

  // Score what the reader scrolls to next.
  let sortTimer = null;
  addEventListener('scroll', () => {
    if (!queue.length || sortTimer) return;
    sortTimer = setTimeout(() => { sortTimer = null; sortQueue(); }, 300);
  }, { passive: true });

  // --- Run, and keep up with the page -------------------------------------------

  enqueue(scan());
  apply();

  let timer = null;
  new MutationObserver((mutations) => {
    if (mutations.every((m) => overlayHost.contains(m.target))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      enqueue(scan());
      apply();
    }, 800);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !(changes.lens || changes.settings || changes.draftWeights || changes.sites)) return;
    const key = () => {
      const m = state.settings.model;
      return JSON.stringify([topics(), state.settings.scorer, m.api, m.endpoint, m.model]);
    };
    const before = key();
    state = await send('get-state', { host });
    if (key() !== before) rescoreAll();
    else apply();
  });
})();
