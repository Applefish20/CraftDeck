/* ================= 外部资源站 / 地图 / 投影 ================= */
import { h, toastErr, toastOk, badge } from '../ui.js';
import { state, api, patchSettings } from '../state.js';

const SITES = {
  curseforge: { name: 'CurseForge', url: 'https://cn-curseforge.com/', search: 'https://www.curseforge.com/minecraft/search?search=', color: '#f16436', tags: ['模组', '整合包', '地图', '材质'] },
  modrinth: { name: 'Modrinth', url: 'https://modrinth.com/', search: 'https://modrinth.com/mods?q=', color: '#1bd96a', tags: ['模组', '整合包', '材质', '光影'] },
  planet: { name: 'Planet Minecraft', url: 'https://www.planetminecraft.com/', search: 'https://www.planetminecraft.com/projects/?keywords=', color: '#4f9dff', tags: ['地图', '皮肤', '建筑'] },
  mczw: { name: '我的世界中文站', url: 'https://www.minecraftzw.com/', search: 'https://www.minecraftzw.com/?s=', color: '#ff9f43', tags: ['地图', '模组', '材质', '整合包'] },
  resourcepack: { name: 'ResourcePack.net', url: 'https://resourcepack.net/', search: 'https://resourcepack.net/?s=', color: '#b06cff', tags: ['材质', '资源包'] },
  minecraftmaps: { name: 'Minecraft Maps', url: 'https://www.minecraftmaps.com/', search: 'https://www.minecraftmaps.com/?s=', color: '#46d18a', tags: ['地图', '冒险', '跑酷'] },
  shadersmods: { name: 'ShadersMods', url: 'https://shadersmods.com/shaderpacks/', search: 'https://shadersmods.com/?s=', color: '#4cc2ff', tags: ['光影', 'Shader'] },
  mcimg: { name: '投影工坊 MCIMG', url: 'https://www.mcimg.com/', search: 'https://www.mcimg.com/search?keyword=', color: '#ffc857', tags: ['投影', '蓝图', '建筑'] },
};

const MODES = {
  maps: {
    title: '地图下载',
    sub: '在外部资源站寻找地图，下载后放进当前实例的 saves 文件夹。',
    sites: ['minecraftmaps', 'planet', 'curseforge', 'mczw'],
    folder: 'saves',
  },
  schematics: {
    title: '投影下载',
    sub: '寻找 Litematica / 蓝图投影，下载后放进当前实例的 schematics 文件夹。',
    sites: ['mcimg', 'planet', 'mczw', 'curseforge'],
    folder: 'schematics',
  },
  sources: {
    title: '资源站',
    sub: 'CurseForge、Modrinth、Planet Minecraft、中文站、材质、地图、光影与投影站点入口。',
    sites: Object.keys(SITES),
  },
};

let view = null;
let ctxRef = null;
let mode = 'sources';
let query = '';
let directUrl = '';
let directSource = 'mczw';
let directQuery = '';
let directItems = [];
let directLoading = false;
let directError = '';
let lastMode = '';
const autoLoaded = new Set();

const DIRECT_SOURCES = {
  maps: [['mczw', '我的世界中文站'], ['shadersmods', 'ShadersMods'], ['resourcepack', 'ResourcePack.net']],
  schematics: [['mczw', '我的世界中文站'], ['resourcepack', 'ResourcePack.net']],
  sources: [['mczw', '我的世界中文站'], ['resourcepack', 'ResourcePack.net'], ['shadersmods', 'ShadersMods']],
};

async function importLocalFile(file) {
  const inst = instance();
  if (!inst) { toastErr('没有实例', '请先创建一个实例'); return; }
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const r = await api(`/api/instances/${inst.id}/import-file`, {
      method: 'POST', body: buf,
      headers: {
        'x-filename': encodeURIComponent(file.name || 'archive.zip'),
        'x-kind': mode === 'schematics' ? 'schematic' : 'map',
        'Content-Type': 'application/octet-stream',
      },
    });
    toastOk('已导入实例', `${r.files || 0} 个文件`);
  } catch (e) { toastErr('导入失败', e.message); }
}

async function searchDirect() {
  directLoading = true;
  directError = '';
  if (view) renderPage();
  try {
    const r = await api(`/api/webresources/search?source=${encodeURIComponent(directSource)}&q=${encodeURIComponent(directQuery)}`);
    directItems = r.items || [];
    if (r.external && r.externalUrl) directError = '该站点没有公开 API，可打开外部搜索。';
    else if (r.error) directError = r.error;
  } catch (e) {
    directItems = [];
    directError = e.message;
  } finally {
    directLoading = false;
    renderPage();
  }
}

