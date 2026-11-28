/* ================= 整合包页 ================= */
import {
  h, toast, toastOk, toastErr, badge, emptyState, iconImg, fmtNum, fmtBytes, modal, loadingBlock, sectionTitle, progressBar,
} from '../ui.js';
import { state, api, subscribe } from '../state.js';

let view = null;
let ctxRef = null;
let tab = 'online';
let query = '';
let results = null;
let loading = false;
let error = null;
let upload = null; // {path, meta}
let unsub = null;
let offset = 0;
let total = 0;
const PAGE = 24;

function targetSelect() {
  return h('select', { class: 'select' }, [
    h('option', { value: '', selected: true }, '＋ 新建实例（推荐）'),
    ...state.instances.map((i) => h('option', { value: i.id }, `${i.name}${i.versionId ? ' · ' + i.versionId : ''}`)),
  ]);
}

async function doSearch(reset = true) {
  if (reset) offset = 0;
  loading = true; error = null;
  renderList();
  try {
    const params = new URLSearchParams({ query, type: 'modpack', limit: String(PAGE), offset: String(offset), index: 'downloads' });
    results = await api('/api/mods/search?' + params.toString());
    total = results.total_hits || 0;
  } catch (e) { error = e.message; results = null; }
  loading = false;
  renderList();
}

function packCard(hit) {
  return h('div', { class: 'pack-card' }, [
    h('div', { class: 'pack-cover', style: hit.icon_url ? { backgroundImage: `url("${hit.icon_url}")` } : {} }, [
      h('div', { style: { position: 'absolute', top: '8px', left: '8px', zIndex: '2', display: 'flex', gap: '5px' } }, [
        badge('整合包', 'accent'), hit.categories?.includes('adventure') ? badge('冒险') : null,
      ]),
    ]),
    h('div', { class: 'pack-body' }, [
      h('div', { class: 'pack-name ellipsis' }, hit.title),
      h('div', { class: 'pack-desc' }, hit.description),
      h('div', { class: 'mod-meta' }, [h('span', {}, '⬇ ' + fmtNum(hit.downloads || 0)), h('span', {}, '♥ ' + fmtNum(hit.follows || 0))]),
      h('div', { class: 'row', style: { marginTop: 'auto', paddingTop: '8px' } }, [
        h('button', { class: 'btn btn-sm btn-primary grow', onclick: () => openInstall(hit) }, '安装'),
        h('button', { class: 'btn btn-sm', onclick: () => openPackDetail(hit) }, '详情'),
      ]),
    ]),
  ]);
}

function renderList() {
  if (!view) return;
  const el = view.querySelector('#pack-list');
  if (!el) return;
  el.innerHTML = '';
  if (tab === 'online') {
    if (loading) { el.append(h('div', { class: 'pack-grid' }, Array.from({ length: 9 }, () => h('div', { class: 'skeleton', style: { height: '250px' } })))); return; }
    if (error) { el.append(h('div', { class: 'panel' }, [h('p', { class: 'dim' }, error), h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: () => doSearch(true) }, '重试')])); return; }
    const hits = results?.hits || [];
    if (!hits.length) { el.append(emptyState({ icon: '▤', title: '没有找到整合包', sub: '试试其它关键词，例如 "Fabulously Optimized"、"Better MC"' })); return; }
    el.append(h('div', { class: 'pack-grid' }, hits.map(packCard)));
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const page = Math.floor(offset / PAGE) + 1;
    el.append(h('div', { class: 'row', style: { justifyContent: 'center', alignItems: 'center', gap: '10px', marginTop: '14px' } }, [
      h('button', { class: 'btn btn-sm', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE); doSearch(false); } }, '上一页'),
      h('span', { class: 'hint' }, `第 ${page} / ${pages} 页 · 共 ${fmtNum(total)} 个结果`),
      h('button', { class: 'btn btn-sm', disabled: offset + PAGE >= total, onclick: () => { offset += PAGE; doSearch(false); } }, '下一页'),
    ]));
  } else {
    el.append(renderLocal());
  }
}

