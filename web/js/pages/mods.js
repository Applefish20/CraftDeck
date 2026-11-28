/* ================= 模组页 ================= */
import {
  h, toast, toastOk, toastErr, badge, emptyState, iconImg, fmtNum, fmtRelative, skeletonCards,
  sectionTitle, modal, loadingBlock, switchEl, cleanMotd,
} from '../ui.js';
import { state, api, subscribe } from '../state.js';
import { modDisplayName, zhModName } from '../modnames.mjs';
import { icon } from '../icons.js';

const showName = (hit) => (state.settings.translateModNames === false ? hit.title : modDisplayName(hit));

let view = null;
let ctxRef = null;
const q = {
  query: '', type: 'mod', gameVersion: '', loader: '', category: '', offset: 0, limit: 20,
  loading: false, results: null, error: null, requestId: 0,
};
let unsub = null;

const TYPES = [
  { key: 'mod', label: '模组' },
  { key: 'modpack', label: '整合包' },
];

function targetInstance() {
  return state.instances.find((i) => i.id === state.settings.lastInstanceId) || state.instances[0] || null;
}

function instanceGameVersion() {
  const i = targetInstance();
  return i?.versionId || '';
}
function instanceLoader() {
  const i = targetInstance();
  const t = i?.loader?.type;
  if (!t || t === 'vanilla') return '';
  return t === 'neoforge' ? 'neoforge' : t;
}

async function search() {
  q.loading = true;
  q.error = null;
  const rid = ++q.requestId;
  renderList();
  try {
    const params = new URLSearchParams({
      query: q.query, type: q.type, offset: String(q.offset), limit: String(q.limit), index: 'relevance',
    });
    if (q.gameVersion) params.set('gameVersion', q.gameVersion);
    if (q.loader && (q.type === 'mod' || q.type === 'modpack')) params.set('loader', q.loader);
    if (q.category) params.set('categories', q.category);
    const r = await api('/api/mods/search?' + params.toString());
    if (rid !== q.requestId) return;
    q.results = r;
  } catch (e) {
    if (rid !== q.requestId) return;
    q.error = e.message;
    q.results = null;
  } finally {
    if (rid === q.requestId) { q.loading = false; renderList(); }
  }
}

