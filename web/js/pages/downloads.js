/* ================= 下载中心（版本 / 整合包 / 模组 / 材质光影 / 汉化） ================= */
import { h, sectionTitle, badge, toastOk, toastErr } from '../ui.js';
import { state, api } from '../state.js';
import { icon } from '../icons.js';

let view = null;
let ctxRef = null;
let tab = 'versions';
let current = null;
let host = null;
let pendingQuery = '';
let pendingResourceQuery = '';

const TABS = [
  { key: 'versions', label: '游戏版本', iconSvg: icon('cube', 14), load: () => import('./versions.js') },
  { key: 'modpacks', label: '整合包', iconSvg: icon('package', 14), load: () => import('./modpacks.js') },
  { key: 'mods', label: '模组', iconSvg: icon('puzzle', 14), load: () => import('./mods.js') },
  { key: 'resources', label: '材质与光影', iconSvg: icon('palette', 14), load: () => import('./resources.js') },
  { key: 'translation', label: '汉化', iconSvg: icon('translate', 14), load: () => import('./translation.js') },
  { key: 'maps', label: '地图', iconSvg: icon('map', 14), load: () => import('./extras.js') },
  { key: 'schematics', label: '投影', iconSvg: icon('blueprint', 14), load: () => import('./extras.js') },
  { key: 'sources', label: '资源站', iconSvg: icon('globe', 14), load: () => import('./extras.js') },
];

function visibleTabs() {
  const hidden = new Set(Array.isArray(state.settings.hiddenTabs) ? state.settings.hiddenTabs : []);
  return TABS.filter((t) => !hidden.has(t.key));
}

function switchTab(key) {
  if (tab === key) return;
  tab = key;
  mount();
}

async function mount() {
  if (!host) return;
  if (current?.default?.destroy) {
    try { current.default.destroy(); } catch { /* ignore */ }
  }
  host.innerHTML = '';
  try {
    const tabsNow = visibleTabs();
    if (!tabsNow.some((t) => t.key === tab)) tab = 'versions';
    current = await tabsNow.find((t) => t.key === tab).load();
    const param = tab === 'mods' ? (pendingQuery || null) : tab === 'resources' ? (pendingResourceQuery || null) : null;
    await current.default.render(host, { route: tab, param, refresh: () => mount() });
    if (pendingQuery) { pendingQuery = ''; sessionStorage.removeItem('craftdeck.modquery'); }
    if (pendingResourceQuery) { pendingResourceQuery = ''; sessionStorage.removeItem('craftdeck.resourceQuery'); }
  } catch (e) {
    host.replaceChildren(h('div', { class: 'callout err' }, '页面加载失败：' + e.message));
  }
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    const want = sessionStorage.getItem('craftdeck.downloadTab');
    if (want && visibleTabs().some((t) => t.key === want)) tab = want;
    if (!visibleTabs().some((t) => t.key === tab)) tab = 'versions';
    sessionStorage.removeItem('craftdeck.downloadTab');
    pendingQuery = sessionStorage.getItem('craftdeck.modquery') || '';
    pendingResourceQuery = sessionStorage.getItem('craftdeck.resourceQuery') || '';
    view.innerHTML = '';
    const tabs = h('div', { class: 'tabs', id: 'download-tabs' }, visibleTabs().map((t) => h('button', {
      class: `tab ${tab === t.key ? 'active' : ''}`, dataset: { key: t.key },
      onclick: () => {
        if (tab === t.key) return;
        const apply = async () => {
          tab = t.key;
          for (const b of tabs.children) b.classList.toggle('active', b.dataset.key === tab);
          await mount();
        };
        if (typeof document.startViewTransition === 'function') document.startViewTransition(apply);
        else apply();
      },
    }, [
      t.iconSvg ? h('span', { class: 'tab-ico', html: t.iconSvg }) : t.icon,
      ` ${t.label}`,
    ])));
    host = h('div', { class: 'download-host' });
    view.append(h('div', { class: 'home' }, [
      h('div', { class: 'panel', style: { padding: '12px 14px' } }, [
        h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, [
          h('div', { class: 'panel-title' }, '下载中心'),
          h('div', { class: 'row' }, [
            badge('版本 · 整合包 · 模组 · 光影 · 汉化', 'accent'),
            h('button', {
              class: 'btn btn-sm', html: `${icon('undo', 14)}<span>还原</span>`,
              onclick: async () => {
                pendingQuery = ''; pendingResourceQuery = '';
                sessionStorage.removeItem('craftdeck.modquery');
                sessionStorage.removeItem('craftdeck.resourceQuery');
                await mount();
                toastOk('已还原', '已清除下载页搜索条件');
              },
            }),
            h('button', {
              class: 'btn btn-sm', id: 'download-refresh', html: `${icon('refresh', 14)}<span>刷新</span>`,
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true; btn.innerHTML = `${icon('refresh', 14)}<span>刷新中…</span>`;
                try {
                  await api('/api/versions/manifest/refresh', { method: 'POST', body: {} });
                  await mount();
                  toastOk('已刷新', '版本清单与下载页面已更新');
                } catch (err) {
                  toastErr('刷新失败', err.message);
                } finally {
                  btn.disabled = false; btn.innerHTML = `${icon('refresh', 14)}<span>刷新</span>`;
                }
              },
            }),
          ]),
        ]),
        h('div', { class: 'hint', style: { marginTop: '4px' } }, '所有下载都在这儿；装完版本会自动建好启动项，不用再手动折腾实例。'),
        h('div', { style: { marginTop: '10px' } }, tabs),
      ]),
      host,
    ]));
    await mount();
  },
  destroy() {
    if (current?.default?.destroy) { try { current.default.destroy(); } catch { /* ignore */ } }
    current = null; host = null; view = null; ctxRef = null;
  },
};