function renderLocal() {
  const fileInput = h('input', { type: 'file', accept: '.mrpack,.zip', style: { display: 'none' }, onchange: (e) => handleFile(e.target.files[0]) });
  const drop = h('div', {
    class: 'panel',
    style: { borderStyle: 'dashed', textAlign: 'center', padding: '46px 20px', cursor: 'pointer' },
    onclick: () => fileInput.click(),
    ondragover: (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; },
    ondragleave: () => { drop.style.borderColor = ''; },
    ondrop: (e) => { e.preventDefault(); drop.style.borderColor = ''; const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); },
  }, [
    h('div', { style: { fontSize: '38px', opacity: '.6' } }, '▤'),
    h('h3', { style: { marginTop: '10px' } }, '拖入整合包文件，或点击选择'),
    h('p', { class: 'hint', style: { marginTop: '6px' } }, '支持 Modrinth (.mrpack)、CurseForge (.zip) 与 MultiMC / Prism / PCL (.zip) 整合包；CurseForge 自动下载需要 API Key'),
    fileInput,
  ]);
  const info = upload ? h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [h('div', { class: 'panel-title' }, '已选择整合包'), badge(upload.meta?.format || '需要检查', 'accent')]),
    h('div', { class: 'detail-list' }, [
      detailRow('名称', upload.meta?.name || '—'),
      detailRow('游戏版本', upload.meta?.gameVersion || '—'),
      detailRow('加载器', upload.meta?.loader || '—'),
      detailRow('简介', upload.meta?.summary || '—'),
      detailRow('文件', upload.path?.split(/[\\/]/).pop() || ''),
    ]),
    h('div', { class: 'row', style: { marginTop: '12px' } }, [
      targetSelect(),
      h('button', { class: 'btn btn-primary', onclick: (e) => installFromPath(e.currentTarget) }, '安装此整合包'),
    ]),
  ]) : null;
  return h('div', { class: 'col' }, [drop, info]);
}

const detailRow = (k, v) => h('div', { class: 'detail-item' }, [h('span', { class: 'dk' }, k), h('span', { class: 'dv' }, v)]);

async function handleFile(file) {
  if (!file) return;
  const el = view.querySelector('#pack-list');
  const status = h('div', { class: 'callout info' }, `正在上传 ${file.name}（${fmtBytes(file.size)}）…`);
  el.prepend(status);
  try {
    const buf = await file.arrayBuffer();
    const meta = await api('/api/modpacks/upload', {
      method: 'POST',
      body: buf,
      headers: { 'x-filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
    });
    upload = { path: meta.path, meta: meta.meta };
    toastOk('整合包已上传', meta.meta?.name || file.name);
    renderList();
  } catch (e) {
    status.className = 'callout err';
    status.textContent = '上传失败：' + e.message;
    toastErr('上传失败', e.message);
  }
}

async function installFromPath(btn) {
  if (!upload) return;
  const instId = view.querySelector('#pack-list select')?.value || null;
  try {
    if (btn) { btn.disabled = true; btn.textContent = '正在安装…'; }
    const r = await api('/api/modpacks/install', { method: 'POST', body: { path: upload.path, instanceId: instId, name: upload.meta?.name } });
    toastOk('整合包安装完成', r.name || upload.meta?.name);
    upload = null;
    ctxRef.refresh();
  } catch (e) {
    toastErr('安装失败', e.message);
    if (btn) { btn.disabled = false; btn.textContent = '安装此整合包'; }
  }
}

async function openPackDetail(hit) {
  const m = modal({
    title: hit.title, wide: true,
    body: loadingBlock('加载中…'),
    actions: [{ label: '关闭' }, { label: '安装', kind: 'primary', onClick: () => openInstall(hit) }],
  });
  try {
    const p = await api(`/api/mods/project/${hit.project_id || hit.slug}`);
    const body = m.el.querySelector('.modal-body');
    body.innerHTML = '';
    body.append(
      h('div', { class: 'row', style: { gap: '14px', alignItems: 'flex-start' } }, [
        iconImg(p.icon_url, '▤', 'mod-icon'),
        h('div', { class: 'grow' }, [
          h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [badge('整合包', 'accent'), badge('⬇ ' + fmtNum(p.downloads || 0))]),
          h('p', { class: 'dim', style: { marginTop: '8px' } }, p.description),
        ]),
      ]),
      h('div', { style: { fontSize: '12.5px', lineHeight: '1.75', color: 'var(--text-dim)', maxHeight: '340px', overflow: 'auto' } }, (p.body || '').slice(0, 12000)),
    );
  } catch (e) { toastErr('加载失败', e.message); }
}