function topBar() {
  const searchInput = h('input', {
    class: 'input', placeholder: '搜索 Modrinth 模组、光影、整合包…', value: q.query,
    onkeydown: (e) => { if (e.key === 'Enter') { q.offset = 0; search(); } },
    oninput: (e) => {
      q.query = e.target.value;
      if (/^him$/i.test(q.query.trim())) window.dispatchEvent(new Event('craftdeck:herobrine'));
    },
  });
  const typeTabs = h('div', { class: 'tabs' }, TYPES.map((t) => h('button', {
    class: `tab ${q.type === t.key ? 'active' : ''}`,
    onclick: () => { q.type = t.key; q.offset = 0; search(); renderPage(); },
  }, t.label)));
  const CATS = [['', '全部类型'], ['optimization', '优化'], ['adventure', '冒险'], ['decoration', '装饰'], ['technology', '科技'], ['magic', '魔法'], ['utility', '实用'], ['library', '前置库'], ['worldgen', '地形'], ['food', '食物'], ['mobs', '生物'], ['equipment', '装备']];
  return h('div', { class: 'panel', style: { padding: '14px' } }, [
    h('div', { class: 'filter-bar', style: { marginTop: '0' } }, [
      typeTabs,
      h('div', { class: 'search-bar grow' }, searchInput),
      h('button', { class: 'btn btn-primary', onclick: () => { q.offset = 0; search(); } }, '搜索'),
      h('button', { class: 'btn', html: `${icon('undo', 14)}<span>还原</span>`, onclick: () => { q.query = ''; q.gameVersion = ''; q.loader = ''; q.category = ''; q.offset = 0; renderPage(); search(); } }),
    ]),
    h('div', { class: 'row', style: { marginTop: '10px', gap: '10px', flexWrap: 'wrap' } }, [
      h('select', {
        class: 'select', style: { width: '160px' }, onchange: (e) => { q.gameVersion = e.target.value; q.offset = 0; search(); },
      }, [
        h('option', { value: '' }, '全部游戏版本'),
        ...(state.versions.versions || []).filter((v) => v.type === 'release').slice(0, 60).map((v) =>
          h('option', { value: v.id, selected: v.id === q.gameVersion }, v.id)),
      ]),
      h('select', {
        class: 'select', style: { width: '150px' }, onchange: (e) => { q.loader = e.target.value; q.offset = 0; search(); },
      }, [
        h('option', { value: '' }, '全部加载器'),
        ...[['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['quilt', 'Quilt']].map(([k, l]) =>
          h('option', { value: k, selected: k === q.loader }, l)),
      ]),
      h('select', {
        class: 'select', style: { width: '140px' }, onchange: (e) => { q.category = e.target.value; q.offset = 0; search(); },
      }, CATS.map(([k, l]) => h('option', { value: k, selected: k === q.category }, l))),
      h('button', {
        class: 'btn btn-sm', onclick: () => { q.gameVersion = instanceGameVersion(); q.loader = instanceLoader(); q.offset = 0; search(); renderPage(); },
        title: '使用当前实例的版本与加载器',
      }, '匹配当前实例'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted small' }, '来源：Modrinth'),
    ]),
  ]);
}

function resultCard(hit) {
  const isPack = hit.project_type === 'modpack';
  return h('div', { class: 'mod-card' }, [
    iconImg(hit.icon_url, isPack ? '▤' : '✦'),
    h('div', { class: 'mod-main' }, [
      h('div', { class: 'mod-title' }, [
        h('span', { class: 'ellipsis' }, showName(hit)),
        zhModName(hit) && state.settings.translateModNames !== false
          ? h('span', { class: 'muted small' }, hit.title)
          : (hit.author ? h('span', { class: 'muted small' }, 'by ' + hit.author) : null),
      ]),
      h('div', { class: 'mod-desc' }, cleanMotd(hit.description)),
      h('div', { class: 'mod-meta' }, [
        h('span', {}, '⬇ ' + fmtNum(hit.downloads || 0)),
        h('span', {}, '♥ ' + fmtNum(hit.follows || 0)),
        ...(hit.categories || []).slice(0, 3).map((c) => h('span', { class: 'chip' }, c)),
      ]),
      h('div', { class: 'mod-foot' }, [
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => openInstallModal(hit) }, isPack ? '安装整合包' : '安装'),
        h('button', { class: 'btn btn-sm', onclick: () => openAllVersions(hit) }, '全部版本'),
        h('button', { class: 'btn btn-sm', onclick: () => openDetail(hit) }, '详情'),
      ]),
    ]),
  ]);
}

function renderList() {
  if (!view) return;
  const listEl = view.querySelector('#mod-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (q.loading) { listEl.append(skeletonCards(9, 118)); return; }
  if (q.error) {
    listEl.append(h('div', { class: 'panel' }, [
      h('div', { class: 'panel-title' }, '搜索失败'),
      h('p', { class: 'dim', style: { margin: '8px 0' } }, q.error),
      h('button', { class: 'btn btn-primary', onclick: search }, '重试'),
    ]));
    return;
  }
  const hits = q.results?.hits || [];
  if (!hits.length) { listEl.append(emptyState({ icon: '✦', title: '没有找到结果', sub: '换个关键词，或清除版本 / 加载器筛选' })); return; }
  listEl.append(h('div', { class: 'mod-grid' }, hits.map(resultCard)));
  const total = q.results.total_hits || 0;
  const page = Math.floor(q.offset / q.limit) + 1;
  const pages = Math.max(1, Math.ceil(total / q.limit));
  listEl.append(h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '16px', gap: '10px' } }, [
    h('button', { class: 'btn btn-sm', disabled: q.offset === 0, onclick: () => { q.offset = Math.max(0, q.offset - q.limit); search(); } }, '上一页'),
    h('span', { class: 'muted small' }, `第 ${page} / ${pages} 页 · 共 ${fmtNum(total)} 个结果`),
    h('button', { class: 'btn btn-sm', disabled: q.offset + q.limit >= total, onclick: () => { q.offset += q.limit; search(); } }, '下一页'),
  ]));
}

