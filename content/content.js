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
//   4. lists every hidden block in a ledger with its reasoning, and checks
//      after every pass that what is hidden equals what the ledger lists;
//   5. never hides page controls, corrections, or primary sources, or anything
//      the scorer returned nothing for.
// Hovering any scored block shows its score and the reason for its decision.
//
// Page text is only ever written into the sidebar with textContent.

(async () => {
  if (window.top !== window) return;

  const url = (p) => chrome.runtime.getURL(p);
  const [{ decide, checkLedger }, { scoreLexical, LEXICAL_SCORER_ID }, { siteRule, groupWithFollowing, scoringOrder }] =
    await Promise.all([
      import(url('core/decide.js')),
      import(url('core/lexical-scorer.js')),
      import(url('core/segment.js'))
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
  let decisions = [];
  let decisionById = new Map();
  let scorerId = state.settings.scorer === 'lexical' ? LEXICAL_SCORER_ID : 'model (not yet run)';
  let modelError = null;
  let ledgerFailure = null;
  let nextId = 1;

  const topics = () => (state.lens.interpretation.priorities ?? []).map((p) => p.topic);
  const priorities = () =>
    (state.lens.interpretation.priorities ?? []).map((p) => ({
      topic: p.topic,
      weight: p.topic in state.draftWeights ? state.draftWeights[p.topic] : p.weight
    }));
  const threshold = () => state.site.threshold ?? state.settings.threshold;
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
        if (child === sidebarHost || child.hasAttribute('data-lpz-id')) continue;
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
  const progress = { done: 0, total: 0 };
  let inFlight = 0;
  let generation = 0; // bumped to drop answers from a superseded run

  const setAttr = (b, name, value) => {
    for (const el of b.els) {
      if (value == null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  };
  const markScoring = (id, v) => {
    const b = blocks.get(id);
    if (b) setAttr(b, 'data-lpz-scoring', v);
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
    for (const id of ids) {
      markScoring(id, 'queued');
      queue.push(id);
    }
    progress.total += ids.length;
    sortQueue();
    pump();
  }

  function stopScoring() {
    for (const id of queue) markScoring(id, null);
    queue.length = 0;
    for (const [id, b] of blocks) if (b.els[0].hasAttribute('data-lpz-scoring')) markScoring(id, null);
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
      ids.forEach((id) => markScoring(id, 'active'));
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
          ids.forEach((id) => markScoring(id, null));
          progress.done += ids.length;
          if (!queue.length && !inFlight) progress.done = progress.total = 0;
          apply();
          pump();
        });
    }
    renderHeader();
  }

  function rescoreAll() {
    generation++;
    stopScoring();
    inFlight = 0;
    modelError = null;
    scores.clear();
    enqueue([...blocks.keys()]);
    apply();
    renderBody();
  }

  // --- Applying decisions, with the zap animation, and the ledger check --------

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const ZAP_MS = 650;
  const UNZAP_MS = 450;
  const animating = () => state.settings.animate !== false && !reduceMotion.matches && !ui.before;
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
      // The block crackles, then vanishes. It counts as hidden from the start,
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
    decisions = paused() || ledgerFailure
      ? []
      : decide({ scores: scored, priorities: priorities(), threshold: threshold(), scorer: scorerId, restored });
    decisionById = new Map(decisions.map((d) => [d.id, d]));
    const zap = new Set(decisions.filter((d) => d.zap).map((d) => d.id));
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
    renderHeader();
    renderLedger();
    if (tipFor) renderTip(tipFor);
  }

  // --- Sidebar -----------------------------------------------------------------

  const SIDEBAR_CLASS = { open: 'lpz-docked', min: 'lpz-docked-min' };
  const sidebarHost = document.createElement('lenspub-zapper');
  // Inline and !important, so page stylesheets cannot move or hide the host.
  for (const [k, v] of Object.entries({
    all: 'initial', position: 'fixed', top: '0', right: '0', bottom: '0', 'z-index': '2147483647', display: 'block'
  })) sidebarHost.style.setProperty(k, v, 'important');
  const shadow = sidebarHost.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(await (await fetch(url('content/panel.css'))).text());
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    /* an unstyled sidebar still works */
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

  const ui = { tab: 'ledger', collapsed: state.settings.sidebarCollapsed === true, before: false, hold: false, ledgerDirty: false };

  // Header parts are built once and updated in place, so a click is never lost
  // to a re-render while blocks are being scored.
  const countEl = h('span', { class: 'count', 'aria-live': 'polite' });
  const progressBar = h('div', { class: 'progress', hidden: true }, h('div', { class: 'fill' }));
  const beforeBtn = h('button', {
    title: 'Show the page as published, with zapped blocks outlined',
    on: {
      click: () => {
        ui.before = !ui.before;
        document.documentElement.classList.toggle('lpz-before', ui.before);
        renderHeader();
      }
    }
  });
  const collapseBtn = h('button', {
    class: 'collapse',
    on: {
      click: () => {
        ui.collapsed = !ui.collapsed;
        dock();
        renderHeader();
        send('set-settings', { patch: { sidebarCollapsed: ui.collapsed } });
      }
    }
  });
  const header = h('header', {},
    h('div', { class: 'top' }, h('span', { class: 'title', text: '⚡ Zapper' }), collapseBtn),
    h('div', { class: 'status' }, countEl, beforeBtn),
    progressBar);
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { class: 'body' });
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'LensPub Zapper' }, header, tabs, body);
  const tip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
  shadow.append(sidebar, tip);
  document.documentElement.append(sidebarHost);

  // While the pointer is over the sidebar, the ledger list is not rebuilt
  // under it; it catches up when the pointer leaves.
  sidebar.addEventListener('pointerenter', () => (ui.hold = true));
  sidebar.addEventListener('pointerleave', () => {
    ui.hold = false;
    if (ui.ledgerDirty) renderLedger(true);
  });

  function dock() {
    const html = document.documentElement;
    html.classList.toggle(SIDEBAR_CLASS.open, !ui.collapsed);
    html.classList.toggle(SIDEBAR_CLASS.min, ui.collapsed);
    sidebar.classList.toggle('collapsed', ui.collapsed);
  }
  dock();

  function renderHeader() {
    const zapped = decisions.filter((d) => d.zap).length;
    countEl.replaceChildren();
    if (paused()) countEl.textContent = ui.collapsed ? '‖' : 'Paused on this site';
    else if (ui.collapsed) countEl.append(h('strong', { text: String(zapped) }));
    else {
      countEl.append(h('strong', { text: String(zapped) }), ` hidden of ${blocks.size}`);
      if (progress.total) countEl.append(h('span', { class: 'scoring', text: ` · scoring ${progress.done}/${progress.total}` }));
    }
    countEl.title = `${zapped} hidden of ${blocks.size} blocks`;
    progressBar.hidden = !progress.total;
    progressBar.firstChild.style.width = progress.total ? `${(100 * progress.done) / progress.total}%` : '0';
    beforeBtn.textContent = ui.before ? 'After' : 'Before';
    beforeBtn.setAttribute('aria-pressed', String(ui.before));
    collapseBtn.textContent = ui.collapsed ? '⟨' : '⟩';
    collapseBtn.setAttribute('aria-label', ui.collapsed ? 'Expand the zapper sidebar' : 'Shrink the zapper sidebar');
    collapseBtn.setAttribute('aria-expanded', String(!ui.collapsed));
  }

  function renderTabs() {
    const tab = (key, label) =>
      h('button', {
        role: 'tab',
        'aria-selected': String(ui.tab === key),
        text: label,
        on: { click: () => { ui.tab = key; renderTabs(); renderBody(); } }
      });
    tabs.replaceChildren(tab('ledger', 'Ledger'), tab('interests', 'Interests'), tab('site', 'This site'));
  }

  // replaceChildren would print a literal "null" for skipped optional parts.
  const setBody = (...parts) => body.replaceChildren(...parts.filter((p) => p != null));

  function renderBody() {
    if (ui.tab === 'ledger') renderLedger(true);
    else if (ui.tab === 'interests') renderInterests();
    else renderSite();
  }

  const snippet = (id) => {
    const t = blocks.get(id)?.text ?? '';
    return t.length > 140 ? `${t.slice(0, 140)}…` : t;
  };

  function showBlock(id) {
    const b = blocks.get(id);
    if (!b) return;
    b.els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setAttr(b, 'data-lpz-flash', '');
    setTimeout(() => setAttr(b, 'data-lpz-flash', null), 1600);
  }

  // Each control re-renders right away; scoring updates wait while the
  // pointer is over the sidebar (see ui.hold).
  const act = (fn) => () => { fn(); apply(); renderLedger(true); };

  function renderLedger(force = false) {
    if (ui.tab !== 'ledger') return;
    if (ui.hold && !force) {
      ui.ledgerDirty = true;
      return;
    }
    ui.ledgerDirty = false;
    const parts = [];
    if (ledgerFailure) {
      parts.push(h('div', { class: 'error', role: 'alert' },
        'Stopped: the hidden blocks did not match the ledger, so everything was restored. Reload the page to try again.'));
    }
    if (modelError) {
      parts.push(h('div', { class: 'warn' },
        `Model scorer failed, so nothing more was hidden: ${modelError} `,
        h('button', {
          text: 'Retry',
          on: { click: () => { modelError = null; enqueue([...blocks.keys()].filter((id) => !scores.has(id))); renderLedger(true); } }
        })));
    }
    const zapped = decisions.filter((d) => d.zap);
    const back = decisions.filter((d) => d.exempt === 'restored');
    parts.push(h('p', { class: 'note' },
      zapped.length
        ? 'Every hidden block is listed here. Show puts it back on this page. Hover any block on the page for its score.'
        : paused() ? 'The zapper is paused on this site.' : progress.total ? 'Scoring… blocks are zapped as answers arrive.' : 'Nothing hidden on this page.'));
    if (zapped.length) {
      parts.push(h('div', { class: 'actions' },
        h('button', { text: 'Restore all', on: { click: act(() => zapped.forEach((d) => restored.add(d.id))) } })));
    }
    const entry = (d, button) =>
      h('li', { class: 'entry' },
        h('div', { class: 'row' },
          h('span', { class: `score ${d.zap ? 'off' : ''}`, text: pct(d.offLens), title: 'How sure the scorer is that this block is off your lens' }),
          h('div', { class: 'snippet', text: snippet(d.id) }),
          button),
        h('div', { class: 'why', text: d.trace }));
    parts.push(h('ul', {}, zapped.map((d) =>
      entry(d, h('button', {
        text: 'Show',
        'aria-label': `Show hidden block: ${snippet(d.id).slice(0, 60)}`,
        on: { click: () => { act(() => restored.add(d.id))(); showBlock(d.id); } }
      })))));
    if (back.length) {
      parts.push(h('h3', { text: 'Restored on this page' }));
      parts.push(h('ul', {}, back.map((d) =>
        entry(d, h('button', { text: 'Zap again', on: { click: act(() => restored.delete(d.id)) } })))));
    }
    setBody(...parts);
  }

  function slider({ label, min, max, step, value, format, onInput, onChange }) {
    const val = h('span', { class: 'val', text: format(value) });
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
    input.addEventListener('input', () => { val.textContent = format(Number(input.value)); onInput(Number(input.value)); });
    input.addEventListener('change', () => onChange(Number(input.value)));
    return h('div', { class: 'slider' }, h('label', {}, h('span', { text: label }), val), input);
  }

  function draftCount() {
    return (state.lens.interpretation.priorities ?? []).filter(
      (p) => p.topic in state.draftWeights && state.draftWeights[p.topic] !== p.weight
    ).length;
  }

  function renderInterests(message) {
    const remember = h('input', { type: 'checkbox', id: 'remember' });
    remember.checked = state.site.threshold !== undefined;
    remember.addEventListener('change', async () => {
      if (remember.checked) state.site = (await send('set-site', { host, patch: { threshold: threshold() } })).site;
      else state.site = (await send('set-site', { host, patch: { threshold: null } })).site;
      apply();
    });
    // Both kinds of slider re-decide every block on each step, so the page
    // changes while the slider moves. Scores are cached; nothing is re-scored.
    const conf = slider({
      label: 'Zap when at least this sure a block is off your lens',
      min: 0.5, max: 0.99, step: 0.01, value: threshold(), format: pct,
      onInput: (v) => {
        if (remember.checked) state.site = { ...state.site, threshold: v };
        else state.settings = { ...state.settings, threshold: v };
        apply();
      },
      onChange: async (v) => {
        if (remember.checked) state.site = (await send('set-site', { host, patch: { threshold: v } })).site;
        else state.settings = (await send('set-settings', { patch: { threshold: v } })).settings;
      }
    });

    const status = h('p', { class: 'note' });
    const saveBtn = h('button', { class: 'primary', text: 'Save to lens' });
    const discardBtn = h('button', { text: 'Discard' });
    const updateStatus = () => {
      const n = draftCount();
      status.textContent = n
        ? `${n} unsaved change${n === 1 ? '' : 's'} to your lens (v${state.lens.metadata.lensVersion}). They apply everywhere now; Save writes one new lens version.`
        : `Your lens: “${state.lens.metadata.name}” v${state.lens.metadata.lensVersion}.`;
      saveBtn.disabled = discardBtn.disabled = n === 0;
    };
    saveBtn.addEventListener('click', async () => {
      const r = await send('commit-draft');
      state = await send('get-state', { host });
      apply();
      renderInterests(
        r.error ? `Not saved: ${r.error}`
          : r.unchanged ? 'Nothing to save.'
          : `Saved as v${r.lensVersion} (${r.impact} change).${r.dropped?.length ? ' The signature was removed: this edited copy is now your own lens.' : ''}`
      );
    });
    discardBtn.addEventListener('click', async () => {
      await send('set-draft', { weights: {} });
      state.draftWeights = {};
      apply();
      renderInterests('Changes discarded.');
    });

    const interestSliders = priorities().map((p) =>
      slider({
        label: p.topic,
        min: -1, max: 1, step: 0.05, value: p.weight,
        format: (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)),
        onInput: (v) => {
          state.draftWeights = { ...state.draftWeights, [p.topic]: Math.round(v * 100) / 100 };
          apply();
          updateStatus();
        },
        onChange: () => send('set-draft', { weights: state.draftWeights })
      }));
    updateStatus();

    setBody(
      message ? h('div', { class: 'warn', role: 'status', text: message }) : null,
      conf,
      h('label', { class: 'note' }, remember, ' Remember this threshold for this site only (kept on this device, never in your lens)'),
      h('h3', { text: 'Interests (from your lens)' }),
      h('p', { class: 'note', text: 'Positive: keep blocks about this. Negative: zap blocks about this.' }),
      ...interestSliders,
      status,
      h('div', { class: 'actions' }, saveBtn, discardBtn)
    );
  }

  function toggleSetting(key, label) {
    const box = h('input', { type: 'checkbox' });
    box.checked = state.settings[key] !== false;
    box.addEventListener('change', async () => {
      state.settings = (await send('set-settings', { patch: { [key]: box.checked } })).settings;
      if (key === 'hoverInfo' && !box.checked) hideTip();
    });
    return h('label', { class: 'check' }, box, ` ${label}`);
  }

  function renderSite() {
    const pauseBtn = h('button', {
      'aria-pressed': String(paused()),
      text: paused() ? 'Resume on this site' : 'Pause on this site',
      on: {
        click: async () => {
          state.site = (await send('set-site', { host, patch: { paused: paused() ? null : true } })).site;
          apply();
          renderSite();
        }
      }
    });
    setBody(
      h('div', { class: 'actions' }, pauseBtn,
        h('button', { text: 'Settings…', on: { click: () => send('open-options') } })),
      h('h3', { text: 'Display' }),
      toggleSetting('hoverInfo', 'Show the score when I hover over a block'),
      toggleSetting('animate', 'Animate scoring and zapping'),
      h('h3', { text: 'How this page was judged' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Scorer' }), h('dd', { text: scorerId }),
        h('dt', { text: 'Runs on' }), h('dd', { text: state.settings.scorer === 'lexical' ? 'this browser, no model' : `this machine (${state.settings.model.endpoint})` }),
        h('dt', { text: 'Threshold' }), h('dd', { text: `${pct(threshold())}${state.site.threshold !== undefined ? ' (this site)' : ''}` }),
        h('dt', { text: 'Lens' }), h('dd', { text: `${state.lens.metadata.name} v${state.lens.metadata.lensVersion}` }),
        rule ? h('dt', { text: 'Site rule' }) : null, rule ? h('dd', { text: `${rule.name}: one block per item` }) : null),
      h('h3', { text: 'Never zapped' }),
      h('p', { class: 'note', text: 'Headings, navigation, forms, dialogs, corrections and clarifications, cited primary sources, and anything the scorer returned nothing for.' }),
      state.unsupported.length ? h('h3', { text: 'In your lens but not used here' }) : null,
      state.unsupported.length ? h('ul', {}, state.unsupported.map((u) => h('li', { class: 'note', text: u }))) : null,
      h('p', { class: 'note', text: 'This tool uses your LensPub lens but is not a LensPub engine: unlike one, it hides parts of pages.' })
    );
  }

  // --- Hover popover: score and reason for any block -----------------------------

  let tipFor = null;
  let hoverTimer = null;
  let hoverId = null;

  function hideTip() {
    clearTimeout(hoverTimer);
    if (hoverId && blocks.has(hoverId)) setAttr(blocks.get(hoverId), 'data-lpz-hover', null);
    hoverId = tipFor = null;
    tip.hidden = true;
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
    else if (b.els[0].hasAttribute('data-lpz-scoring')) [verdict, cls] = ['Scoring…', 'muted'];
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
    tip.replaceChildren(...parts);
    tip.hidden = false;
    tipFor = id;
    placeTip(b);
  }

  function placeTip(b) {
    const rects = b.els.map((el) => el.getBoundingClientRect()).filter((r) => r.width || r.height);
    if (!rects.length) return;
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const left = Math.min(...rects.map((r) => r.left));
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const maxX = innerWidth - (ui.collapsed ? 44 : 340) - tw - 8;
    const x = Math.max(8, Math.min(left, maxX));
    let y = bottom + 6;
    if (y + th > innerHeight - 8) y = top - th - 6;
    if (y < 8) y = Math.min(innerHeight - th - 8, Math.max(8, top + 8));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  document.addEventListener('pointerover', (e) => {
    if (state.settings.hoverInfo === false) return;
    const el = e.target instanceof Element ? e.target.closest('[data-lpz-id]') : null;
    const id = el?.getAttribute('data-lpz-id') ?? null;
    if (id === hoverId) return;
    hideTip();
    if (!id || !blocks.has(id)) return;
    hoverId = id;
    setAttr(blocks.get(id), 'data-lpz-hover', '');
    hoverTimer = setTimeout(() => renderTip(id), 250);
  }, true);
  document.documentElement.addEventListener('pointerleave', hideTip);
  addEventListener('scroll', () => { if (tipFor) hideTip(); }, { passive: true, capture: true });

  // Score what the reader scrolls to next.
  let sortTimer = null;
  addEventListener('scroll', () => {
    if (!queue.length || sortTimer) return;
    sortTimer = setTimeout(() => { sortTimer = null; sortQueue(); }, 300);
  }, { passive: true });

  renderHeader();
  renderTabs();
  renderBody();

  // --- Run, and keep up with the page -------------------------------------------

  enqueue(scan());
  apply();

  let timer = null;
  new MutationObserver((mutations) => {
    if (mutations.every((m) => sidebarHost.contains(m.target))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      enqueue(scan());
      apply();
    }, 800);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !(changes.lens || changes.settings)) return;
    const key = () => {
      const m = state.settings.model;
      return JSON.stringify([topics(), state.settings.scorer, m.api, m.endpoint, m.model]);
    };
    const before = key();
    state = await send('get-state', { host });
    if (key() !== before) rescoreAll();
    else {
      apply();
      if (ui.tab !== 'interests') renderBody();
    }
  });
})();
