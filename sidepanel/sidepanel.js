// SPDX-License-Identifier: Apache-2.0
//
// The zapper's controls, in Chrome's side panel. Chrome docks the panel beside
// the page and the page reflows to fit, like any browser sidebar.
//
// The panel follows the active tab. It reads that tab's ledger from the
// content script (content/content.js), which pushes an update after every
// pass, and sends actions back (Show, Before, previews while a slider moves,
// training mode). Everything stored goes through the background worker.
//
// Page text arrives here only as ledger snippets, and is only ever written
// with textContent.

import { isLoopbackEndpoint } from '../core/model-scorer.js';
import { suggest, MIN_EXAMPLES } from '../core/train.js';
import { lensChanges, validateLens, bumpVersion } from '../core/lens-edit.js';

const $ = (id) => document.getElementById(id);
const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });
const pct = (x) => `${Math.round(x * 100)}%`;
const signed = (w) => `${w > 0 ? '+' : ''}${Number(w).toFixed(2)}`;

// ?tab=<id> pins the panel to one tab (used when it is opened as a page, as
// the browser check does); otherwise it follows the active tab.
const pinnedTab = new URLSearchParams(location.search).get('tab');
let tabId = pinnedTab ? Number(pinnedTab) : null;
let page = null; // the active tab's snapshot, or null where the zapper cannot run
let state = null; // lens, drafts, settings, and this site's settings
const ui = { tab: 'ledger', hold: false, dirty: false };

const pageAction = (action, data = {}) =>
  tabId == null
    ? Promise.resolve(null)
    : chrome.tabs.sendMessage(tabId, { type: 'page-action', action, ...data }).catch(() => null);

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'text') el.textContent = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
};
const body = $('body');
const setBody = (...parts) => body.replaceChildren(...parts.flat().filter((p) => p != null && p !== false));

const threshold = () => page?.threshold ?? state.site.threshold ?? state.settings.threshold;
const priorities = () =>
  (state.lens.interpretation.priorities ?? []).map((p) => ({
    topic: p.topic,
    weight: p.topic in state.draftWeights ? state.draftWeights[p.topic] : p.weight
  }));

// --- Following the active tab --------------------------------------------------

async function retarget() {
  if (!pinnedTab) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = t?.id ?? null;
  }
  page = await pageAction('get');
  await reloadState();
  renderAll();
}

async function reloadState() {
  state = await send('get-state', { host: page?.host ?? '' });
}

if (!pinnedTab) {
  chrome.tabs.onActivated.addListener(retarget);
  chrome.tabs.onUpdated.addListener((id, info) => { if (id === tabId && info.status === 'complete') retarget(); });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'page-update' || sender.tab?.id !== tabId) return false;
  const hostChanged = page?.host !== msg.page.host;
  const labelsChanged = JSON.stringify(page?.labelled) !== JSON.stringify(msg.page.labelled);
  page = msg.page;
  if (hostChanged) reloadState().then(renderAll);
  else {
    renderHeader();
    if (ui.tab === 'ledger') renderLedger();
    if (ui.tab === 'train' && labelsChanged) renderTrain();
  }
  return false;
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  await reloadState();
  renderHeader();
  // Tabs with inputs re-render only on request, so typing is never interrupted.
  if (ui.tab === 'ledger') renderLedger();
  if (ui.tab === 'train' && changes.training) renderTrain();
});

// --- Header and tabs -------------------------------------------------------------

function renderHeader() {
  const count = $('count');
  count.replaceChildren();
  if (!page) count.textContent = 'Not running on this page';
  else if (page.paused) count.textContent = 'Paused on this site';
  else {
    count.append(h('strong', { text: String(page.zapped.length) }), ` hidden of ${page.blocks}`);
    if (page.progress.total) count.append(h('span', { class: 'scoring', text: ` · scoring ${page.progress.done}/${page.progress.total}` }));
  }
  const bar = $('progress');
  bar.hidden = !page?.progress.total;
  bar.firstChild.style.width = page?.progress.total ? `${(100 * page.progress.done) / page.progress.total}%` : '0';
  const before = $('before');
  before.disabled = !page || page.train;
  before.textContent = page?.before ? 'After' : 'Before';
  before.setAttribute('aria-pressed', String(!!page?.before));
}
$('before').addEventListener('click', async () => {
  page = (await pageAction('before', { on: !page?.before })) ?? page;
  renderHeader();
});