function renderPage() {
  if (!view) return;
  view.innerHTML = '';
  view.append(h('div', { class: 'home' }, [
    topBar(),
    h('div', { id: 'mod-list' }),
  ]));
  renderList();
}

/* ---------- 详情 ---------- */
async function openMcmod(name) {
  const fallback = `https://search.mcmod.cn/s?key=${encodeURIComponent(name)}`;
  try {
    const r = await api('/api/mcmod/search?q=' + encodeURIComponent(name));
    const url = r.url || fallback;
    if (window.desktopWindow?.openExternal) window.desktopWindow.openExternal(url);
    else window.open(url, '_blank');
  } catch {
    if (window.desktopWindow?.openExternal) window.desktopWindow.openExternal(fallback);
    else window.open(fallback, '_blank');
  }
}

async function openDetail(hit) {
  const m = modal({
    title: showName(hit),
    wide: true,
    body: loadingBlock('正在加载项目详情…'),
    actions: [
      { label: '全部版本', onClick: () => openAllVersions(hit) },
      { label: '关闭', kind: 'primary' },
    ],
  });
  const siteUrl = hit.website_url || `https://modrinth.com/mod/${hit.slug}`;
  const siteLink = h('a', { class: 'btn btn-sm', href: siteUrl, target: '_blank', rel: 'noreferrer' }, '打开原站下载页');
  const mcmodLink = h('button', { class: 'btn btn-sm', onclick: () => openMcmod(hit.title) }, 'MC百科');
  try {
    const p = await api(`/api/mods/project/${hit.project_id || hit.slug}`);
    const mcmod = await api('/api/mcmod/search?q=' + encodeURIComponent(hit.title || hit.slug)).catch(() => null);
    const mcmodCard = mcmod?.found ? h('div', { class: 'mcmod-box' }, [
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [badge('MC百科', 'ok'), h('span', { class: 'muted small' }, '中文资料优先')]),
      h('div', { class: 'mcmod-title' }, mcmod.title),
      h('div', { class: 'hint', style: { lineHeight: '1.7', marginTop: '4px' } }, mcmod.description || '暂无摘要'),
      h('button', { class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: () => {
        if (window.desktopWindow?.openExternal) window.desktopWindow.openExternal(mcmod.url);
        else window.open(mcmod.url, '_blank', 'noopener');
      } }, '打开 MC百科'),
    ]) : null;
    if (mcmodCard) {
      const titleEl = m.el.querySelector('.modal-title');
      if (titleEl && mcmod.title) titleEl.textContent = mcmod.title;
    }
    const body = [
      mcmodCard,
      h('div', { class: 'row', style: { gap: '14px', alignItems: 'flex-start' } }, [
        iconImg(p.icon_url, '✦', 'mod-icon'),
        h('div', { class: 'grow' }, [
          h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
            badge(p.project_type === 'modpack' ? '整合包' : '模组', 'accent'),
            ...(p.loaders || []).map((l) => badge(l)),
            badge('⬇ ' + fmtNum(p.downloads || 0)),
          ]),
          h('p', { class: 'dim', style: { marginTop: '8px', lineHeight: '1.6' } }, `原始简介：${cleanMotd(p.description)}`),
        ]),
      ]),
      h('div', { class: 'chip-row' }, (p.categories || []).map((c) => h('span', { class: 'chip' }, c))),
      h('div', { class: 'divider' }),
      h('div', { style: { fontSize: '12.5px', lineHeight: '1.75', color: 'var(--text-dim)', maxHeight: '320px', overflow: 'auto' } },
        (p.body || '').slice(0, 12000)),
      h('div', { class: 'row', style: { marginTop: '10px' } }, [siteLink, mcmodLink]),
    ].filter(Boolean);
    m.el.querySelector('.modal-body').innerHTML = '';
    m.el.querySelector('.modal-body').append(...body);
  } catch (e) {
    m.el.querySelector('.modal-body').innerHTML = '';
    m.el.querySelector('.modal-body').append(h('div', { class: 'callout err' }, e.message));
  }
}

