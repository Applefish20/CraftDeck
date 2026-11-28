/* ================= 材质与光影页 ================= */
import {
  h, toast, toastOk, toastErr, badge, emptyState, iconImg, fmtNum, modal, loadingBlock, skeletonCards, cleanMotd,
} from '../ui.js';
import { state, api } from '../state.js';
import { icon } from '../icons.js';

let view = null;
let ctxRef = null;
let kind = 'resourcepack'; // resourcepack | shader
let query = '';
let gameVersion = '';
let results = null;
let loading = false;
let error = null;
let requestId = 0;
let offset = 0;
let total = 0;
const PAGE = 24;

function targetInstance() {
  return state.instances.find((i) => i.id === state.settings.lastInstanceId) || state.instances[0] || null;
}

async function search(reset = true) {
  if (reset) offset = 0;
  loading = true; error = null;
  const rid = ++requestId;
  renderList();
  try {
    const params = new URLSearchParams({ query, type: kind, limit: String(PAGE), offset: String(offset), index: 'downloads' });
    if (gameVersion) params.set('gameVersion', gameVersion);
    const r = await api('/api/mods/search?' + params.toString());
    if (rid === requestId) { results = r; total = r.total_hits || 0; }
  } catch (e) {
    if (rid === requestId) { error = e.message; results = null; }
  }
  loading = false;
  if (rid === requestId) renderList();
}

function card(hit) {
  const isShader = kind === 'shader';
  return h('div', { class: 'mod-card' }, [
    iconImg(hit.icon_url, isShader ? '☀' : '▧'),
    h('div', { class: 'mod-main' }, [
      h('div', { class: 'mod-title' }, [h('span', { class: 'ellipsis' }, hit.title), h('span', { class: 'muted small' }, 'by ' + (hit.author || ''))]),
      h('div', { class: 'mod-desc' }, cleanMotd(hit.description)),
      h('div', { class: 'mod-meta' }, [
        h('span', {}, '⬇ ' + fmtNum(hit.downloads || 0)),
        ...(hit.categories || []).filter((c) => ['iris', 'optifine', 'shadows', 'pbr'].includes(c)).slice(0, 3).map((c) => h('span', { class: 'chip' }, c)),
      ]),
      h('div', { class: 'mod-foot' }, [
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => openInstall(hit) }, '安装到实例'),
        h('button', { class: 'btn btn-sm', onclick: () => openAllVersions(hit) }, '全部版本'),
        h('a', { class: 'btn btn-sm', href: `https://modrinth.com/${isShader ? 'shader' : 'resourcepack'}/${hit.slug}`, target: '_blank', rel: 'noreferrer' }, '项目主页'),
      ]),
    ]),
  ]);
}

function renderList() {
  if (!view) return;
  const list = view.querySelector('#res-list');
  if (!list) return;
  list.innerHTML = '';
  if (loading) { list.append(skeletonCards(8, 120)); return; }
  if (error) { list.append(h('div', { class: 'panel' }, [h('p', { class: 'dim' }, error), h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: () => search(true) }, '重试')])); return; }
  const hits = results?.hits || [];
  if (!hits.length) { list.append(emptyState({ icon: kind === 'shader' ? '☀' : '▧', title: '没有找到结果', sub: '换个关键词试试' })); return; }
  list.append(h('div', { class: 'mod-grid' }, hits.map(card)));
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;
  list.append(h('div', { class: 'row', style: { justifyContent: 'center', alignItems: 'center', gap: '10px', marginTop: '14px' } }, [
    h('button', { class: 'btn btn-sm', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE); search(false); } }, '上一页'),
    h('span', { class: 'hint' }, `第 ${page} / ${pages} 页 · 共 ${fmtNum(total)} 个结果`),
    h('button', { class: 'btn btn-sm', disabled: offset + PAGE >= total, onclick: () => { offset += PAGE; search(false); } }, '下一页'),
  ]));
}