async function downloadResult(item) {
  const inst = instance();
  if (!inst) { toastErr('没有实例', '请先创建一个实例'); return; }
  const dl = (item.downloads || []).find((d) => d.direct);
  if (!dl) { openExternal(item.url); return; }
  try {
    const r = await api(`/api/instances/${inst.id}/import-url`, {
      method: 'POST', body: { url: dl.url, kind: mode === 'schematics' ? 'schematic' : 'map' },
    });
    toastOk('已导入实例', `${r.files || 0} 个文件`);
  } catch (e) { toastErr('下载失败', e.message); }
}

async function importDirect(inst, btn) {
  const url = directUrl.trim();
  if (!url) { toastErr('请输入直链', '例如 .zip / .litematic 文件地址'); return; }
  if (!inst) { toastErr('没有实例', '请先创建一个实例'); return; }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '下载中…';
  try {
    const r = await api(`/api/instances/${inst.id}/import-url`, {
      method: 'POST', body: { url, kind: mode === 'schematics' ? 'schematic' : 'map' },
    });
    toastOk('已导入实例', `${r.files || 0} 个文件`);
    directUrl = '';
    renderPage();
  } catch (e) { toastErr('下载失败', e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}

function instance() {
  return state.instances.find((i) => i.id === state.settings.lastInstanceId) || state.instances[0] || null;
}

function openExternal(url) {
  if (window.desktopWindow?.openExternal) window.desktopWindow.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

function siteCard(key) {
  const s = SITES[key];
  const q = query.trim();
  const url = q ? s.search + encodeURIComponent(q) : s.url;
  return h('div', { class: 'source-card' }, [
    h('div', { class: 'source-head' }, [
      h('div', { class: 'source-logo', style: { color: s.color, borderColor: `color-mix(in srgb, ${s.color} 45%, transparent)` } }, s.name.slice(0, 1)),
      h('div', { class: 'grow' }, [
        h('div', { class: 'source-name' }, s.name),
        h('div', { class: 'source-url ellipsis' }, s.url.replace(/^https?:\/\//, '')),
      ]),
    ]),
    h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap', margin: '8px 0' } }, s.tags.map((t) => badge(t))),
    h('div', { class: 'row', style: { gap: '6px' } }, [
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => openExternal(url) }, q ? '搜索' : '打开网站'),
      h('button', { class: 'btn btn-sm', onclick: () => openExternal(s.url) }, '主页'),
    ]),
  ]);
}

function renderPage() {
  if (!view) return;
  if (mode !== lastMode) {
    lastMode = mode;
    directItems = [];
    directError = '';
    if (!(DIRECT_SOURCES[mode] || []).some(([key]) => key === directSource)) directSource = 'mczw';
  }
  view.innerHTML = '';
  const cfg = MODES[mode] || MODES.sources;
  const inst = instance();
  const search = h('input', {
    class: 'input grow', placeholder: mode === 'schematics' ? '搜索投影 / 蓝图，例如 litematica' : '搜索地图，例如 survival island',
    value: query,
    oninput: (e) => { query = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') { query = e.currentTarget.value; renderPage(); } },
  });
  const instSelect = h('select', {
    class: 'select', style: { width: '260px' },
    onchange: (e) => { patchSettings({ lastInstanceId: e.target.value }).catch(() => {}); },
  }, state.instances.map((i) => h('option', { value: i.id, selected: i.id === inst?.id }, `${i.name}${i.versionId ? ' · ' + i.versionId : ''}`)));
  const folderBtn = cfg.folder ? h('button', {
    class: 'btn', disabled: !inst,
    onclick: async () => {
      if (!inst) return;
      try { await api(`/api/instances/${inst.id}/open`, { method: 'POST', body: { type: cfg.folder } }); }
      catch (e) { toastErr('打开失败', e.message); }
    },
  }, mode === 'schematics' ? '打开投影文件夹' : '打开存档文件夹') : null;
  let directBtn = null;
  const directInput = cfg.folder ? h('input', {
    class: 'input grow', placeholder: mode === 'schematics' ? '直链：.litematic / .schematic / .zip' : '直链：地图 .zip 下载地址',
    value: directUrl, oninput: (e) => { directUrl = e.target.value; },
  }) : null;
  if (cfg.folder) {
    directBtn = h('button', { class: 'btn btn-primary', onclick: () => importDirect(inst, directBtn) }, '下载到实例');
  }
  const localInput = cfg.folder ? h('input', {
    type: 'file', accept: mode === 'schematics' ? '.zip,.litematic,.schematic,.schem' : '.zip',
    style: { display: 'none' },
    onchange: (e) => { const f = e.target.files?.[0]; if (f) importLocalFile(f); e.target.value = ''; },
  }) : null;
  const localBtn = cfg.folder ? h('button', { class: 'btn', onclick: () => localInput.click() }, '导入本地文件') : null;

  const directSourceSelect = h('select', {
    class: 'select', style: { width: '190px' },
    onchange: (e) => { directSource = e.target.value; directItems = []; directError = ''; renderPage(); },
  }, (DIRECT_SOURCES[mode] || DIRECT_SOURCES.sources).map(([key, label]) => h('option', { value: key, selected: key === directSource }, label)));
  const directSearch = h('input', {
    class: 'input grow', placeholder: '在站内搜索内容，例如 survival、faithful、bsl',
    value: directQuery,
    oninput: (e) => { directQuery = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') searchDirect(); },
  });
  const resultCards = directItems.map((item) => h('div', { class: 'web-result' }, [
    item.image ? h('img', { class: 'web-result-img', src: item.image, alt: '', loading: 'lazy', onerror: (e) => { e.target.style.display = 'none'; } }) : null,
    h('div', { class: 'grow' }, [
      h('div', { class: 'web-result-title ellipsis' }, item.title),
      h('div', { class: 'hint web-result-ex' }, item.excerpt || ''),
      h('div', { class: 'row', style: { gap: '6px', marginTop: '7px', flexWrap: 'wrap' } }, [
        h('button', { class: 'btn btn-sm', onclick: () => openExternal(item.url) }, '查看详情'),
        (item.downloads || []).some((d) => d.direct) && cfg.folder
          ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => downloadResult(item) }, '下载到实例')
          : null,
      ]),
    ]),
  ]));
  const directPanel = h('div', { class: 'panel', style: { padding: '14px' } }, [
    h('div', { class: 'panel-title' }, '站内搜索内容'),
    h('div', { class: 'hint', style: { marginTop: '4px' } }, '直接从公开搜索结果读取标题、封面和下载链接；没有公开搜索接口的站点仍可打开外链。'),
    h('div', { class: 'filter-bar', style: { marginTop: '10px' } }, [
      directSourceSelect,
      directSearch,
      h('button', { class: 'btn btn-primary', disabled: directLoading, onclick: searchDirect }, directLoading ? '搜索中…' : '搜索'),
    ]),
    cfg.folder ? h('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
      h('span', { class: 'small muted' }, '目标实例'), instSelect, folderBtn,
    ]) : null,
    cfg.folder ? h('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
      h('span', { class: 'small muted' }, '本地导入'), localBtn, localInput,
    ]) : null,
    directError ? h('div', { class: 'callout warn', style: { marginTop: '8px' } }, directError) : null,
    resultCards.length ? h('div', { class: 'web-results' }, resultCards)
      : h('div', { class: 'hint', style: { marginTop: '8px' } }, '输入关键词后点搜索，结果会直接显示在这里。'),
  ]);

  view.append(h('div', { class: 'home' }, [
    h('div', { class: 'panel', style: { padding: '14px' } }, [
      h('div', { class: 'panel-title' }, cfg.title),
      h('div', { class: 'hint', style: { marginTop: '4px' } }, cfg.sub),
      h('div', { class: 'filter-bar', style: { marginTop: '12px' } }, [
        search,
        h('button', { class: 'btn btn-primary', onclick: () => { query = search.value; renderPage(); } }, '生成搜索'),
      ]),
      cfg.folder ? h('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        directInput,
        directBtn,
      ]) : null,
      cfg.folder ? h('div', { class: 'hint', style: { marginTop: '4px' } }, '也可以直接粘贴第三方站点提供的直链，启动器会下载并解压到目标文件夹。') : null,
    ]),
    directPanel,
    h('div', { class: 'callout warn disclaimer-callout' }, [
      h('strong', {}, '免责声明：'),
      h('span', {}, mode === 'maps' || mode === 'schematics'
        ? '地图、投影等资源均由第三方作者或资源站提供，并由其上传、发布至公开平台。CraftDeck 仅提供检索与下载入口，不代表本启动器制作、审核或存储这些内容，亦不对其来源、安全性、完整性、可用性及版权承担责任。下载和使用前请自行查毒、备份存档，并遵守原作者及对应站点的服务条款。'
        : '以下为第三方资源站。CraftDeck 不存储、不代理、不保证资源安全与版权合规；下载和使用前请自行查毒、备份存档，并遵守对应站点的服务条款。'),
    ]),
    h('div', { class: 'source-grid' }, cfg.sites.map(siteCard)),
  ]));
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    mode = ['maps', 'schematics', 'sources'].includes(ctx?.route) ? ctx.route : 'sources';
    renderPage();
    if ((mode === 'maps' || mode === 'schematics') && !autoLoaded.has(mode)) {
      autoLoaded.add(mode);
      directQuery = mode === 'maps' ? '地图' : '投影';
      searchDirect();
    }
  },
  destroy() { view = null; ctxRef = null; },
};