/* ---------- 安装 ---------- */
async function openAllVersions(hit) {
  const body = h('div', {}, loadingBlock('正在获取全部版本…'));
  const m = modal({
    title: '全部版本 · ' + showName(hit),
    wide: true,
    body: [h('div', { class: 'hint', style: { marginBottom: '8px' } }, '不要求先创建实例；可以只下载到本地，也可以选启动项安装。'), body],
    actions: [{ label: '关闭', kind: 'primary' }],
  });
  try {
    const r = await api(`/api/mods/versions/${hit.project_id || hit.slug}`);
    const versions = Array.isArray(r) ? r : (r.versions || []);
    if (!versions.length) { body.replaceChildren(h('div', { class: 'callout warn' }, '没有可用版本。')); return; }
    const loaders = [...new Set(versions.flatMap((v) => v.loaders || []))];
    let active = loaders[0] || '';
    const target = h('select', { class: 'select' }, [
      ...state.instances.map((i) => h('option', { value: i.id, selected: i.id === (state.settings.lastInstanceId || state.instances[0]?.id) }, `${i.name}${i.versionId ? ' · ' + i.versionId : ''}`)),
      h('option', { value: '' }, '仅下载（不安装）'),
    ]);
    const list = h('div', { class: 'list', style: { maxHeight: '420px', overflow: 'auto' } });
    const tabs = h('div', { class: 'tabs' }, [
      h('button', { class: 'tab active', onclick: (e) => { active = ''; for (const b of tabs.children) b.classList.toggle('active', b === e.currentTarget); draw(); } }, '全部'),
      ...loaders.map((ld) => h('button', { class: 'tab', onclick: (e) => { active = ld; for (const b of tabs.children) b.classList.toggle('active', b === e.currentTarget); draw(); } }, ld)),
    ]);
    const draw = () => {
      const arr = active ? versions.filter((v) => (v.loaders || []).includes(active)) : versions;
      list.replaceChildren(...arr.slice(0, 200).map((v) => h('div', { class: 'list-item' }, [
        h('div', { class: 'li-main' }, [
          h('div', { class: 'li-title' }, v.version_number || v.name),
          h('div', { class: 'li-sub' }, `${(v.game_versions || []).slice(-6).join(', ')} · ${(v.loaders || []).join(', ')}${v.files?.[0]?.filename ? ' · ' + v.files[0].filename : ''}`),
        ]),
        h('button', {
          class: 'btn btn-sm', onclick: async (e) => {
            try {
              e.currentTarget.disabled = true; e.currentTarget.textContent = '下载中…';
              await api('/api/mods/download', { method: 'POST', body: { projectId: hit.project_id || hit.slug, versionId: v.id } });
              toastOk('已下载', v.version_number || v.name);
            } catch (err) { toastErr('下载失败', err.message); }
            finally { e.currentTarget.disabled = false; e.currentTarget.textContent = '下载'; }
          },
        }, '下载'),
        h('button', {
          class: 'btn btn-sm btn-primary', disabled: !target.value, onclick: async (e) => {
            if (!target.value) { toastErr('请选择启动项', '先在上方选择要安装到的启动项'); return; }
            try {
              e.currentTarget.disabled = true; e.currentTarget.textContent = '安装中…';
              await api('/api/mods/install', { method: 'POST', body: { projectId: hit.project_id || hit.slug, versionId: v.id, instanceId: target.value, gameVersion: (v.game_versions || [])[0] || '', loader: (v.loaders || [])[0] || '', withDependencies: false } });
              toastOk('安装完成', showName(hit));
            } catch (err) { toastErr('安装失败', err.message); }
            finally { e.currentTarget.disabled = false; e.currentTarget.textContent = '安装'; }
          },
        }, '安装'),
      ])));
    };
    target.addEventListener('change', draw);
    body.replaceChildren(
      h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, [
        tabs,
        h('div', { class: 'row' }, [
          h('span', { class: 'small muted' }, '安装到：'), target,
          h('a', { class: 'btn btn-sm', href: hit.website_url || `https://modrinth.com/mod/${hit.slug}`, target: '_blank', rel: 'noreferrer' }, '原站'),
        ]),
      ]),
      list,
    );
    draw();
  } catch (e) {
    body.replaceChildren(h('div', { class: 'callout err' }, '获取版本失败：' + e.message));
  }
  return m;
}

