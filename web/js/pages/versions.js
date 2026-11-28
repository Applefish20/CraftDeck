/* ================= 版本下载页（大版本分类） ================= */
import {
  h, toast, toastErr, toastOk, badge, emptyState, fmtDate, fmtRelative, progressBar, sectionTitle, modal, loadingBlock,
} from '../ui.js';
import { state, api, subscribe, loadState } from '../state.js';
import { iconForVersion, coverForSeed, isCutoutIcon } from '../versionicons.js';

let unsub = null;
let view = null;
let ctxRef = null;
let resp = null;
let installed = [];
let mode = 'release'; // release | snapshot | beta | alpha | fun | all
let modeTabs = null;
let query = '';

const FUN_NAMES = {
  '25w14craftmine': 'Craftmine（2025 愚人节）',
  '24w14potato': '毒土豆更新（2024 愚人节）',
  '23w13a_or_b': '投票更新（2023 愚人节）',
  '22w13oneblockatatime': '一个方块（2022 愚人节）',
  '20w14infinite': '无限维度（2020 愚人节）',
  '3D Shareware v1.34': '3D 共享软件（2019 愚人节）',
  '1.RV-Pre1': '潮流更新（2016 愚人节）',
  '15w14a': '爱与拥抱（2015 愚人节）',
};
const FUN_IDS = Object.keys(FUN_NAMES);

const MODES = [
  { key: 'release', label: '正式版' },
  { key: 'snapshot', label: '快照' },
  { key: 'fun', label: '搞怪/愚人节' },
  { key: 'beta', label: 'Beta' },
  { key: 'alpha', label: 'Alpha（远古）' },
  { key: 'all', label: '全部' },
];

const LOADER_OPTIONS = [
  ['vanilla', '原版 Vanilla'], ['fabric', 'Fabric'], ['quilt', 'Quilt'], ['forge', 'Forge'], ['neoforge', 'NeoForge'],
];

function typeAllowed(v) {
  if (mode === 'all') return true;
  if (mode === 'release') return v.type === 'release';
  if (mode === 'snapshot') return v.type === 'snapshot';
  if (mode === 'beta') return v.type === 'old_beta';
  if (mode === 'alpha') return v.type === 'old_alpha';
  if (mode === 'fun') return FUN_IDS.includes(v.id);
  return true;
}

/** 1.21.8 -> 1.21；1.20.1 -> 1.20；26.3 -> 26（26.x 是一组）；b1.7.3 -> Beta */
function majorOf(v) {
  if (v.type === 'snapshot') return '快照';
  if (v.type === 'old_beta') return 'Beta';
  if (v.type === 'old_alpha') return 'Alpha';
  const m = /^(\d+)\.(\d+)/.exec(v.id || '');
  if (!m) return '其他';
  return Number(m[1]) === 1 ? `1.${m[2]}` : m[1];
}