const TABS = [['ledger', 'Ledger'], ['interests', 'Interests'], ['train', 'Train'], ['lens', 'Lens'], ['settings', 'Settings']];
function renderTabs() {
  $('tabs').replaceChildren(...TABS.map(([key, label]) =>
    h('button', {
      role: 'tab',
      'aria-selected': String(ui.tab === key),
      text: label,
      on: { click: () => { ui.tab = key; renderTabs(); renderBody(); } }
    })));
}

function renderBody() {
  ({ ledger: renderLedger, interests: renderInterests, train: renderTrain, lens: renderLens, settings: renderSettings })[ui.tab]();
}
function renderAll() {
  renderHeader();
  renderTabs();
  renderBody();
}

// --- Ledger ----------------------------------------------------------------------

// While the pointer is over the list it is not rebuilt under it; it catches
// up when the pointer leaves, so a click is never lost to a re-render.
body.addEventListener('pointerenter', () => (ui.hold = true));
body.addEventListener('pointerleave', () => {
  ui.hold = false;
  if (ui.dirty && ui.tab === 'ledger') renderLedger(true);
});

const act = (action, data) => async () => {
  page = (await pageAction(action, data)) ?? page;
  renderHeader();
  renderLedger(true);
};

function renderLedger(force = false) {
  if (ui.tab !== 'ledger') return;
  if (ui.hold && !force) {
    ui.dirty = true;
    return;
  }
  ui.dirty = false;
  if (!page) {
    setBody(h('p', { class: 'note', text: 'The zapper does not run on this page (browser pages, the Web Store, and files are off limits to extensions). Switch to a web page.' }));
    return;
  }
  const parts = [];
  if (page.ledgerFailure) {
    parts.push(h('div', { class: 'error', role: 'alert' },
      'Stopped: the hidden blocks did not match the ledger, so everything was restored. Reload the page to try again.'));
  }
  if (page.modelError) {
    parts.push(h('div', { class: 'warn' }, `Model scorer failed, so nothing more was hidden: ${page.modelError} `,
      h('button', { text: 'Retry', on: { click: act('retry') } })));
  }
  parts.push(h('p', { class: 'note' },
    page.zapped.length
      ? 'Every hidden block is listed here. Show puts it back on this page. Hover any block on the page for its score.'
      : page.paused ? 'The zapper is paused on this site.' : page.progress.total ? 'Scoring… blocks are zapped as answers arrive.' : 'Nothing hidden on this page.'));
  if (page.zapped.length) parts.push(h('div', { class: 'actions' }, h('button', { text: 'Restore all', on: { click: act('restore-all') } })));
  const entry = (d, button) =>
    h('li', { class: 'entry' },
      h('div', { class: 'row' },
        h('span', { class: `score ${d.zap !== false ? 'off' : ''}`, text: pct(d.offLens), title: 'How sure the scorer is that this block is off your lens' }),
        h('div', { class: 'snippet', text: d.snippet, title: 'Scroll to it', on: { click: () => pageAction('show', { id: d.id }) } }),
        button),
      h('div', { class: 'why', text: d.trace }));
  parts.push(h('ul', {}, page.zapped.map((d) =>
    entry(d, h('button', { text: 'Show', 'aria-label': `Show hidden block: ${d.snippet.slice(0, 60)}`, on: { click: act('restore', { id: d.id }) } })))));
  if (page.restored.length) {
    parts.push(h('h3', { text: 'Restored on this page' }));
    parts.push(h('ul', {}, page.restored.map((d) =>
      entry({ ...d, zap: false }, h('button', { text: 'Zap again', on: { click: act('unrestore', { id: d.id }) } })))));
  }
  setBody(parts);
}

// --- Interests: live sliders ---------------------------------------------------

function slider({ label, min, max, step, value, format, onInput, onChange }) {
  const val = h('span', { class: 'val', text: format(value) });
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  input.addEventListener('input', () => { val.textContent = format(Number(input.value)); onInput(Number(input.value)); });
  input.addEventListener('change', () => onChange(Number(input.value)));
  return h('div', { class: 'slider' }, h('label', {}, h('span', { text: label }), val), input);
}