async function openInstall(hit) {
  const sel = targetSelect();
  const packBtn = h('button', { class: 'picker-btn', type: 'button', disabled: true }, [
    h('span', { class: 'ellipsis' }, '正在获取整合包版本…'), h('span', { class: 'picker-arrow' }, '▾'),
  ]);
  const setPackLabel = (text) => packBtn.replaceChildren(h('span', { class: 'ellipsis' }, text), h('span', { class: 'picker-arrow' }, '▾'));
  const status = h('div', { class: 'hint' }, '安装会创建新实例（若选择已有实例则安装到该实例）并下载全部模组与配置，可能需要几分钟。');
  const bar = h('div');
  let packVersion = '';
  let packVersions = [];

  const openPackPicker = () => {
    if (!packVersions.length) return;
    let keyword = '';
    const expanded = new Set();
    let initialized = false;
    const list = h('div', { class: 'loader-picker-list pack-version-groups' });
    const draw = () => {
      const arr = packVersions.filter((v) => !keyword || `${v.version_number || ''} ${v.name || ''} ${(v.game_versions || []).join(' ')}`.toLowerCase().includes(keyword));
      const groups = new Map();
      for (const v of arr) {
        const gv = (v.game_versions || []).slice(-1)[0] || '其他版本';
        if (!groups.has(gv)) groups.set(gv, []);
        groups.get(gv).push(v);
      }
      const keys = [...groups.keys()].sort((a, b) => String(b).localeCompare(String(a), undefined, { numeric: true }));
      if (!initialized && keys.length) { expanded.add(keys[0]); initialized = true; }
      if (keyword) for (const k of keys) expanded.add(k);
      if (!keys.length) {
        list.replaceChildren(h('div', { class: 'hint', style: { padding: '12px' } }, '没有匹配的版本'));
        return;
      }
      list.replaceChildren(...keys.map((gv) => {
        const isOpen = expanded.has(gv);
        const head = h('button', {
          class: `pack-version-group-head ${isOpen ? 'open' : ''}`, type: 'button',
          onclick: () => { if (isOpen) expanded.delete(gv); else expanded.add(gv); draw(); },
        }, [
          h('span', { class: 'pack-version-name' }, gv),
          h('span', { class: 'muted small' }, `${groups.get(gv).length} 个版本`),
          h('span', { class: 'pack-version-arrow' }, '▾'),
        ]);
        const body = isOpen ? h('div', { class: 'pack-version-group-body' }, groups.get(gv).slice(0, 120).map((v) => h('button', {
          class: `loader-pick-item ${packVersion === v.id ? 'selected' : ''}`,
          onclick: () => {
            packVersion = v.id;
            setPackLabel(`${v.version_number || v.name}${v.game_versions?.length ? ' · ' + v.game_versions.slice(-1)[0] : ''}`);
            picker.close?.();
          },
        }, [
          h('span', {}, v.version_number || v.name),
          h('span', { class: 'muted small' }, `${(v.game_versions || []).slice(-1)[0] || ''}${v.version_type === 'release' ? ' · 正式版' : ''}`),
        ]))) : null;
        return h('div', { class: 'pack-version-group' }, [head, body]);
      }));
    };
    const picker = modal({
      title: '选择整合包版本',
      wide: true,
      body: [
        h('input', { class: 'input', placeholder: '搜索版本号或游戏版本…', oninput: (e) => { keyword = e.target.value.trim().toLowerCase(); draw(); } }),
        h('div', { class: 'hint', style: { margin: '8px 0' } }, `共 ${packVersions.length} 个版本，按游戏大版本分组，点开再选。`),
        list,
      ],
      actions: [{ label: '关闭', kind: 'primary' }],
    });
    draw();
  };
  packBtn.addEventListener('click', openPackPicker);

  const m = modal({
    title: '安装整合包 · ' + hit.title,
    body: [
      h('div', { class: 'callout info' }, '整合包会自动安装对应的 Minecraft 版本、模组加载器与模组文件。请保持启动器运行。'),
      h('div', { class: 'field' }, [h('label', {}, '整合包版本'), packBtn]),
      h('div', { class: 'field' }, [h('label', {}, '安装位置'), sel]),
      status, bar,
    ],
    actions: [
      { label: '取消' },
      {
        label: '开始安装', kind: 'primary', keepOpen: true,
        onClick: async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = '正在下载整合包…';
          try {
            const r = await api('/api/modpacks/install-project', {
              method: 'POST',
              body: { projectId: hit.project_id || hit.slug, versionId: packVersion || undefined, instanceId: sel.value || null, name: hit.title, iconUrl: hit.icon_url || null },
            });
            status.textContent = '模组文件安装完成，正在后台配置游戏版本与加载器…';
            toastOk('整合包安装完成', r.name || hit.title);
            setTimeout(() => m.close?.(), 800);
          } catch (e) {
            status.className = 'callout err';
            status.textContent = '安装失败：' + e.message;
            ev.target.disabled = false;
            ev.target.textContent = '重试安装';
          }
        },
      },
    ],
  });
  try {
    const r = await api(`/api/mods/versions/${hit.project_id || hit.slug}`);
    packVersions = Array.isArray(r) ? r : (r.versions || []);
    packBtn.disabled = !packVersions.length;
    if (packVersions.length) {
      packVersion = packVersions[0].id;
      const v = packVersions[0];
      setPackLabel(`${v.version_number || v.name}${v.game_versions?.length ? ' · ' + v.game_versions.slice(-1)[0] : ''}`);
    } else {
      setPackLabel('没有可用版本');
    }
  } catch (e) {
    packBtn.disabled = true;
    setPackLabel('获取版本失败');
    status.textContent = '获取整合包版本失败：' + e.message;
  }
}

