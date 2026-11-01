// SPDX-License-Identifier: Apache-2.0
//
// Content script for the LensPub Zapper.
//
// NOT A LENSPUB ENGINE. A conforming Lens Engine never hides content by
// default (spec/lenspub-protocol.md Section 7.3). This tool does exactly that,
// on purpose; see docs/explorations/semantic-zapper.md Section 5 for why it is
// a separate tool and which LensPub rules it keeps anyway. On every page it:
//   1. splits the page into blocks (paragraphs, list items, cards, sidebars);
//   2. scores each block against the reader's interest topics, with the
//      lexical scorer or a model on this machine;
//   3. hides blocks it is confident are off-lens, by attribute + stylesheet,
//      never by removing or rewriting nodes;
//   4. lists every hidden block in a ledger with its reasoning, and checks
//      after every pass that what is hidden equals what the ledger lists;
//   5. never hides page controls, corrections, or primary sources, or anything
//      the scorer returned nothing for.
//
// Page text is only ever written into the panel with textContent.

(async () => {
  if (window.top !== window) return;

  const url = (p) => chrome.runtime.getURL(p);
  const [{ decide, checkLedger }, { scoreLexical, LEXICAL_SCORER_ID }] = await Promise.all([
    import(url('core/decide.js')),
    import(url('core/lexical-scorer.js'))
  ]);
  const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
  const host = location.hostname;

  let state = await send('get-state', { host });
  if (!state || state.error) return;

  // --- Page model ----------------------------------------------------------

  const blocks = new Map(); // id → { el, text }
  const scores = new Map(); // id → scorer output
  const restored = new Set(); // ids restored on this page (never persisted)
  let decisions = [];
  let scorerId = state.settings.scorer === 'lexical' ? LEXICAL_SCORER_ID : 'model (not yet run)';
  let pending = 0;
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

  // --- Segmentation ----------------------------------------------------------

  const MIN_CHARS = 40;
  const MAX_CONTAINER_CHARS = 1200;
  const LEAFY = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'DD', 'TD', 'FIGCAPTION']);
  const CONTAINER = new Set(['ARTICLE', 'SECTION', 'ASIDE', 'DIV', 'TR', 'FIGURE', 'UL', 'OL']);
  // Never zapped and never descended into: page controls and chrome.
  const STRUCTURAL = [
    'nav', 'header', 'footer', 'form', 'dialog', 'menu', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'video', 'audio', 'iframe',
    'input', 'textarea', 'select', 'button', '[role="dialog"]', '[role="alertdialog"]',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
    '[role="menu"]', '[aria-modal="true"]', '[contenteditable="true"]'
  ].join(',');
  // A container holding one of these is split into its parts instead.
  const SPLIT_IF_CONTAINS = 'h1, form, input, textarea, select, dialog, [role="dialog"], nav, [data-lpz-id]';

  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  function hasSeveralItems(el) {
    let n = 0;
    for (const c of el.children) if (norm(c.textContent).length >= MIN_CHARS && ++n >= 2) return true;
    return false;
  }

  /** Find new blocks; returns their ids. Blocks already registered are kept. */
  function scan() {
    for (const [id, b] of blocks) {
      if (!b.el.isConnected) {
        blocks.delete(id);
        scores.delete(id);
        restored.delete(id);
      }
    }
    const added = [];
    (function walk(el) {
      for (const child of el.children) {
        if (child === panelHost || child.hasAttribute('data-lpz-id')) continue;
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
        if (selectable) {
          const id = `b${nextId++}`;
          child.setAttribute('data-lpz-id', id);
          blocks.set(id, { el: child, text });
          added.push(id);
        } else {
          walk(child);
        }
      }
    })(document.body);
    return added;
  }

  // --- Scoring -----------------------------------------------------------------

  async function score(ids) {
    if (ids.length === 0) return;
    const batch = ids.filter((id) => blocks.has(id)).map((id) => ({ id, text: blocks.get(id).text }));
    if (state.settings.scorer === 'lexical') {
      scorerId = LEXICAL_SCORER_ID;
      for (const s of scoreLexical(batch, topics())) scores.set(s.id, s);
      return;
    }
    pending += batch.length;
    renderHeader();
    try {
      const res = await send('score-model', { blocks: batch, topics: topics() });
      if (res?.error) throw new Error(res.error);
      scorerId = res.scorer;
      modelError = null;
      for (const s of res.scores) if (s) scores.set(s.id, s);
    } catch (err) {
      // Blocks without scores are never zapped: a failed model hides nothing.
      modelError = String(err?.message ?? err);
    } finally {
      pending -= batch.length;
    }
  }

  // --- Applying decisions and the ledger check -------------------------------

  function apply() {
    const scored = [...blocks.keys()].filter((id) => scores.has(id)).map((id) => scores.get(id));
    decisions = paused() || ledgerFailure
      ? []
      : decide({ scores: scored, priorities: priorities(), threshold: threshold(), scorer: scorerId, restored });
    const zap = new Set(decisions.filter((d) => d.zap).map((d) => d.id));
    for (const [id, b] of blocks) b.el.toggleAttribute('data-lpz-zapped', zap.has(id));

    const hidden = [...document.querySelectorAll('[data-lpz-zapped]')].map((el) => el.getAttribute('data-lpz-id'));
    const check = checkLedger(hidden, zap);
    if (!check.ok) {
      ledgerFailure = check;
      document.querySelectorAll('[data-lpz-zapped]').forEach((el) => el.removeAttribute('data-lpz-zapped'));
      decisions = [];
    }
    renderHeader();
    renderLedger();
  }

  // --- Panel -------------------------------------------------------------------

  const panelHost = document.createElement('lenspub-zapper');
  const shadow = panelHost.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(await (await fetch(url('content/panel.css'))).text());
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    /* unstyled panel still works */
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

  const ui = { tab: 'ledger', collapsed: false, before: false, flash: null };
  const panel = h('div', { class: 'panel', role: 'complementary', 'aria-label': 'LensPub Zapper' });
  const header = h('header');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { class: 'body' });
  panel.append(header, tabs, body);
  shadow.append(panel);
  document.documentElement.append(panelHost);

  function renderHeader() {
    const zapped = decisions.filter((d) => d.zap).length;
    const count = h('span', { class: 'count', 'aria-live': 'polite' });
    if (paused()) count.textContent = 'Paused on this site';
    else if (pending) count.textContent = `Scoring ${pending} blocks…`;
    else count.append(h('strong', { text: String(zapped) }), ` hidden of ${blocks.size}`);
    header.replaceChildren(
      h('span', { class: 'title', text: 'Zapper' }),
      count,
      h('button', {
        'aria-pressed': String(ui.before),
        title: 'Show the page as published, with zapped blocks outlined',
        text: ui.before ? 'After' : 'Before',
        on: {
          click: () => {
            ui.before = !ui.before;
            document.documentElement.classList.toggle('lpz-before', ui.before);
            renderHeader();
          }
        }
      }),
      h('button', {
        'aria-expanded': String(!ui.collapsed),
        'aria-label': ui.collapsed ? 'Expand panel' : 'Collapse panel',
        text: ui.collapsed ? '▴' : '▾',
        on: {
          click: () => {
            ui.collapsed = !ui.collapsed;
            panel.classList.toggle('collapsed', ui.collapsed);
            renderHeader();
          }
        }
      })
    );
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
    if (ui.tab === 'ledger') renderLedger();
    else if (ui.tab === 'interests') renderInterests();
    else renderSite();
  }

  const snippet = (id) => {
    const t = blocks.get(id)?.text ?? '';
    return t.length > 140 ? `${t.slice(0, 140)}…` : t;
  };

  function showBlock(id) {
    const el = blocks.get(id)?.el;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.setAttribute('data-lpz-flash', '');
    setTimeout(() => el.removeAttribute('data-lpz-flash'), 1600);
  }

  function renderLedger() {
    if (ui.tab !== 'ledger') return;
    const parts = [];
    if (ledgerFailure) {
      parts.push(h('div', { class: 'error', role: 'alert' },
        'Stopped: the hidden blocks did not match the ledger, so everything was restored. Reload the page to try again.'));
    }
    if (modelError) {
      parts.push(h('div', { class: 'warn' }, `Model scorer failed, so nothing new was hidden: ${modelError}`));
    }
    const zapped = decisions.filter((d) => d.zap);
    const back = decisions.filter((d) => d.exempt === 'restored');
    parts.push(h('p', { class: 'note' },
      zapped.length
        ? 'Every hidden block is listed here. Show puts it back on this page.'
        : paused() ? 'The zapper is paused on this site.' : 'Nothing hidden on this page.'));
    if (zapped.length) {
      parts.push(h('div', { class: 'actions' },
        h('button', {
          text: 'Restore all',
          on: { click: () => { zapped.forEach((d) => restored.add(d.id)); apply(); } }
        })));
    }
    parts.push(h('ul', {}, zapped.map((d) =>
      h('li', { class: 'entry' },
        h('div', { class: 'row' },
          h('div', { class: 'snippet', text: snippet(d.id) }),
          h('button', {
            text: 'Show',
            'aria-label': `Show hidden block: ${snippet(d.id).slice(0, 60)}`,
            on: { click: () => { restored.add(d.id); apply(); showBlock(d.id); } }
          })),
        h('div', { class: 'why', text: d.trace })))));
    if (back.length) {
      parts.push(h('h3', { text: 'Restored on this page' }));
      parts.push(h('ul', {}, back.map((d) =>
        h('li', { class: 'entry' },
          h('div', { class: 'row' },
            h('div', { class: 'snippet', text: snippet(d.id) }),
            h('button', { text: 'Zap again', on: { click: () => { restored.delete(d.id); apply(); } } })),
          h('div', { class: 'why', text: d.trace })))));
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
    const pct = (x) => `${Math.round(x * 100)}%`;
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
      h('h3', { text: 'How this page was judged' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Scorer' }), h('dd', { text: scorerId }),
        h('dt', { text: 'Runs on' }), h('dd', { text: state.settings.scorer === 'lexical' ? 'this browser, no model' : `this machine (${state.settings.model.endpoint})` }),
        h('dt', { text: 'Threshold' }), h('dd', { text: `${Math.round(threshold() * 100)}%${state.site.threshold !== undefined ? ' (this site)' : ''}` }),
        h('dt', { text: 'Lens' }), h('dd', { text: `${state.lens.metadata.name} v${state.lens.metadata.lensVersion}` })),
      h('h3', { text: 'Never zapped' }),
      h('p', { class: 'note', text: 'Headings, navigation, forms, dialogs, corrections and clarifications, cited primary sources, and anything the scorer returned nothing for.' }),
      state.unsupported.length ? h('h3', { text: 'In your lens but not used here' }) : null,
      state.unsupported.length ? h('ul', {}, state.unsupported.map((u) => h('li', { class: 'note', text: u }))) : null,
      h('p', { class: 'note', text: 'This tool uses your LensPub lens but is not a LensPub engine: unlike one, it hides parts of pages.' })
    );
  }

  renderHeader();
  renderTabs();
  renderBody();

  // --- Run, and keep up with the page -------------------------------------------

  async function rescoreAll() {
    scores.clear();
    await score([...blocks.keys()]);
    apply();
    renderBody();
  }

  await score(scan());
  apply();

  let timer = null;
  new MutationObserver((mutations) => {
    if (mutations.every((m) => panelHost.contains(m.target))) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const added = scan();
      if (added.length) await score(added);
      apply();
    }, 800);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !(changes.lens || changes.settings)) return;
    const before = JSON.stringify([topics(), state.settings.scorer, state.settings.model]);
    state = await send('get-state', { host });
    if (JSON.stringify([topics(), state.settings.scorer, state.settings.model]) !== before) await rescoreAll();
    else { apply(); renderBody(); }
  });
})();