function groupVersions(list) {
  const map = new Map();
  for (const v of list) {
    const key = majorOf(v);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  const groups = [...map.entries()].map(([key, versions]) => {
    versions.sort((a, b) => new Date(b.releaseTime) - new Date(a.releaseTime));
    return {
      key,
      versions,
      latest: versions[0],
      count: versions.length,
      special: ['快照', 'Beta', 'Alpha', '其他'].includes(key),
    };
  });
  const num = (k) => {
    const m = /^(\d+)(?:\.(\d+))?/.exec(k);
    return m ? Number(m[1]) * 1000 + Number(m[2] || 0) : -1;
  };
  groups.sort((a, b) => {
    if (a.special !== b.special) return a.special ? 1 : -1;
    return num(b.key) - num(a.key);
  });
  return groups;
}

function installedInfo(id) {
  return installed.find((x) => x.id === id) || null;
}

async function loadInstalled() {
  const r = await api('/api/versions/installed').catch(() => ({ installed: [] }));
  installed = r.installed || [];
}

async function startSetup(versionId, instId, loader, btn, loaderVersion = null) {
  try {
    if (!instId) {
      const meta = (state.versions.versions || []).find((v) => v.id === versionId);
      const cr = await api('/api/instances', {
        method: 'POST',
        body: { name: versionId, versionId, installing: true, loader: { type: loader || 'vanilla', version: null }, icon: iconForVersion(versionId, meta?.type, loader) },
      });
      instId = cr.instance.id;
    }
    if (btn) { btn.disabled = true; btn.textContent = '正在开始…'; }
    await api(`/api/instances/${instId}/setup`, {
      method: 'POST',
      body: { versionId, loader: loader || 'vanilla', loaderVersion: loaderVersion || null },
    });
    toast({ kind: 'info', title: '已开始安装', message: `${versionId} · ${loader || 'vanilla'}，进度见左下角`, timeout: 5000 });
    setTimeout(() => { loadInstalled().then(() => ctxRef.refresh()); }, 1000);
  } catch (e) {
    toastErr('安装失败', e.message);
    if (btn) { btn.disabled = false; btn.textContent = '安装'; }
  }
}

async function downloadOnly(versionId, btn) {
  try {
    if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
    toast({ kind: 'info', title: '已开始下载', message: versionId + ' 正在后台下载', timeout: 3500 });
    api('/api/versions/install', { method: 'POST', body: { versionId } })
      .then(() => { loadInstalled().then(() => ctxRef.refresh()); })
      .catch((e) => toastErr('下载失败', e.message))
      .finally(() => { if (btn) { btn.disabled = false; btn.textContent = '仅下载'; } });
  } catch (e) { toastErr('下载失败', e.message); }
}

function majorCard(g) {
  const installedInGroup = g.versions.filter((v) => installedInfo(v.id)).length;
  const cover = coverForSeed(g.key);
  return h('div', {
    class: 'major-card has-cover',
    style: { backgroundImage: `linear-gradient(115deg, rgba(255,255,255,.95), rgba(255,255,255,.72)), url("${cover}")` },
    onclick: () => openMajorModal(g),
  }, [
    h('div', { class: 'major-num' }, g.key),
    h('div', { class: 'major-sub' }, g.special ? `${g.count} 个版本` : `最新 ${g.latest.id}`),
    h('div', { class: 'major-meta' }, [
      installedInGroup ? badge(`已装 ${installedInGroup}`, 'violet') : badge(`${g.count} 个版本`),
      h('span', { class: 'muted small' }, fmtDate(g.latest.releaseTime)),
    ]),
  ]);
}

function openVersionInstall(v) {
  let loaderType = 'vanilla';
  const typeTabs = h('div', { class: 'segmented' }, LOADER_OPTIONS.map(([k, l]) => h('button', {
    type: 'button', class: `seg-btn ${k === 'vanilla' ? 'active' : ''}`,
    onclick: (e) => {
      loaderType = k;
      for (const b of typeTabs.children) b.classList.toggle('active', b.dataset.key === k);
      loadLoaderVersions();
    },
    dataset: { key: k },
  }, [
    h('img', { class: `seg-icon ${isCutoutIcon(iconForVersion(v.id, v.type, k === 'vanilla' ? '' : k)) ? 'is-cutout' : ''}`, src: iconForVersion(v.id, v.type, k === 'vanilla' ? '' : k), alt: '' }),    h('span', {}, l),
  ])));
  let selectedLoaderVersion = '';
  let loaderItems = [];
  const verBtn = h('button', {
    class: 'picker-btn', type: 'button', disabled: true,
    onclick: () => openLoaderPicker(),
  }, [h('span', {}, '原版无需加载器版本'), h('span', { class: 'picker-arrow' }, '▾')]);
  const setVerLabel = (text) => { verBtn.replaceChildren(h('span', { class: 'ellipsis' }, text), h('span', { class: 'picker-arrow' }, '▾')); };
  const status = h('div', { class: 'hint' }, '选择加载器后会列出可用版本；默认使用最新稳定版。');
  let close = null;

  const openLoaderPicker = () => {
    if (!loaderItems.length) return;
    let stableOnly = false;
    let keyword = '';
    const list = h('div', { class: 'loader-picker-list' });
    const draw = () => {
      const arr = loaderItems.filter((x) => {
        if (stableOnly && x.stable === false) return false;
        if (keyword && !String(x.version).toLowerCase().includes(keyword)) return false;
        return true;
      });
      const rows = arr.length ? arr.map((x) => h('button', {
        class: `loader-pick-item ${selectedLoaderVersion === x.version ? 'selected' : ''}`,
        onclick: () => { selectedLoaderVersion = x.version; setVerLabel(x.version); picker.close?.(); },
      }, [
        h('span', {}, x.version),
        x.stable === false ? h('span', { class: 'chip' }, '测试版') : h('span', { class: 'muted small' }, '稳定'),
      ])) : [h('div', { class: 'hint', style: { padding: '12px' } }, '没有匹配的版本')];
      list.replaceChildren(
        h('button', {
          class: `loader-pick-item ${selectedLoaderVersion === '' ? 'selected' : ''}`,
          onclick: () => { selectedLoaderVersion = ''; setVerLabel('最新（自动选择）'); picker.close?.(); },
        }, [h('span', {}, '最新（自动选择）'), h('span', { class: 'muted small' }, '推荐')]),
        ...rows,
      );
    };
    const search = h('input', {
      class: 'input', placeholder: '搜索加载器版本…',
      oninput: (e) => { keyword = e.target.value.trim().toLowerCase(); draw(); },
    });
    const stable = h('label', { class: 'check' }, [
      h('input', { type: 'checkbox', onchange: (e) => { stableOnly = e.target.checked; draw(); } }),
      '只看稳定版',
    ]);
    const picker = modal({
      title: `选择 ${loaderType} 版本`,
      wide: true,
      body: [
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } }, [search, stable]),
        h('div', { class: 'hint', style: { marginBottom: '8px' } }, `共 ${loaderItems.length} 个版本，点一下即可选中。`),
        list,
      ],
      actions: [{ label: '关闭', kind: 'primary' }],
    });
    draw();
  };

  const loadLoaderVersions = async () => {
    const type = loaderType;
    selectedLoaderVersion = '';
    loaderItems = [];
    if (type === 'vanilla') {
      verBtn.disabled = true;
      setVerLabel('原版无需加载器版本');
      status.textContent = '原版游戏，不安装模组加载器。';
      return;
    }
    verBtn.disabled = true;
    setVerLabel('正在获取版本…');
    status.textContent = '正在获取加载器版本…';
    try {
      const r = await api(`/api/versions/loaders?type=${encodeURIComponent(type)}&gameVersion=${encodeURIComponent(v.id)}`);
      loaderItems = r.versions || [];
      verBtn.disabled = !loaderItems.length;
      setVerLabel(loaderItems.length ? '最新（自动选择）' : '没有可用版本');
      status.textContent = loaderItems.length ? `共 ${loaderItems.length} 个 ${type} 版本，点下拉框选择，默认使用最新。` : `这个游戏版本没有可用的 ${type} 版本。`;
    } catch (e) {
      verBtn.disabled = true;
      setVerLabel('获取失败');
      status.textContent = '获取加载器版本失败：' + e.message;
    }
  };

  const m = modal({
    title: `安装 Minecraft ${v.id}`,
    wide: true,
    body: [
      h('div', { class: 'ver-install-hero' }, [
        h('div', { class: 'ver-install-icon' }, '▦'),
        h('div', { class: 'grow' }, [
          h('div', { class: 'ver-install-title' }, `Minecraft ${v.id}`),
          h('div', { class: 'ver-install-sub' }, `${fmtDate(v.releaseTime)} · ${v.type === 'release' ? '正式版' : v.type === 'snapshot' ? '快照' : v.type}`),
        ]),
        badge('自动创建启动项', 'accent'),
      ]),
      h('div', { class: 'ver-install-form' }, [
        h('div', { class: 'field' }, [h('label', {}, '模组加载器'), typeTabs]),
        h('div', { class: 'field' }, [h('label', {}, '加载器版本'), verBtn]),
      ]),
      status,
      h('div', { class: 'hint' }, '加载器版本留空则使用最新版本；安装完成后会直接出现在「启动」页。'),
    ],
    actions: [
      { label: '取消' },
      {
        label: '开始下载', kind: 'primary', keepOpen: true,
        onClick: async (e) => {
          const btn = e.target;
          try {
            btn.disabled = true; btn.textContent = '正在开始…';
            await startSetup(v.id, null, loaderType, btn, selectedLoaderVersion || null);
            m.close?.();
          } catch (err) {
            btn.disabled = false; btn.textContent = '开始下载';
            status.textContent = '安装失败：' + err.message;
          }
        },
      },
    ],
  });
  close = m.close;
  loadLoaderVersions();
  return m;
}

