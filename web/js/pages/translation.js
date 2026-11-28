/* 汉化页：一键汉化当前实例与汉化资源包列表 */
import { h, badge, toastOk, toastErr, toastWarn, emptyState, loadingBlock, sectionTitle } from '../ui.js';
import { state, api, patchSettings } from '../state.js';

const SOURCE = { github: ['GitHub', 'accent'], modrinth: ['Modrinth', 'violet'], static: ['内置', ''] };
let alive = true;

function callout(kind, text, icon = 'i', extra = null) {
  return h('div', { class: `callout ${kind}`, style: { alignItems: 'center' } }, [
    h('span', { class: 'c-icon' }, icon), h('div', { class: 'grow' }, text), extra,
  ]);
}

function pickPacks(data) {
  if (Array.isArray(data)) return data;
  for (const k of ['packs', 'list', 'items']) if (Array.isArray(data && data[k])) return data[k];
  return [];
}

function describeAuto(r) {
  if (!r || typeof r !== 'object') return '没有返回结果';
  const packs = Array.isArray(r.packs) ? r.packs : [];
  const names = packs.map((p) => p && (p.name || p.fileName)).filter(Boolean).join('、');
  const parts = [];
  if (r.installed) parts.push(names ? `已安装：${names}` : '汉化资源包安装完成');
  else parts.push(r.reason || '没有需要处理的内容');
  if (r.modCount !== undefined) parts.push(`扫描到 ${Number(r.modCount) || 0} 个模组`);
  if (r.langChanged) parts.push('游戏语言已设置为简体中文');
  if (r.gameVersion) parts.push(`游戏版本 ${r.gameVersion}`);
  return parts.join(' · ');
}

function packRow(pack, getInstanceId, hasInstance) {
  const src = SOURCE[pack.source] || [pack.source || '未知', ''];
  const versions = Array.isArray(pack.gameVersions) ? pack.gameVersions : [];
  const named = versions.filter((v) => v && v !== 'all');
  const extra = named.slice(0, 5);
  const home = /^https?:\/\//i.test(String(pack.homepage || '')) ? String(pack.homepage) : null;

  const installBtn = h('button', {
    class: 'btn btn-sm btn-primary',
    disabled: !hasInstance,
    onclick: async (ev) => {
      const btn = ev.currentTarget;
      if (btn.disabled) return;
      const instanceId = getInstanceId();
      if (!instanceId) { toastErr('没有可用实例', '请先在「实例」页创建并进入一个游戏实例'); return; }
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = '安装中…';
      try {
        const r = await api('/api/translation/install', { method: 'POST', body: { packId: pack.id, instanceId } });
        toastOk('汉化资源包已安装', `${(r && r.name) || pack.name || pack.id}${r && r.path ? ' → ' + r.path : ''}`);
        if (btn.isConnected) { btn.disabled = false; btn.textContent = '重新安装'; }
      } catch (e) {
        toastErr('安装汉化资源包失败', e.message);
        btn.disabled = false; btn.textContent = label;
      }
    },
  }, '安装到当前实例');

  const chips = [
    versions.includes('all') ? h('span', { class: 'chip' }, '全部版本') : null,
    ...extra.map((v) => h('span', { class: 'chip' }, v)),
    named.length > extra.length ? h('span', { class: 'chip' }, `+${named.length - extra.length}`) : null,
    pack.version ? h('span', { class: 'chip' }, String(pack.version)) : null,
  ].filter(Boolean);

  return h('div', { class: 'pack-mini' }, [
    h('div', { class: 'mod-icon', style: { width: '44px', height: '44px', fontSize: '18px' } }, '文'),
    h('div', { class: 'grow' }, [
      h('div', { class: 'row', style: { gap: '7px', flexWrap: 'wrap' } }, [
        h('span', { style: { fontWeight: '700', fontSize: '13.5px' } }, pack.name || pack.id || '未命名汉化包'),
        badge(src[0], src[1]),
        pack.recommended ? badge('推荐', 'accent') : null,
        pack.type === 'mod' ? badge('模组汉化', 'warn') : null,
      ]),
      pack.description ? h('div', { class: 'hint', style: { marginTop: '4px', lineHeight: '1.55' } }, pack.description) : null,
      chips.length ? h('div', { class: 'chip-row', style: { marginTop: '6px' } }, chips) : null,
    ]),
    h('div', { class: 'row', style: { gap: '6px', flexShrink: '0' } }, [
      home ? h('a', { class: 'btn btn-sm btn-ghost', href: home, target: '_blank', rel: 'noreferrer noopener' }, '主页') : null,
      installBtn,
    ]),
  ]);
}

