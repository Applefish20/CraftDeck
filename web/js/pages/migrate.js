/* ================= 从其他启动器迁移 ================= */
import { h, toast, toastOk, toastErr, badge, emptyState, loadingBlock, sectionTitle } from '../ui.js';
import { state, api, loadState } from '../state.js';

let view = null;
let ctxRef = null;
let roots = [];
let loading = false;
let manual = '';
let importing = '';

function loaderName(t) {
  return { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', vanilla: '原版' }[t] || t;
}

async function scan(pathQuery = '') {
  if (loading) return;
  loading = true;
  renderPage();
  try {
    const q = pathQuery ? `?path=${encodeURIComponent(pathQuery)}` : '';
    const r = await api('/api/migrate/scan' + q);
    roots = r.roots || [];
    if (!roots.length) toast({ kind: 'info', title: '没有发现可迁移的版本', message: '可以手动填写 .minecraft 文件夹路径再扫描。' });
  } catch (e) {
    toastErr('扫描失败', e.message);
  } finally {
    loading = false;
    renderPage();
  }
}

async function importVersion(v, root) {
  if (importing) return;
  importing = v.id;
  renderPage();
  try {
    const versionId = v.baseVersion || v.id;
    if (!versionId) throw new Error('这个版本没有可用的基础版本号，请手动选择版本');
    const cr = await api('/api/instances', {
      method: 'POST',
      body: {
        name: v.name || v.id,
        versionId,
        loader: { type: v.loader, version: null },
        accountId: state.settings.lastAccountId || null,
      },
    });
    const inst = cr.instance;
    // 后台安装对应版本与加载器；即使下载失败也先把内容迁移过来。
    let setupError = '';
    try {
      await api(`/api/instances/${inst.id}/setup`, {
        method: 'POST',
        body: { versionId, loader: v.loader, loaderVersion: v.loaderVersion || null },
      });
    } catch (e) { setupError = e.message; }
    const copy = await api('/api/migrate/import', {
      method: 'POST',
      body: { instanceId: inst.id, root, sourceDir: v.sourceDir },
    });
    if (setupError) {
      toast({ kind: 'warn', title: '内容已迁移，但游戏文件安装失败', message: setupError + '\n可到实例「内容 → 概览」重新安装版本。', timeout: 8000 });
    } else {
      toastOk('已迁移到本启动器', `${v.name} · 复制 ${copy.files} 个文件（${copy.copied.join('、') || '无额外内容'}）`);
    }
    await loadState();
    importing = '';
    location.hash = '#/instances';
  } catch (e) {
    importing = '';
    renderPage();
    toastErr('迁移失败', e.message);
  }
}

function versionRow(v, root) {
  return h('div', { class: 'list-item' }, [
    h('div', { class: 'inst-icon', style: { width: '38px', height: '38px', fontSize: '17px', margin: '0' } }, '▦'),
    h('div', { class: 'li-main' }, [
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [
        h('div', { class: 'li-title ellipsis' }, v.name || v.id),
        badge(loaderName(v.loader), v.loader === 'vanilla' ? '' : 'violet'),
        v.isolated ? badge('版本隔离', 'accent') : null,
        v.loaderVersion ? badge(v.loaderVersion) : null,
      ]),
      h('div', { class: 'li-sub ellipsis' }, `${v.baseVersion} · ${v.mods} 个 Mod · ${v.versionDir}`),
    ]),
    h('button', {
      class: 'btn btn-sm btn-primary',
      disabled: !!importing,
      onclick: () => importVersion(v, root),
    }, importing === v.id ? '迁移中…' : '一键迁移'),
  ]);
}

function renderPage() {
  if (!view) return;
  view.innerHTML = '';
  view.append(h('div', { class: 'home' }, [
    h('div', { class: 'panel', style: { padding: '14px' } }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, [
        h('div', {}, [
          h('div', { class: 'panel-title' }, '从 PCL / HMCL / 官方启动器迁移'),
          h('div', { class: 'hint' }, '会扫描常见的 .minecraft 目录，读取版本、加载器和 mods/config/存档/光影，并在本启动器创建新实例。不会修改原目录。'),
        ]),
        h('div', { class: 'row' }, [
          h('input', {
            class: 'input', style: { width: '320px' }, placeholder: '手动填写 .minecraft 路径（可选）',
            value: manual, oninput: (e) => { manual = e.target.value; },
          }),
          h('button', { class: 'btn', disabled: loading, onclick: () => scan(manual.trim()) }, loading ? '扫描中…' : '扫描'),
          h('button', { class: 'btn btn-primary', disabled: loading, onclick: () => scan('') }, '自动扫描'),
        ]),
      ]),
    ]),
    loading ? h('div', { class: 'panel', style: { padding: '20px' } }, loadingBlock('正在扫描其他启动器…'))
      : roots.length
        ? roots.map((r) => h('div', { class: 'panel' }, [
          h('div', { class: 'panel-head' }, [
            h('div', { class: 'panel-title' }, r.label),
            h('span', { class: 'muted small ellipsis' }, r.root),
            h('div', { class: 'spacer' }),
            badge(`${r.versions.length} 个版本`, 'accent'),
          ]),
          h('div', { class: 'list' }, r.versions.map((v) => versionRow(v, r.root))),
        ]))
        : emptyState({
          icon: '⇄',
          title: '还没有扫描到可迁移的版本',
          sub: '点击「自动扫描」，或手动填写其他启动器的 .minecraft 路径。PCL/HMCL 默认在 %APPDATA%\\.minecraft。',
          action: h('button', { class: 'btn btn-primary', onclick: () => scan('') }, '自动扫描'),
        }),
    h('div', { class: 'hint' }, '迁移会安装对应的原版/加载器，并复制 mods、config、resourcepacks、shaderpacks、saves、options.txt 等；账户令牌不会迁移，请在账户页重新登录。'),
  ]));
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    view.append(loadingBlock('正在读取…'));
    if (!state.instances.length) { try { await loadState(); } catch { /* ignore */ } }
    if (!roots.length) scan('');
    else renderPage();
  },
  destroy() { view = null; ctxRef = null; },
};