function renderPage() {
  if (!view) return;
  view.innerHTML = '';
  const searchInput = h('input', {
    class: 'input', placeholder: '搜索整合包，例如 Fabulously Optimized', value: query,
    onkeydown: (e) => { if (e.key === 'Enter') doSearch(true); },
    oninput: (e) => { query = e.target.value; },
  });
  const tabsEl = h('div', { class: 'tabs' }, [
    h('button', { class: `tab ${tab === 'online' ? 'active' : ''}`, onclick: () => { tab = 'online'; renderPage(); } }, '在线整合包'),
    h('button', { class: `tab ${tab === 'local' ? 'active' : ''}`, onclick: () => { tab = 'local'; renderPage(); } }, '本地导入'),
  ]);
  view.append(h('div', { class: 'home' }, [
    h('div', { class: 'panel', style: { padding: '14px' } }, [
      h('div', { class: 'filter-bar' }, [
        tabsEl,
        tab === 'online' ? h('div', { class: 'search-bar grow' }, searchInput) : h('div', { class: 'grow' }),
        tab === 'online' ? h('button', { class: 'btn btn-primary', onclick: () => doSearch(true) }, '搜索') : null,
      ]),
      tab === 'local' ? h('div', { class: 'hint', style: { marginTop: '8px' } }, '本地整合包会先上传到启动器数据目录，再安装到实例。') : null,
    ]),
    h('div', { id: 'pack-list' }),
  ]));
  renderList();
  if (tab === 'online' && !results && !loading) doSearch(true);
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    renderPage();
    unsub = subscribe((evt) => {
      if (evt.type === 'sse' && evt.evt.type === 'progress' && evt.evt.finished && evt.evt.scope === 'modpack') {
        setTimeout(() => ctx.refresh(), 600);
      }
    });
  },
  destroy() { if (unsub) unsub(); unsub = null; view = null; ctxRef = null; },
};
