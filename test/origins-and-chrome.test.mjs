import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replace('import.meta.env.VITE_ALLOWED_PARENT_ORIGINS', '""');
function harness({ referrer = '' } = {}) {
  const posts = [], configs = [];
  let listener;
  const element = { classList: { add() {}, remove() {} }, replaceChildren() {}, children: [], dataset: {} };
  class SuperDoc {
    constructor(config) { configs.push(config); queueMicrotask(config.onReady); }
    destroy() {}
  }
  vm.runInNewContext(source, { SuperDoc, File, Blob, URL, console, queueMicrotask,
    document: { getElementById: () => element, referrer },
    window: { location: {}, parent: { postMessage: (data, origin) => posts.push({ data, origin }) }, addEventListener: (_, fn) => { listener = fn; } },
    fetch: async () => ({ ok: true, blob: async () => new Blob(['doc']) }),
  });
  return { posts, configs, element, send: async (origin, data) => {
    listener({ origin, data });
    await new Promise(resolve => setImmediate(resolve));
  } };
}
const PREVIEW = 'https://deal-oracle-web-git-codex-lab-studio-foundation-novadominion.vercel.app';
const load = { type: 'superdoc-host:load', docUrl: 'https://r2.test/doc', mode: 'viewing' };

test('a deal-oracle-web preview may drive the host; other origins may not', async () => {
  for (const origin of [PREVIEW, 'https://deal-oracle-web-a1b2c3d4e-novadominion.vercel.app']) {
    const h = harness();
    await h.send(origin, load);
    assert.equal(h.configs.length, 1, origin);
    assert.ok(h.posts.some(p => p.data.type === 'superdoc-host:loaded' && p.origin === origin), origin);
  }
  for (const origin of ['https://evil.example', 'https://deal-oracle-web-git-x-novadominion.vercel.app.evil.example', 'http://deal-oracle-web-git-x-novadominion.vercel.app', 'https://other-app-git-x-novadominion.vercel.app']) {
    const h = harness();
    await h.send(origin, load);
    assert.equal(h.configs.length, 0, origin);
  }
});

test('ready reaches an allowed preview parent named by the referrer, and nobody else extra', () => {
  const allowed = harness({ referrer: `${PREVIEW}/lab?design=a` });
  assert.ok(allowed.posts.some(p => p.data.type === 'superdoc-host:ready' && p.origin === PREVIEW));
  const foreign = harness({ referrer: 'https://evil.example/page' });
  assert.ok(!foreign.posts.some(p => p.origin === 'https://evil.example'));
});

test('chrome "page" mounts no toolbar and marks the frame; the default keeps the toolbar', async () => {
  const page = harness();
  await page.send('http://localhost:3000', { ...load, chrome: 'page' });
  assert.equal('toolbar' in page.configs[0], false);
  assert.equal(page.element.dataset.chrome, 'page');
  const plain = harness();
  await plain.send('http://localhost:3000', load);
  assert.equal(plain.configs[0].toolbar, '#toolbar');
  assert.equal(plain.element.dataset.chrome, '');
});
