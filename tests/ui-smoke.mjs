/**
 * 界面冒烟测试：在最小 DOM 桩中逐个渲染所有页面模块，捕获运行时错误。
 * 用法：node tests/ui-smoke.mjs
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom-stub.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(os.tmpdir(), 'craftdeck-ui-smoke-' + process.pid);
process.env.MCL_ROOT = root;
process.env.MCL_PORT = '0';
process.env.MCL_NO_AUTH = '1';

const { doc: document } = installDom();

const errors = [];
process.on('unhandledRejection', (e) => { errors.push('unhandledRejection: ' + (e && e.message || e)); });

const { startServer } = await import('../server/server.mjs');
const { server, url } = await startServer(0);
console.log('server:', url, 'root:', root);

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = typeof input === 'string' && input.startsWith('/') ? url + input : input;
  return realFetch(u, init);
};
globalThis.window.fetch = globalThis.fetch;

const pages = ['instances', 'versions', 'modpacks', 'mods', 'resources', 'translation', 'servers', 'terracotta', 'hosts', 'accounts', 'skins', 'logs', 'settings'];
let fail = 0;
for (const name of pages) {
  const view = document.createElement('div');
  document.body.append(view);
  const errsBefore = errors.length;
  const ctx = { route: name, param: null, refresh: () => {} };
  const t0 = Date.now();
  try {
    const mod = await import(`../web/js/pages/${name}.js`);
    const page = mod.default;
    if (!page || typeof page.render !== 'function') throw new Error('缺少 render()');
    await page.render(view, ctx);
    await new Promise((r) => setTimeout(r, name === 'translation' ? 12000 : 2500));
    const count = view.querySelectorAll('*').length;
    if (count === 0) throw new Error('页面没有渲染任何元素');
    if (name === 'versions') {
      if (view.querySelectorAll('.major-card').length < 4) throw new Error('版本页没有渲染大版本卡片');
      const card = view.querySelector('.major-card');
      card.click();
      await new Promise((r) => setTimeout(r, 80));
      const modal = document.querySelector('#modal-root .modal');
      if (!modal || !modal.querySelector('.minor-grid')) throw new Error('点击大版本后没有弹出小版本列表');
      modal.querySelector('.icon-btn')?.click();
    }
    if (name === 'settings') {
      const tabs = view.querySelectorAll('.settings-menu button');
      if (tabs.length < 6) throw new Error('设置页缺少分类导航');
      const guideTab = tabs.find((b) => b.textContent.includes('使用说明'));
      if (!guideTab) throw new Error('设置页缺少使用说明分类');
      guideTab.click();
      await new Promise((r) => setTimeout(r, 80));
      if (!view.querySelector('.guide-step')) throw new Error('使用说明分类没有内容');
    }
    if (typeof page.destroy === 'function') page.destroy();
    const newErrs = errors.slice(errsBefore);
    console.log(`[${newErrs.length ? 'WARN' : ' OK '}] ${name.padEnd(12)} ${String(count).padStart(4)} nodes, ${Date.now() - t0} ms`);
    for (const e of newErrs) console.log('        ' + e);
    if (newErrs.some((e) => !/Not implemented|not a function/.test(e))) fail++;
  } catch (e) {
    fail++;
    console.log(`[FAIL] ${name}: ${e.message}`);
    console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  }
}

server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n${fail} 个页面存在问题` : '\n全部页面渲染通过');
process.exit(fail ? 1 : 0);