function openMajorModal(g) {
  const cards = h('div', { class: 'minor-grid', style: { maxHeight: '420px', overflow: 'auto', paddingRight: '4px' } }, g.versions.map((v) => {
    const inst = installedInfo(v.id);
    return h('div', { class: 'minor-card' }, [
      h('div', { class: 'minor-cover', style: { backgroundImage: `url("${coverForSeed(v.id)}")` } },
        h('img', { class: `minor-icon ${isCutoutIcon(inst?.icon || iconForVersion(v.id, v.type, '')) ? 'is-cutout' : ''}`, src: inst?.icon || iconForVersion(v.id, v.type, ''), alt: '' })),
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
        h('div', { class: 'v' }, v.id),
        inst ? badge('已安装', 'ok') : badge(v.type === 'release' ? '正式版' : v.type === 'snapshot' ? '快照' : v.type),
      ]),
      h('div', { class: 'meta' }, `${fmtDate(v.releaseTime)} · ${v.type}`),
      h('div', { class: 'acts' }, [
        h('button', {
          class: 'btn btn-sm btn-primary grow',
          onclick: () => openVersionInstall(v),
        }, '安装'),
        h('button', {
          class: 'btn btn-sm',
          onclick: (e) => downloadOnly(v.id, e.currentTarget),
        }, '仅下载'),
      ]),
    ]);
  }));
  modal({
    title: `Minecraft ${g.key} · 选择小版本`,
    wide: true,
    body: [
      h('div', { class: 'hint' }, `${g.key} 系列共 ${g.versions.length} 个版本，按发布时间排序。点「安装」可选择加载器和加载器版本，自动创建同名启动项。`),
      cards,
    ],
    actions: [{ label: '关闭', kind: 'primary' }],
  });
}