async function openAllVersions(hit) {
  const body = h('div', {}, loadingBlock('正在获取全部版本…'));
  modal({
    title: '全部版本 · ' + hit.title,
    wide: true,
    body: [h('div', { class: 'hint', style: { marginBottom: '8px' } }, '不要求先创建实例，可以直接下载到本地。'), body],
    actions: [{ label: '关闭', kind: 'primary' }],
  });
  try {
    const r = await api(`/api/mods/versions/${hit.project_id || hit.slug}`);
    const versions = Array.isArray(r) ? r : (r.versions || []);
    if (!versions.length) { body.replaceChildren(h('div', { class: 'callout warn' }, '没有可用版本。')); return; }
    const target = h('select', { class: 'select' }, [
      ...state.instances.map((i) => h('option', { value: i.id, selected: i.id === (state.settings.lastInstanceId || state.instances[0]?.id) }, i.name)),
      h('option', { value: '' }, '仅下载'),
    ]);
    body.replaceChildren(
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '8px' } }, [
        h('span', { class: 'small muted' }, `共 ${versions.length} 个版本`),
        h('div', { class: 'row' }, [h('span', { class: 'small muted' }, '安装到：'), target]),
      ]),
      h('div', { class: 'list', style: { maxHeight: '420px', overflow: 'auto' } }, versions.slice(0, 200).map((v) => h('div', { class: 'list-item' }, [
        h('div', { class: 'li-main' }, [
          h('div', { class: 'li-title' }, v.version_number || v.name),
          h('div', { class: 'li-sub' }, `${(v.game_versions || []).slice(-8).join(', ')} · ${(v.loaders || []).join(', ')}`),
        ]),
        h('button', {
          class: 'btn btn-sm', onclick: async (e) => {
            try {
              e.currentTarget.disabled = true; e.currentTarget.textContent = '下载中…';
              await api('/api/resources/download', { method: 'POST', body: { projectId: hit.project_id || hit.slug, versionId: v.id, kind } });
              toastOk('已下载', v.version_number || v.name);
            } catch (err) { toastErr('下载失败', err.message); }
            finally { e.currentTarget.disabled = false; e.currentTarget.textContent = '下载'; }
          },
        }, '下载'),
        h('button', {
          class: 'btn btn-sm btn-primary', disabled: !target.value, onclick: async (e) => {
            if (!target.value) { toastErr('请选择实例'); return; }
            try {
              e.currentTarget.disabled = true; e.currentTarget.textContent = '安装中…';
              await api('/api/resources/install', { method: 'POST', body: { projectId: hit.project_id || hit.slug, versionId: v.id, instanceId: target.value, kind, gameVersion: (v.game_versions || [])[0] || '' } });
              toastOk('安装完成', hit.title);
            } catch (err) { toastErr('安装失败', err.message); }
            finally { e.currentTarget.disabled = false; e.currentTarget.textContent = '安装'; }
          },
        }, '安装'),
      ]))),
    );
  } catch (e) {
    body.replaceChildren(h('div', { class: 'callout err' }, '获取版本失败：' + e.message));
  }
}