async function render(view, ctx) {
  alive = true;
  view.replaceChildren(loadingBlock('正在读取汉化资源包…'));
  let packs = [];
  let loadError = null;
  try { packs = pickPacks(await api('/api/translation/packs')); } catch (e) { loadError = e; }
  if (!alive) return;
  if (loadError) toastErr('读取汉化资源包失败', (loadError && loadError.message) || '未知错误');

  const instances = Array.isArray(state.instances) ? state.instances : [];
  const saved = state.settings.lastInstanceId;
  let selectedId = instances.some((i) => i.id === saved) ? saved : (instances[0] && instances[0].id) || null;

  const resultBox = h('div', { style: { display: 'none' } });
  const showResult = (kind, text) => {
    resultBox.replaceChildren(callout(kind, text, kind === 'ok' ? '✓' : kind === 'err' ? '✕' : 'i'));
    resultBox.style.display = '';
  };

  const select = h('select', {
    class: 'select', style: { width: '250px', maxWidth: '100%' }, disabled: !instances.length,
    onchange: async () => {
      const prev = selectedId;
      selectedId = select.value || null;
      select.disabled = true;
      try {
        await patchSettings({ lastInstanceId: selectedId });
      } catch (e) {
        selectedId = prev;
        select.value = prev || '';
        toastErr('切换实例失败', e.message);
      } finally {
        select.disabled = false;
      }
    },
  }, instances.length
    ? instances.map((i) => h('option', { value: i.id, selected: i.id === selectedId },
      `${i.name || i.id}${i.versionId ? ` · ${i.versionId}` : ''}`))
    : [h('option', { value: '' }, '（暂无实例）')]);

  const autoBtn = h('button', {
    class: 'btn btn-primary btn-lg', disabled: !selectedId,
    onclick: async (ev) => {
      const btn = ev.currentTarget;
      if (btn.disabled) return;
      if (!selectedId) { toastErr('没有可用实例', '请先在「实例」页创建实例'); return; }
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = '正在汉化…';
      showResult('info', '正在扫描实例模组并准备汉化资源包，请稍候…');
      try {
        const r = await api('/api/translation/auto', { method: 'POST', body: { instanceId: selectedId } });
        if (!alive) return;
        const text = describeAuto(r);
        if (r && r.installed) {
          toastOk('一键汉化完成', text);
          showResult('ok', text);
        } else {
          const reason = String((r && r.reason) || '');
          const failed = /失败|错误/.test(reason);
          toastWarn(failed ? '一键汉化未完成' : '没有需要汉化的内容', reason || text);
          showResult(failed ? 'err' : 'info', text);
        }
      } catch (e) {
        if (alive) {
          showResult('err', '一键汉化失败：' + e.message);
          toastErr('一键汉化失败', e.message);
        }
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    },
  }, '一键汉化当前实例');

  const hero = h('div', { class: 'trans-hero', style: { flexWrap: 'wrap' } }, [
    h('div', { class: 'hero-icon', style: { width: '64px', height: '64px', fontSize: '28px' } }, '文'),
    h('div', { class: 'grow', style: { minWidth: '240px' } }, [
      h('div', { class: 'hero-title', style: { fontSize: '20px' } }, '模组汉化'),
      h('div', { class: 'hero-sub' }, '把 CFPA、VM 汉化组等公开汉化资源包安装到当前实例，并把游戏语言设为简体中文。'),
      h('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        h('span', { class: 'hint' }, '目标实例'), select,
      ]),
    ]),
    h('div', { class: 'hero-actions' }, [autoBtn]),
  ]);

  const retry = h('button', { class: 'btn', onclick: (ev) => { ev.currentTarget.disabled = true; ctx.refresh(); } }, '重试');
  const listWrap = loadError
    ? h('div', { class: 'panel' }, emptyState({ icon: '!', title: '无法读取汉化资源包列表', sub: (loadError && loadError.message) || '未知错误', action: retry }))
    : packs.length
      ? h('div', { class: 'col', style: { gap: '10px' } }, packs.map((p) => packRow(p, () => selectedId, instances.length > 0)))
      : h('div', { class: 'panel' }, emptyState({
        icon: '文', title: '暂时没有可用的汉化包',
        sub: '后端可能暂时无法访问 GitHub / Modrinth，请稍后重试。', action: retry,
      }));

  view.replaceChildren(h('div', { class: 'home' }, [
    hero,
    resultBox,
    !instances.length
      ? callout('info', '当前还没有游戏实例。请先在「实例」页创建实例，然后再回来安装汉化资源包。', 'i',
        h('button', { class: 'btn btn-sm', onclick: () => { location.hash = '#/instances'; } }, '去创建实例'))
      : null,
    sectionTitle('汉化资源包', h('div', { class: 'row', style: { gap: '8px' } }, [
      badge(`${packs.length} 个`),
      h('button', { class: 'btn btn-sm', onclick: (ev) => { ev.currentTarget.disabled = true; ctx.refresh(); } }, '刷新列表'),
    ])),
    listWrap,
    callout('info', '汉化资源包会安装到实例的 resourcepacks 目录。安装后请在游戏「选项 → 资源包」中启用，并把语言切换为简体中文。'),
  ].filter(Boolean)));
}

function destroy() { alive = false; }

export default { render, destroy };