function versionRow(v) {
  const inst = installedInfo(v.id);
  return h('div', { class: 'ver-row' }, [
    h('div', { class: 'ver-row-icon' }, h('img', {
      class: isCutoutIcon(inst?.icon || iconForVersion(v.id, v.type, '')) ? 'is-cutout' : '',
      src: inst?.icon || iconForVersion(v.id, v.type, ''), alt: '',
      onerror: (e) => { e.target.src = '/assets/instance/grass-block.webp'; },
    })),
    h('div', { class: 'grow' }, [
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [
        h('span', { class: 'mono', style: { fontWeight: '700' } }, v.id),
        FUN_NAMES[v.id] ? h('span', { class: 'small', style: { color: 'var(--accent)' } }, FUN_NAMES[v.id]) : null,
        badge(v.type === 'release' ? '正式版' : v.type === 'snapshot' ? '快照' : v.type, v.type === 'release' ? 'ok' : 'warn'),
        inst ? badge('已安装', 'violet') : null,
      ]),
      h('div', { class: 'small muted' }, fmtDate(v.releaseTime)),
    ]),
    h('button', {
      class: 'btn btn-sm',
      onclick: () => openVersionInstall(v),
    }, '安装'),
    h('button', { class: 'btn btn-sm btn-ghost', onclick: () => downloadOnly(v.id) }, '仅下载'),
  ]);
}

function latestPanel(list) {
  const release = list.find((v) => v.type === 'release');
  const snapshot = list.find((v) => v.type === 'snapshot');
  const row = (v, label) => v ? h('div', { class: 'list-item' }, [
    h('div', { class: 'ver-row-icon' }, h('img', { class: isCutoutIcon(iconForVersion(v.id, v.type, '')) ? 'is-cutout' : '', src: iconForVersion(v.id, v.type, ''), alt: '' })),
    h('div', { class: 'li-main' }, [
      h('div', { class: 'row', style: { gap: '6px' } }, [
        h('div', { class: 'li-title mono' }, v.id),
        badge(label, label === '正式版' ? 'ok' : 'warn'),
      ]),
      h('div', { class: 'li-sub' }, `${fmtDate(v.releaseTime)} · ${v.type === 'release' ? '正式版' : '预览版'}`),
    ]),
    h('button', { class: 'btn btn-sm btn-primary', onclick: () => openVersionInstall(v) }, '安装'),
  ]) : null;
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [h('div', { class: 'panel-title' }, '最新版本')]),
    h('div', { class: 'list' }, [row(release, '正式版'), row(snapshot, '预览版')].filter(Boolean)),
  ]);
}

function content() {
  if (!resp) return loadingBlock('加载版本列表…');
  const list = (resp.versions || []).filter(typeAllowed);
  const q = query.trim().toLowerCase();
  if (q) {
    const hits = list.filter((v) => v.id.toLowerCase().includes(q)).slice(0, 300);
    if (!hits.length) return emptyState({ icon: '◈', title: '没有匹配的版本', sub: '换个关键词，例如 1.21、1.20.1、b1.7.3' });
    return h('div', { class: 'ver-list' }, hits.map(versionRow));
  }
  if (!list.length) return emptyState({ icon: '◈', title: '没有该类版本' });
  if (mode === 'release') {
    const groups = groupVersions(list);
    return h('div', { class: 'col' }, [latestPanel(list), h('div', { class: 'major-grid' }, groups.map(majorCard))]);
  }
  if (mode === 'all') {
    const groups = groupVersions(list);
    return h('div', { class: 'col' }, [latestPanel(list), h('div', { class: 'major-grid' }, groups.map(majorCard))]);
  }
  return h('div', { class: 'ver-list' }, list.slice(0, 400).map(versionRow));
}