async function openInstallModal(hit) {
  if (hit.project_type === 'modpack') {
    return installModpack(hit);
  }
  const inst = targetInstance();
  let acc = instanceGameVersion();
  const verList = h('div', { class: 'vp-list' }, loadingBlock('正在获取可用版本…'));
  const targetSelect = h('select', { class: 'select' }, state.instances.map((i) =>
    h('option', { value: i.id, selected: i.id === inst?.id }, `${i.name}${i.versionId ? ' · ' + i.versionId : ''}`)));
  const includeDeps = h('input', { type: 'checkbox', checked: true });
  const status = h('div', { class: 'hint' });
  let pickedVersionId = null;
  let versions = [];

  const selectedInstance = () => state.instances.find((i) => i.id === targetSelect.value) || null;
  const selectedLoader = () => {
    const t = selectedInstance()?.loader?.type;
    return t && t !== 'vanilla' ? t : '';
  };

  const loadVersions = async () => {
    acc = selectedInstance()?.versionId || '';
    verList.innerHTML = '';
    verList.append(loadingBlock('正在获取可用版本…'));
    try {
      versions = await api(`/api/mods/versions/${hit.project_id || hit.slug}?gameVersion=${encodeURIComponent(acc)}&loader=${encodeURIComponent(selectedLoader())}`);
      verList.innerHTML = '';
      if (!versions.length) {
        verList.append(h('div', { class: 'callout warn' }, `没有找到${acc ? '适配 ' + acc : ''}${selectedLoader() ? ' / ' + selectedLoader() : ''}的文件，可以换一个启动项。`));
        return;
      }
      for (const v of versions.slice(0, 40)) {
        const row = h('div', {
          class: 'ver-row', style: { padding: '8px 12px' },
          onclick: () => {
            pickedVersionId = v.id;
            for (const c of verList.children) c.classList.remove('selected');
            row.classList.add('selected');
          },
        }, [
          h('div', { class: 'grow' }, [
            h('div', { style: { fontSize: '12.5px', fontWeight: '600' } }, v.name || v.version_number),
            h('div', { class: 'small muted' }, [
              (v.version_type === 'release' ? '正式版' : v.version_type === 'beta' ? 'Beta' : 'Alpha'),
              ' · ' + (v.game_versions || []).slice(-3).join(', '),
              ' · ' + (v.loaders || []).join(', '),
              ' · ' + fmtRelative(new Date(v.date_published).getTime()),
              v.files?.[0] ? ' · ' + v.files[0].filename.slice(0, 46) : '',
            ].join('')),
          ]),
          h('div', { class: 'row' }, [
            badge('⬇ ' + fmtNum(v.downloads || 0)),
            (v.dependencies || []).length ? badge('前置 ' + v.dependencies.length, 'violet') : null,
          ]),
        ]);
        verList.append(row);
      }
      pickedVersionId = versions[0].id;
      verList.firstChild.classList.add('selected');
      status.textContent = `共 ${versions.length} 个可用文件；默认选择最新版本。`;
    } catch (e) {
      verList.innerHTML = '';
      verList.append(h('div', { class: 'callout err' }, '获取版本失败：' + e.message));
    }
  };

  targetSelect.addEventListener('change', loadVersions);

  const m = modal({
    title: '安装 · ' + showName(hit),
    wide: true,
    body: [
      state.instances.length
        ? h('div', { class: 'field' }, [h('label', {}, '安装到启动项'), targetSelect])
        : h('div', { class: 'callout warn' }, '还没有启动项，请先到「下载 → 游戏版本」安装一个版本。'),
      h('label', { class: 'check' }, [includeDeps, '自动安装必需的前置模组（推荐）']),
      h('div', { class: 'field' }, [h('label', {}, '选择文件版本'), verList]),
      status,
    ],
    actions: [
      { label: '取消' },
      {
        label: '安装', kind: 'primary',
        onClick: async () => {
          if (!pickedVersionId) { toastErr('请选择版本', '在上面的列表中选择一个文件'); return false; }
          if (!targetSelect.value) { toastErr('没有启动项', '请先到「下载 → 游戏版本」安装版本'); return false; }
          try {
            status.textContent = '正在下载安装…';
            await api('/api/mods/install', {
              method: 'POST',
              body: {
                projectId: hit.project_id || hit.slug,
                versionId: pickedVersionId,
                instanceId: targetSelect.value,
                gameVersion: acc || undefined,
                loader: selectedLoader() || undefined,
                withDependencies: includeDeps.checked,
              },
            });
            toastOk('安装完成', showName(hit));
            return undefined;
          } catch (e) {
            toastErr('安装失败', e.message);
            status.textContent = '安装失败：' + e.message;
            return false;
          }
        },
      },
    ],
  });

  await loadVersions();
  return m;
}

