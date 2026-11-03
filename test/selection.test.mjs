import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replace('import.meta.env.VITE_ALLOWED_PARENT_ORIGINS', '""');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function harness() {
  const messages = [];
  let listener, editor;
  const element = { classList: { add() {}, remove() {} }, replaceChildren() {}, children: [], dataset: {} };
  // A stand-in for SuperDoc's inner editor: a selection over a fixed body text.
  const body = 'The Defendant breached the agreement on March 3.';
  function makeEditor() {
    const handlers = {};
    const ed = {
      state: { selection: { from: 0, to: 0, empty: true }, doc: { textBetween: (from, to) => body.slice(from, to) } },
      on: (name, fn) => { handlers[name] = fn; },
      select(from, to) { ed.state.selection = { from, to, empty: from === to }; handlers.selectionUpdate?.({ editor: ed }); },
    };
    return ed;
  }
  class SuperDoc {
    constructor(config) { editor = makeEditor(); config.onEditorCreate?.({ editor }); queueMicrotask(config.onReady); }
    destroy() {}
  }
  vm.runInNewContext(source, { SuperDoc, File, Blob, console, queueMicrotask, setTimeout, clearTimeout,
    document: { getElementById: () => element },
    window: { parent: { postMessage: (data, origin) => messages.push({ data, origin }) }, addEventListener: (_, fn) => { listener = fn; } },
    fetch: async () => ({ ok: true, blob: async () => new Blob(['doc']) }),
  });
  return {
    messages, get editor() { return editor; },
    selections: () => messages.filter((m) => m.data.type === 'superdoc-host:selection'),
    load: async () => {
      listener({ origin: 'http://localhost:3000', data: { type: 'superdoc-host:load', docUrl: 'https://r2.test/doc' } });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
test('a selection reaches only the loading parent, debounced, and clears when it collapses', async () => {
  const h = harness();
  await h.load();
  h.editor.select(4, 6);
  h.editor.select(4, 13);
  h.editor.select(4, 22);
  assert.equal(h.selections().length, 0, 'nothing is sent while the selection is still moving');
  await wait(200);
  assert.deepEqual(h.selections().map((m) => [m.data.text, m.origin]), [['Defendant breached', 'http://localhost:3000']]);
  h.editor.select(4, 22);
  await wait(200);
  assert.equal(h.selections().length, 1, 'an unchanged selection is not re-sent');
  h.editor.select(10, 10);
  await wait(200);
  assert.equal(h.selections().at(-1).data.text, '');
});
test('loading another document clears a selection the parent was showing', async () => {
  const h = harness();
  await h.load();
  h.editor.select(0, 3);
  await wait(200);
  await h.load();
  assert.equal(h.selections().at(-1).data.text, '');
});
