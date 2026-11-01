// SPDX-License-Identifier: Apache-2.0
//
// Settings page: import and export the lens, choose a scorer, and clear the
// state the zapper keeps on this device.

import { isLoopbackEndpoint } from '../core/model-scorer.js';

const $ = (id) => document.getElementById(id);
const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });

async function refresh() {
  const st = await send('get-state', { host: '' });
  const m = st.lens.metadata;
  $('lens-summary').textContent = `“${m.name}”, version ${m.lensVersion}, with ${st.lens.interpretation.priorities?.length ?? 0} interest topics.`;
  $('unsupported').replaceChildren(
    ...st.unsupported.map((u) => Object.assign(document.createElement('li'), { textContent: `Read but not used here: ${u}` }))
  );
  for (const r of document.querySelectorAll('input[name="scorer"]')) r.checked = r.value === st.settings.scorer;
  $('api').value = st.settings.model.api;
  $('endpoint').value = st.settings.model.endpoint;
  $('model').value = st.settings.model.model;
  $('concurrency').value = String(st.settings.model.concurrency ?? 4);
  $('model-settings').hidden = st.settings.scorer !== 'model';

  const local = await chrome.storage.local.get(['draftWeights', 'sites']);
  const drafts = Object.keys(local.draftWeights ?? {}).length;
  const sites = Object.keys(local.sites ?? {}).length;
  $('local-summary').textContent = `${drafts} unsaved interest change${drafts === 1 ? '' : 's'}; settings for ${sites} site${sites === 1 ? '' : 's'}.`;
}

$('import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  let manifest;
  try {
    manifest = JSON.parse(await file.text());
  } catch {
    $('lens-status').textContent = 'That file is not JSON.';
    return;
  }
  const r = await send('import-lens', { manifest });
  $('lens-status').textContent = r.errors
    ? `Rejected: not a valid Lens Manifest. ${r.errors.slice(0, 5).join(' ')}`
    : 'Imported.';
  e.target.value = '';
  refresh();
});

$('export').addEventListener('click', async () => {
  const { lens } = await send('get-state', { host: '' });
  const blob = new Blob([JSON.stringify(lens, null, 2) + '\n'], { type: 'application/lens-manifest+json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `${(lens.metadata.name || 'lens').replace(/[^\w.-]+/g, '-')}-${lens.metadata.lensVersion}.json`
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('reset').addEventListener('click', async () => {
  await send('reset-lens');
  $('lens-status').textContent = 'Reset to the bundled sample lens.';
  refresh();
});

for (const r of document.querySelectorAll('input[name="scorer"]')) {
  r.addEventListener('change', async () => {
    await send('set-settings', { patch: { scorer: r.value } });
    $('scorer-status').textContent = r.value === 'model' ? 'Using a local model. Save and test the connection below.' : 'Using the word-only scorer.';
    refresh();
  });
}

async function saveModel() {
  const model = {
    api: $('api').value,
    endpoint: $('endpoint').value.trim(),
    model: $('model').value.trim(),
    concurrency: Math.min(8, Math.max(1, Math.round(Number($('concurrency').value)) || 4))
  };
  if (!isLoopbackEndpoint(model.endpoint)) {
    $('scorer-status').textContent = 'Refused: the endpoint must be on this machine (localhost or 127.0.0.1).';
    return false;
  }
  await send('set-settings', { patch: { model } });
  return true;
}

$('save-model').addEventListener('click', async () => {
  if (await saveModel()) $('scorer-status').textContent = 'Saved.';
});

// Test what is on screen, not what was last saved: saving first means the
// test and the zapper always use the same settings.
$('test-model').addEventListener('click', async () => {
  if (!(await saveModel())) return;
  $('scorer-status').textContent = 'Saved. Testing…';
  const r = await send('test-model');
  if (r.error) {
    const hint =
      $('api').value !== 'systemone' && /404/.test(r.error)
        ? ' If this is llama-server running a decision model (Kev-4B, Clef-flash), choose the “Decision model via llama-server” API.'
        : '';
    $('scorer-status').textContent = `Failed: ${r.error}${hint}`;
    return;
  }
  const [a, b] = r.scores;
  const fmt = (s) => (s.unscored ? 'no answer' : `${Math.round(s.matches['school cybersecurity'] * 100)}%`);
  $('scorer-status').textContent =
    `${r.scorer} answered in ${r.ms} ms. A ransomware story scored ${fmt(a)} for “school cybersecurity”; a football story scored ${fmt(b)}.`;
});

$('clear-local').addEventListener('click', async () => {
  await send('clear-local-state');
  refresh();
});

refresh();