async function installModpack(hit) {
  if (!state.instances.length) { toastErr('没有实例', '请先在实例页创建实例'); return; }
  const instSelect = h('select', { class: 'select' }, state.instances.map((i) =>
    h('option', { value: i.id, selected: i.id === state.settings.lastInstanceId }, `${i.name}${i.versionId ? ' · ' + i.versionId : ''}`)));
  const status = h('div', { class: 'hint' }, '整合包会创建新实例并自动安装所需的加载器与模组，请耐心等待。');
  modal({
    title: '安装整合包 · ' + hit.title,
    body: [
      h('div', { class: 'callout info' }, '整合包安装会新建独立实例，不会影响现有实例。'),
      h('div', { class: 'field' }, [h('label', {}, '创建到已有实例（可选）'), h('div', { class: 'hint' }, '默认会新建实例；如需覆盖现有实例请选择。'), instSelect]),
      status,
    ],
    actions: [
      { label: '取消' },
      {
        label: '安装整合包', kind: 'primary', keepOpen: true,
        onClick: async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = '正在安装…';
          status.textContent = '正在下载整合包文件…';
          try {
            const r = await api('/api/modpacks/install-project', {
              method: 'POST',
              body: { projectId: hit.project_id || hit.slug, instanceId: instSelect.value || null, name: hit.title },
            });
            toastOk('整合包安装完成', r.name || hit.title);
            ev.target.closest('.modal-backdrop')?.remove();
          } catch (e) {
            status.textContent = '安装失败：' + e.message;
            ev.target.disabled = false;
            ev.target.textContent = '安装整合包';
          }
        },
      },
    ],
  });
}

export default {
  async render(el, ctx) {
    view = el;
    ctxRef = ctx;
    if (ctx?.param) { q.query = String(ctx.param); q.offset = 0; q.results = null; }
    if (!state.versions.versions?.length) {
      try {
        const r = await api('/api/versions');
        state.versions = { latest: r.latest, versions: r.versions || [], fetchedAt: r.fetchedAt };
      } catch { /* ignore */ }
    }
    renderPage();
    if (!q.results) search();

    unsub = subscribe((evt) => {
      if (evt.type === 'sse' && evt.evt.type === 'progress' && evt.evt.finished && ['mods', 'modpack'].includes(evt.evt.scope)) {
        // no-op; toast already shown
      }
    });
  },
  destroy() {
    if (unsub) unsub();
    unsub = null; view = null; ctxRef = null;
  },
};