// While a slider moves, the page previews it; when it is let go, the value is
// stored and every open tab follows. The preview is dropped once the stored
// value has had time to arrive.
let endPreviewTimer = null;
const previewOnPage = (values) => {
  clearTimeout(endPreviewTimer);
  pageAction('preview', { values });
};
const settle = () => {
  clearTimeout(endPreviewTimer);
  endPreviewTimer = setTimeout(() => pageAction('end-preview'), 600);
};

function draftCount() {
  return (state.lens.interpretation.priorities ?? []).filter(
    (p) => p.topic in state.draftWeights && state.draftWeights[p.topic] !== p.weight
  ).length;
}

function renderInterests(message) {
  const host = page?.host ?? '';
  const remember = h('input', { type: 'checkbox' });
  remember.checked = state.site.threshold !== undefined;
  remember.disabled = !host;
  remember.addEventListener('change', async () => {
    state.site = (await send('set-site', { host, patch: { threshold: remember.checked ? threshold() : null } })).site;
  });
  const conf = slider({
    label: 'Zap when at least this sure a block is off your lens',
    min: 0.5, max: 0.99, step: 0.01, value: threshold(), format: pct,
    onInput: (v) => previewOnPage({ threshold: v }),
    onChange: async (v) => {
      if (remember.checked) state.site = (await send('set-site', { host, patch: { threshold: v } })).site;
      else state.settings = (await send('set-settings', { patch: { threshold: v } })).settings;
      settle();
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
    await reloadState();
    renderInterests(
      r.error ? `Not saved: ${r.error}`
        : r.unchanged ? 'Nothing to save.'
        : `Saved as v${r.lensVersion} (${r.impact} change).${r.dropped?.length ? ' The signature was removed: this edited copy is now your own lens.' : ''}`
    );
  });
  discardBtn.addEventListener('click', async () => {
    await send('set-draft', { weights: {} });
    state.draftWeights = {};
    renderInterests('Changes discarded.');
  });

  const interestSliders = priorities().map((p) =>
    slider({
      label: p.topic,
      min: -1, max: 1, step: 0.05, value: p.weight,
      format: signed,
      onInput: (v) => {
        state.draftWeights = { ...state.draftWeights, [p.topic]: Math.round(v * 100) / 100 };
        previewOnPage({ draftWeights: state.draftWeights });
        updateStatus();
      },
      onChange: async () => {
        await send('set-draft', { weights: state.draftWeights });
        settle();
      }
    }));
  updateStatus();

  setBody(
    message ? h('div', { class: 'warn', role: 'status', text: message }) : null,
    h('p', { class: 'note', text: 'The page changes while you drag. Nothing is sent to the model again.' }),
    conf,
    h('label', { class: 'check' }, remember, ` Remember this threshold for ${host || 'this site'} only (kept on this device, never in your lens)`),
    h('h3', { text: 'Interests (from your lens)' }),
    h('p', { class: 'note', text: 'Positive: keep blocks about this. Negative: zap blocks about this. Add, rename, or remove interests in the Lens tab.' }),
    interestSliders,
    status,
    h('div', { class: 'actions' }, saveBtn, discardBtn)
  );
}

// --- Train ----------------------------------------------------------------------

async function renderTrain(message) {
  const { examples } = await send('train-get');
  if (ui.tab !== 'train') return;
  const keep = examples.filter((e) => e.label === 'keep').length;
  const zap = examples.length - keep;
  const training = !!page?.train;
  const toggle = h('button', {
    class: `big-toggle ${training ? '' : 'primary'}`,
    'aria-pressed': String(training),
    disabled: !page,
    text: training ? 'Stop training on this page' : 'Start training on this page',
    on: {
      click: async () => {
        page = (await pageAction('train', { on: !training })) ?? page;
        renderHeader();
        renderTrain();
      }
    }
  });

  const parts = [
    message ? h('div', { class: 'ok', role: 'status', text: message }) : null,
    toggle,
    h('p', { class: 'note', text: training
      ? 'Click any block on the page, then choose Keep or Zap. Zapped blocks are shown outlined, so you can mark the ones that should have stayed. Links do not open while training; press Escape to close a choice.'
      : 'Mark blocks the zapper got wrong, or right, and it will suggest a threshold and interest weights that would have decided them your way.' }),
    h('div', { class: 'stats' },
      h('div', {}, h('strong', { text: String(examples.length) }), 'marked'),
      h('div', {}, h('strong', { text: String(keep) }), 'keep'),
      h('div', {}, h('strong', { text: String(zap) }), 'zap')),
    h('p', { class: 'note', text: 'Each mark stores only the scores for that block, never its text or the page it came from, on this device only. Marks made with one scorer may not suit another.' })
  ];

  const s = suggest(examples, priorities(), threshold());
  if (s.needMore) {
    parts.push(h('p', { class: 'note', text: `Mark ${s.needMore} more block${s.needMore === 1 ? '' : 's'} to get a suggestion (at least ${MIN_EXAMPLES}, with some of each).` }));
  } else {
    const tChanged = Math.abs(s.threshold - threshold()) > 0.001;
    const describe = (e) => `${e.wrong} of ${e.total} wrong (${e.falseZaps} hidden that you wanted, ${e.missed} kept that you didn't)`;
    const box = h('div', { class: 'suggest' },
      h('strong', { text: 'Suggestion' }),
      h('p', { class: 'note', text: `Now: ${describe(s.before)}.` }));
    if (!tChanged && s.changes.length === 0) {
      box.append(h('p', { text: 'Your current settings already fit your marks as well as any nearby setting does.' }));
    } else {
      box.append(h('ul', {},
        tChanged ? h('li', {}, `Threshold ${pct(threshold())} `, h('span', { class: 'arrow', text: '→' }), ` ${pct(s.threshold)}`) : null,
        s.changes.map((c) => h('li', {}, `${c.topic} ${signed(c.from)} `, h('span', { class: 'arrow', text: '→' }), ` ${signed(c.to)}`))));
      box.append(h('p', { class: 'note', text: `With these: ${describe(s.after)}.` }));
      box.append(h('div', { class: 'actions' }, h('button', {
        class: 'primary',
        text: 'Try these',
        on: {
          click: async () => {
            if (s.changes.length) {
              const weights = { ...state.draftWeights };
              for (const c of s.changes) weights[c.topic] = c.to;
              await send('set-draft', { weights });
            }
            if (tChanged) {
              if (state.site.threshold !== undefined && page?.host) await send('set-site', { host: page.host, patch: { threshold: s.threshold } });
              else await send('set-settings', { patch: { threshold: s.threshold } });
            }
            await reloadState();
            renderTrain('Applied to your sliders. Check the page, then Save to lens in the Interests tab to keep the weights.');
          }
        }
      })));
    }
    if (s.unmatched) {
      box.append(h('p', { class: 'note', text: `${s.unmatched} block${s.unmatched === 1 ? '' : 's'} you kept matched none of your interests, so no setting can keep ${s.unmatched === 1 ? 'it' : 'them'}. Add an interest that describes ${s.unmatched === 1 ? 'it' : 'them'} in the Lens tab.` }));
    }
    parts.push(box);
  }
  if (examples.length) {
    parts.push(h('div', { class: 'actions' }, h('button', {
      class: 'danger',
      text: 'Clear all marks',
      on: { click: async () => { await send('train-clear'); renderTrain('Marks cleared.'); } }
    })));
  }
  setBody(parts);
}

// --- Lens: edit directly ------------------------------------------------------

let lensDraft = null; // the lens being edited, before Save

function renderLens(message, kind = 'ok') {
  if (!lensDraft) lensDraft = structuredClone(state.lens);
  const prios = lensDraft.interpretation.priorities ?? (lensDraft.interpretation.priorities = []);
  const summary = h('div');
  const errorsBox = h('div', { class: 'status' });

  const refreshSummary = () => {
    const changes = lensChanges(state.lens, lensDraft);
    const errors = validateLens({ ...lensDraft, versionHistory: state.lens.versionHistory, metadata: { ...lensDraft.metadata, lensVersion: state.lens.metadata.lensVersion } });
    const impact = changes.some((c) => c.impact === 'major') ? 'major' : changes.some((c) => c.impact === 'minor') ? 'minor' : 'trivial';
    summary.replaceChildren(changes.length
      ? h('div', {},
          h('p', { class: 'note', text: `${changes.length} change${changes.length === 1 ? '' : 's'}. Saving makes version ${bumpVersion(state.lens.metadata.lensVersion, impact)} (${impact}).` }),
          h('ul', { class: 'changes' }, changes.map((c) => h('li', {},
            c.topic ? `${c.op === 'add' ? 'Add' : c.op === 'remove' ? 'Remove' : 'Change'} “${c.topic}”${c.to !== undefined ? ` (${signed(c.to)})` : ''}` : `${c.op} ${c.path}`,
            h('span', { class: `impact ${c.impact}`, text: c.impact })))))
      : h('p', { class: 'note', text: 'No changes yet.' }));
    errorsBox.replaceChildren(...(errors.length ? [h('div', { class: 'error', text: `Not valid yet: ${errors.slice(0, 3).join(' ')}` })] : []));
    saveBtn.disabled = changes.length === 0 || errors.length > 0;
    discardBtn.disabled = changes.length === 0;
  };

  const saveBtn = h('button', { class: 'primary', text: 'Save new version' });
  const discardBtn = h('button', { text: 'Discard edits' });
  saveBtn.addEventListener('click', () => commit(lensDraft));
  discardBtn.addEventListener('click', () => { lensDraft = null; renderLens(); });

  const rows = h('div');
  const drawRows = () => {
    rows.replaceChildren(...prios.map((p, i) => {
      const topic = h('input', { type: 'text', value: p.topic, 'aria-label': `Interest ${i + 1}` });
      topic.addEventListener('input', () => { p.topic = topic.value.trim(); refreshSummary(); });
      const weight = h('input', { type: 'number', min: '-1', max: '1', step: '0.05', value: String(p.weight), 'aria-label': `Weight for ${p.topic}` });
      weight.addEventListener('input', () => { p.weight = Number(weight.value); refreshSummary(); });
      const del = h('button', { text: '×', title: 'Remove this interest', 'aria-label': `Remove ${p.topic}`, on: { click: () => { prios.splice(i, 1); drawRows(); refreshSummary(); } } });
      return h('div', { class: 'prio' }, topic, weight, del);
    }));
  };
  drawRows();

  const newTopic = h('input', { type: 'text', placeholder: 'New interest, e.g. open data', 'aria-label': 'New interest' });
  const newWeight = h('input', { type: 'number', min: '-1', max: '1', step: '0.05', value: '0.5', 'aria-label': 'Weight for the new interest' });
  const add = () => {
    const t = newTopic.value.trim();
    if (!t || prios.some((p) => p.topic === t)) return;
    prios.push({ topic: t, weight: Math.max(-1, Math.min(1, Number(newWeight.value) || 0)) });
    newTopic.value = '';
    drawRows();
    refreshSummary();
  };
  newTopic.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  const name = h('input', { type: 'text', value: lensDraft.metadata.name ?? '' });
  name.addEventListener('input', () => { lensDraft.metadata.name = name.value; refreshSummary(); });

  const json = h('textarea', { class: 'json', spellcheck: false, 'aria-label': 'Lens as JSON' });
  json.value = JSON.stringify(state.lens, null, 2);
  const jsonStatus = h('div', { class: 'status' });
  const saveJson = h('button', {
    text: 'Save JSON as new version',
    on: {
      click: () => {
        let parsed;
        try {
          parsed = JSON.parse(json.value);
        } catch (err) {
          jsonStatus.replaceChildren(h('div', { class: 'error', text: `Not JSON: ${err.message}` }));
          return;
        }
        commit(parsed);
      }
    }
  });

  const drafts = draftCount();
  setBody(
    message ? h('div', { class: kind, role: 'status', text: message }) : null,
    h('p', { class: 'note', text: `Version ${state.lens.metadata.lensVersion}. Edits here are saved as one new version, numbered by how big the change is. Nothing about the pages you read is ever written into the lens.` }),
    drafts ? h('div', { class: 'warn', text: `You have ${drafts} unsaved slider change${drafts === 1 ? '' : 's'}. Saving here starts from the saved weights and discards them.` }) : null,
    h('label', { class: 'field' }, 'Name', name),
    h('h3', { text: 'Interests' }),
    h('p', { class: 'note', text: 'Weight from −1 (zap blocks about this) to +1 (keep them). Renaming an interest counts as removing it and adding a new one.' }),
    rows,
    h('div', { class: 'prio' }, newTopic, newWeight, h('button', { text: 'Add', on: { click: add } })),
    errorsBox,
    summary,
    h('div', { class: 'actions' }, saveBtn, discardBtn),
    h('details', {},
      h('summary', { text: 'Edit as JSON' }),
      h('p', { class: 'note', text: 'The whole lens. It must validate as a Lens Manifest. The version number, modified date, and version history are set for you.' }),
      json, jsonStatus, h('div', { class: 'actions' }, saveJson)),
    h('h3', { text: 'Import, export, reset' }),
    h('div', { class: 'actions' },
      h('button', { text: 'Import a lens…', on: { click: () => fileInput.click() } }),
      h('button', { text: 'Export lens', on: { click: exportLens } }),
      h('button', { class: 'danger', text: 'Reset to sample lens', on: { click: async () => { await send('reset-lens'); await reloadState(); lensDraft = null; renderLens('Reset to the bundled sample lens.'); } } }))
  );
  refreshSummary();

  async function commit(edited) {
    const r = await send('commit-edit', { manifest: edited });
    await reloadState();
    if (r.error) {
      renderLens(`Not saved: ${r.error}`, 'error');
      return;
    }
    lensDraft = null;
    renderLens(r.unchanged ? 'Nothing changed.' : `Saved as version ${r.lensVersion} (${r.impact} change).${r.dropped?.length ? ' The signature was removed: this edited copy is now your own lens.' : ''}`);
  }
}

const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
document.body.append(fileInput);
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  let manifest;
  try {
    manifest = JSON.parse(await file.text());
  } catch {
    renderLens('That file is not JSON.', 'error');
    return;
  }
  const r = await send('import-lens', { manifest });
  await reloadState();
  lensDraft = null;
  renderLens(r.errors ? `Rejected: not a valid Lens Manifest. ${r.errors.slice(0, 5).join(' ')}` : 'Imported.', r.errors ? 'error' : 'ok');
});