async function openInstall(hit) {
  const inst = targetInstance();
  const sel = h('select', { class: 'select' }, state.instances.map((i) =>
    h('option', { value: i.id, selected: i.id === inst?.id }, `${i.name}${i.versionId ? ' · ' + i.versionId : ''}`)));
  const listEl = h('div', { class: 'vp-list' }, loadingBlock('正在获取可用版本…'));
  const status = h('div', { class: 'hint' });
  let versions = [];
  let picked = null;
  const m = modal({
    title: `安装${kind === 'shader' ? '光影' : '资源包'} · ${hit.title}`,
    wide: true,
    body: [
      kind === 'shader' ? h('div', { class: 'callout warn' }, [
        h('div', { class: 'c-icon' }, '!'),
        h('div', {}, '光影需要 Iris（Fabric/NeoForge）或 OptiFine 才能生效。如果你使用 Fabric，可先在「模组」页安装 Iris。'),
      ]) : null,
      h('div', { class: 'field' }, [h('label', {}, '安装到实例'), sel]),
      h('div', { class: 'field' }, [h('label', {}, '选择文件'), listEl, status]),
    ],
    actions: [
      { label: '取消' },
      {
        label: '安装', kind: 'primary',
        onClick: async () => {
          if (!picked) { toastErr('请选择文件', ''); return false; }
          if (!sel.value) { toastErr('没有实例', '请先创建实例'); return false; }
          try {
            status.textContent = '正在下载…';
            await api('/api/resources/install', { method: 'POST', body: { projectId: hit.project_id || hit.slug, versionId: picked, instanceId: sel.value, kind } });
            toastOk('安装完成', `${hit.title} → ${kind === 'shader' ? 'shaderpacks' : 'resourcepacks'}`);
          } catch (e) { toastErr('安装失败', e.message); return false; }
        },
      },
    ],
  });
  try {
    const gv = state.instances.find((i) => i.id === sel.value)?.versionId || '';
    versions = await api(`/api/mods/versions/${hit.project_id || hit.slug}?gameVersion=${encodeURIComponent(gv)}`);
    listEl.innerHTML = '';
    if (!versions.length) {
      versions = await api(`/api/mods/versions/${hit.project_id || hit.slug}`);
    }
    for (const v of versions.slice(0, 30)) {
      const row = h('div', { class: 'ver-row', style: { padding: '8px 12px' }, onclick: () => {
        picked = v.id;
        for (const c of listEl.children) c.classList.remove('selected');
        row.classList.add('selected');
      } }, [
        h('div', { class: 'grow' }, [
          h('div', { style: { fontSize: '12.5px', fontWeight: '600' } }, v.name || v.version_number),
          h('div', { class: 'small muted' }, `${(v.game_versions || []).slice(-4).join(', ')} · ${v.files?.[0]?.filename || ''}`),
        ]),
        badge('⬇ ' + fmtNum(v.downloads || 0)),
      ]);
      listEl.append(row);
    }
    if (versions.length) { picked = versions[0].id; listEl.firstChild?.classList.add('selected'); }
  } catch (e) {
    listEl.innerHTML = '';
    listEl.append(h('div', { class: 'callout err' }, '获取版本失败：' + e.message));
  }
  return m;
}

function renderPage() {
  if (!view) return;
  view.innerHTML = '';
  const tabsEl = h('div', { class: 'tabs' }, [
    h('button', { class: `tab ${kind === 'resourcepack' ? 'active' : ''}`, onclick: () => { kind = 'resourcepack'; results = null; renderPage(); search(true); } }, '资源包 / 材质'),
    h('button', { class: `tab ${kind === 'shader' ? 'active' : ''}`, onclick: () => { kind = 'shader'; results = null; renderPage(); search(true); } }, '光影'),
  ]);
  const searchInput = h('input', {
    class: 'input', placeholder: kind === 'shader' ? '搜索光影，例如 Complementary、BSL' : '搜索资源包，例如 Faithful、Xray',
    onkeydown: (e) => { if (e.key === 'Enter') search(true); }, oninput: (e) => { query = e.target.value; },
  });
  view.append(h('div', { class: 'home' }, [
    h('div', { class: 'panel', style: { padding: '14px' } }, [
      h('div', { class: 'filter-bar' }, [
        tabsEl,
        h('div', { class: 'search-bar grow' }, searchInput),
        h('select', { class: 'select', style: { width: '150px' }, onchange: (e) => { gameVersion = e.target.value; search(true); } }, [
          h('option', { value: '' }, '全部版本'),
          ...(state.versions.versions || []).filter((v) => v.type === 'release').slice(0, 50).map((v) => h('option', { value: v.id }, v.id)),
        ]),
        h('button', { class: 'btn btn-primary', onclick: () => search(true) }, '搜索'),
        h('button', { class: 'btn', html: `${icon('undo', 14)}<span>还原</span>`, onclick: () => { query = ''; gameVersion = ''; renderPage(); search(true); } }),
      ]),
      h('div', { class: 'hint', style: { marginTop: '8px' } },
        kind === 'shader'
          ? '光影包会被安装到实例的 shaderpacks 目录，配合 Iris / OptiFine 使用。'
          : '资源包会被安装到实例的 resourcepacks 目录，游戏内「选项 → 资源包」启用。'),
    ]),
    h('div', { id: 'res-list' }),
  ]));
  renderList();
  search(true);
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    if (ctx?.param) query = String(ctx.param);
    if (!state.versions.versions?.length) {
      try { const r = await api('/api/versions'); state.versions = r; } catch { /* ignore */ }
    }
    renderPage();
  },
  destroy() { view = null; ctxRef = null; results = null; },
};