function installedPanel() {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [h('div', { class: 'panel-title' }, '本地已安装'), h('span', { class: 'muted small' }, installed.length + ' 个')]),
    installed.length
      ? h('div', { class: 'list' }, installed.slice(-40).reverse().map((v) => h('div', { class: 'list-item' }, [
        h('div', { class: 'li-main' }, [
          h('div', { class: 'li-title mono' }, v.id),
          h('div', { class: 'li-sub' }, [v.inheritsFrom ? `继承自 ${v.inheritsFrom}` : '原版', v.loader ? ` · ${v.loader.type} ${v.loader.version || ''}` : ''].join('')),
        ]),
        v.loader ? badge(v.loader.type, 'accent') : badge('原版'),
      ])))
      : h('div', { class: 'hint' }, '还没有安装任何版本。'),
  ]);
}

function updateContent() {
  const host = view?.querySelector('#ver-content');
  if (!host) return;
  host.replaceChildren(content());
}

function switchMode(next) {
  if (mode === next) return;
  const apply = () => {
    mode = next;
    if (modeTabs) for (const b of modeTabs.children) b.classList.toggle('active', b.dataset.mode === next);
    updateContent();
  };
  if (typeof document.startViewTransition === 'function') document.startViewTransition(apply);
  else apply();
}

function renderBody() {
  if (!view) return;
  view.innerHTML = '';
  const searchInput = h('input', {
    class: 'input', placeholder: '搜索版本号，例如 1.21.1、1.20、b1.7.3', value: query,
    oninput: (e) => { query = e.target.value; clearTimeout(searchInput._t); searchInput._t = setTimeout(updateContent, 180); },
  });
  const tabsEl = h('div', { class: 'tabs' }, MODES.map((m) => h('button', {
    class: `tab ${mode === m.key ? 'active' : ''}`, dataset: { mode: m.key },
    onclick: () => switchMode(m.key),
  }, m.label)));
  modeTabs = tabsEl;

  view.append(h('div', { class: 'home' }, [
    h('div', { class: 'panel', style: { padding: '14px' } }, [
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } }, [
        tabsEl,
        h('div', { class: 'search-bar grow', style: { minWidth: '220px' } }, searchInput),
        h('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            try { const r = await api('/api/versions/manifest/refresh', { method: 'POST', body: {} }); resp = await api('/api/versions?snapshots=1&old=1'); toastOk('版本清单已刷新', `共 ${r.count} 个版本`); updateContent(); }
            catch (e) { toastErr('刷新失败', e.message); }
          },
        }, '刷新清单'),
      ]),
      h('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        h('span', { class: 'muted small' }, '点击大版本卡片查看小版本：'),
        h('span', { class: 'hint' }, '1.21 → 1.21.8 / 1.21.7 …；Beta、Alpha 与快照在对应分类中。'),
        h('div', { class: 'spacer' }),
        h('span', { class: 'muted small' }, `共 ${(resp?.versions || []).length} 个版本 · 更新于 ${fmtRelative(resp?.fetchedAt)}`),
      ]),
    ]),
    h('div', { id: 'ver-content' }, content()),
  ]));
}

export default {
  async render(el, ctx) {
    view = el;
    ctxRef = ctx;
    view.append(loadingBlock('正在获取版本列表…'));
    try {
      resp = await api('/api/versions?snapshots=1&old=1');
    } catch (e) {
      view.innerHTML = '';
      view.append(h('div', { class: 'panel' }, [
        h('h2', {}, '无法获取版本列表'),
        h('p', { class: 'dim', style: { marginTop: '8px' } }, e.message),
        h('button', { class: 'btn btn-primary', style: { marginTop: '12px' }, onclick: () => ctx.refresh() }, '重试'),
      ]));
      return;
    }
    await loadInstalled();
    renderBody();
    unsub = subscribe((evt) => {
      if (evt.type === 'sse' && evt.evt.type === 'progress' && evt.evt.scope === 'version' && evt.evt.finished) {
        setTimeout(() => loadInstalled().then(renderBody), 600);
      }
    });
  },
  destroy() {
    if (unsub) unsub();
    unsub = null; view = null; ctxRef = null;
  },
};