function exportLens() {
  const lens = state.lens;
  const blob = new Blob([JSON.stringify(lens, null, 2) + '\n'], { type: 'application/lens-manifest+json' });
  const a = h('a', {
    href: URL.createObjectURL(blob),
    download: `${(lens.metadata.name || 'lens').replace(/[^\w.-]+/g, '-')}-${lens.metadata.lensVersion}.json`
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Settings -------------------------------------------------------------------

function renderSettings(message) {
  const host = page?.host ?? '';
  const st = state.settings;
  const paused = state.site.paused === true;

  const toggle = (key, label) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = st[key] !== false;
    box.addEventListener('change', async () => { state.settings = (await send('set-settings', { patch: { [key]: box.checked } })).settings; });
    return h('label', { class: 'check' }, box, ` ${label}`);
  };

  const scorer = (value, label) => {
    const r = h('input', { type: 'radio', name: 'scorer', value });
    r.checked = st.scorer === value;
    r.addEventListener('change', async () => {
      state.settings = (await send('set-settings', { patch: { scorer: value } })).settings;
      renderSettings(value === 'model' ? 'Using a model on this machine. Check the connection below.' : 'Using the word-only scorer.');
    });
    return h('label', { class: 'check' }, r, ` ${label}`);
  };

  const api = h('select', {},
    h('option', { value: 'systemone', text: 'Decision model via llama-server (/v1/systemone)' }),
    h('option', { value: 'ollama', text: 'Chat model via Ollama (/api/chat)' }),
    h('option', { value: 'openai', text: 'Chat model via an OpenAI-compatible server' }));
  api.value = st.model.api;
  const endpoint = h('input', { type: 'url', value: st.model.endpoint, placeholder: 'http://127.0.0.1:8080' });
  const model = h('input', { type: 'text', value: st.model.model, placeholder: 'optional for llama-server' });
  const concurrency = h('input', { type: 'number', min: '1', max: '8', step: '1', value: String(st.model.concurrency ?? 4) });
  const status = h('div', { class: 'status', role: 'status' });
  const say = (text, kind = 'ok') => status.replaceChildren(h('div', { class: kind, text }));

  const saveModel = async () => {
    const m = {
      api: api.value,
      endpoint: endpoint.value.trim(),
      model: model.value.trim(),
      concurrency: Math.min(8, Math.max(1, Math.round(Number(concurrency.value)) || 4))
    };
    if (!isLoopbackEndpoint(m.endpoint)) {
      say('Refused: the endpoint must be on this machine (localhost or 127.0.0.1).', 'error');
      return false;
    }
    state.settings = (await send('set-settings', { patch: { model: m } })).settings;
    return true;
  };
  const test = async () => {
    if (!(await saveModel())) return;
    say('Saved. Testing…');
    const r = await send('test-model');
    if (r.error) {
      const hint = api.value !== 'systemone' && /404/.test(r.error)
        ? ' If this is llama-server running a decision model (Kev-4B, Clef-flash), choose the decision-model API.'
        : '';
      say(`Failed: ${r.error}${hint}`, 'error');
      return;
    }
    const [a, b] = r.scores;
    const fmt = (s) => (s.unscored ? 'no answer' : pct(s.matches['school cybersecurity']));
    say(`${r.scorer} answered in ${r.ms} ms. A ransomware story scored ${fmt(a)} for “school cybersecurity”; a football story scored ${fmt(b)}.`);
  };

  setBody(
    message ? h('div', { class: 'ok', role: 'status', text: message }) : null,
    h('h3', { text: host ? `This site: ${host}` : 'This site' }),
    h('div', { class: 'actions' }, h('button', {
      'aria-pressed': String(paused),
      disabled: !host,
      text: paused ? 'Resume on this site' : 'Pause on this site',
      on: { click: async () => { state.site = (await send('set-site', { host, patch: { paused: paused ? null : true } })).site; renderSettings(); } }
    })),
    page ? h('dl', { class: 'kv' },
      h('dt', { text: 'Scorer' }), h('dd', { text: page.scorer }),
      h('dt', { text: 'Threshold' }), h('dd', { text: `${pct(threshold())}${state.site.threshold !== undefined ? ' (this site)' : ''}` }),
      h('dt', { text: 'Lens' }), h('dd', { text: `${state.lens.metadata.name} v${state.lens.metadata.lensVersion}` }),
      page.rule ? h('dt', { text: 'Site rule' }) : null, page.rule ? h('dd', { text: `${page.rule}: one block per item` }) : null) : null,

    h('h3', { text: 'Display' }),
    toggle('hoverInfo', 'Show the score when I hover over a block'),
    toggle('animate', 'Animate scoring and zapping'),

    h('h3', { text: 'Scorer' }),
    h('fieldset', {},
      scorer('lexical', 'Words only (no model; zaps too much on real pages)'),
      scorer('model', 'A model running on this machine')),
    st.scorer === 'model' ? h('div', {},
      h('label', { class: 'field' }, 'API', api),
      h('label', { class: 'field' }, 'Endpoint', endpoint),
      h('label', { class: 'field' }, 'Model', model),
      h('label', { class: 'field' }, 'Requests at once (match llama-server --parallel)', concurrency),
      h('p', { class: 'note', text: 'Only addresses on this machine are accepted, so page text never leaves your device. For a decision model: llama-server -hf ggml-org/Kev-4B-GGUF --port 8080, and leave Model empty.' }),
      h('div', { class: 'actions' },
        h('button', { text: 'Save', on: { click: async () => { if (await saveModel()) say('Saved.'); } } }),
        h('button', { class: 'primary', text: 'Test connection', on: { click: test } })),
      status) : null,

    h('h3', { text: 'Kept on this device only' }),
    h('p', { class: 'note', text: 'Unsaved slider positions, per-site settings, and training marks. None of it is written into your lens or exported.' }),
    h('div', { class: 'actions' }, h('button', {
      class: 'danger',
      text: 'Clear it',
      on: { click: async () => { await send('clear-local-state'); await reloadState(); renderSettings('Cleared.'); } }
    })),
    h('h3', { text: 'Never zapped' }),
    h('p', { class: 'note', text: 'Headings, navigation, forms, dialogs, corrections and clarifications, cited primary sources, and anything the scorer returned nothing for.' }),
    state.unsupported.length ? h('h3', { text: 'In your lens but not used here' }) : null,
    state.unsupported.length ? h('ul', {}, state.unsupported.map((u) => h('li', { class: 'note', text: u }))) : null,
    h('p', { class: 'note', text: 'This tool uses your LensPub lens but is not a LensPub engine: unlike one, it hides parts of pages.' })
  );
}

retarget();
