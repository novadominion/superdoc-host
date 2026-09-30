import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replace('import.meta.env.VITE_ALLOWED_PARENT_ORIGINS', '""');
function harness() {
  const messages = [], configs = [], fetches = [], modes = [];
  let listener;
  const element = { classList: { add() {}, remove() {} }, replaceChildren() {}, children: [] };
  class SuperDoc {
    constructor(config) { configs.push(config); queueMicrotask(config.onReady); }
    setDocumentMode(mode) { modes.push(mode); }
    export() { return Promise.resolve(new Blob(['saved'])); }
    destroy() {}
  }
  vm.runInNewContext(source, { SuperDoc, File, Blob, console, queueMicrotask,
    document: { getElementById: () => element },
    window: { parent: { postMessage: (data) => messages.push(data) }, addEventListener: (_, fn) => { listener = fn; } },
    fetch: async (url, options) => { fetches.push({ url, options }); return { ok: true, blob: async () => new Blob(['doc']) }; },
  });
  return { messages, configs, fetches, modes, send: async data => {
    listener({ origin: 'http://localhost:3000', data });
    await new Promise(resolve => setImmediate(resolve));
  } };
}
test('viewing configures viewer permission and tracked-change visibility and denies save or escalation', async () => {
  const h = harness();
  await h.send({ type: 'superdoc-host:load', docUrl: 'https://r2.test/doc', saveUrl: 'https://r2.test/write', mode: 'viewing' });
  assert.equal(h.configs[0].role, 'viewer');
  assert.equal(h.configs[0].trackChanges.visible, true);
  assert.equal(h.messages.find(x => x.type === 'superdoc-host:loaded').readOnlyReview, true);
  await h.send({ type: 'superdoc-host:save' });
  await h.send({ type: 'superdoc-host:set-mode', mode: 'editing' });
  assert.equal(h.fetches.length, 1);
  assert.equal(h.modes.length, 0);
});
test('ordinary suggesting retains editor save behavior without review acknowledgement', async () => {
  const h = harness();
  await h.send({ type: 'superdoc-host:load', docUrl: 'https://r2.test/doc', saveUrl: 'https://r2.test/write', mode: 'suggesting' });
  assert.equal(h.configs[0].role, 'editor');
  assert.notEqual(h.messages.find(x => x.type === 'superdoc-host:loaded').readOnlyReview, true);
  await h.send({ type: 'superdoc-host:save' });
  assert.equal(h.fetches[1].options.method, 'PUT');
  assert.equal(h.fetches[1].url, 'https://r2.test/write');
  assert.ok(h.messages.some(x => x.type === 'superdoc-host:saved'));
});
