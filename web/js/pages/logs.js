/* ================= 日志查看页 ================= */
import { h, toastOk, toastErr, badge, emptyState, loadingBlock, copyText } from '../ui.js';
import { state, api, loadState } from '../state.js';

let view = null;
let ctxRef = null;
let tab = 'launcher';
let instanceId = null;
let lines = [];
let timer = null;
let auto = true;
let loading = false;

async function loadLines() {
  if (loading) return;
  loading = true;
  try {
    if (tab === 'launcher') {
      const r = await api('/api/logs/file?tail=1200');
      lines = r.lines || [];
    } else {
      const inst = state.instances.find((i) => i.id === instanceId) || state.instances[0];
      if (!inst) { lines = []; }
      else {
        const r = await api(`/api/instances/${inst.id}/log?tail=1200`);
        lines = r.lines || [];
      }
    }
  } catch (e) {
    lines = ['[读取失败] ' + e.message];
  } finally {
    loading = false;
    renderView();
  }
}

function renderView() {
  if (!view) return;
  const pre = view.querySelector('#log-body');
  if (!pre) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent = lines.join('\n') || '（暂无日志，启动游戏或安装内容后这里会出现记录）';
  if (atBottom || auto) pre.scrollTop = pre.scrollHeight;
  const meta = view.querySelector('#log-meta');
  if (meta) meta.textContent = `${lines.length} 行 · ${auto ? '自动刷新 2s' : '已暂停'}`;
}

function toolbar() {
  const tabs = h('div', { class: 'tabs' }, [
    h('button', { class: `tab ${tab === 'launcher' ? 'active' : ''}`, onclick: () => { tab = 'launcher'; lines = []; renderPage(); loadLines(); } }, '启动器日志'),
    h('button', { class: `tab ${tab === 'game' ? 'active' : ''}`, onclick: () => { tab = 'game'; lines = []; renderPage(); loadLines(); } }, '游戏日志'),
  ]);
  const instSelect = tab === 'game'
    ? h('select', {
      class: 'select', style: { width: '200px' },
      onchange: (e) => { instanceId = e.target.value; lines = []; loadLines(); },
    }, state.instances.map((i) => h('option', { value: i.id, selected: i.id === (instanceId || state.instances[0]?.id) }, i.name)))
    : null;
  return h('div', { class: 'log-toolbar' }, [
    tabs,
    instSelect,
    h('button', { class: 'btn btn-sm', onclick: () => { lines = []; loadLines(); } }, '刷新'),
    h('button', { class: 'btn btn-sm', onclick: () => { auto = !auto; renderPage(); } }, auto ? '暂停自动刷新' : '继续自动刷新'),
    h('button', { class: 'btn btn-sm', onclick: () => { navigator.clipboard?.writeText(lines.join('\n')); toastOk('已复制日志'); } }, '复制'),
    h('button', {
      class: 'btn btn-sm',
      onclick: () => {
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `CraftDeck-${tab}-${Date.now()}.log`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      },
    }, '导出'),
    h('div', { class: 'spacer' }),
    h('span', { class: 'muted small', id: 'log-meta' }, ''),
  ]);
}

function renderPage() {
  if (!view) return;
  view.innerHTML = '';
  if (tab === 'game' && !state.instances.length) {
    view.append(emptyState({ icon: '▤', title: '还没有实例', sub: '创建实例并启动游戏后，这里会显示游戏日志。' }));
    return;
  }
  view.append(h('div', { class: 'home log-layout' }, [
    h('div', { class: 'panel', style: { padding: '12px' } }, toolbar()),
    h('div', { class: 'panel log-view', style: { padding: '0', overflow: 'hidden' } },
      h('pre', { class: 'console-body', id: 'log-body' }, lines.join('\n') || '加载中…')),
    h('div', { class: 'hint' }, '游戏日志来自实例目录 launcher-last.log；启动器日志来自 logs/launcher.log。'),
  ]));
  renderView();
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    view.append(loadingBlock('正在读取日志…'));
    if (!state.instances.length) { try { await loadState(); } catch { /* ignore */ } }
    instanceId = instanceId || state.settings.lastInstanceId || state.instances[0]?.id || null;
    lines = [];
    renderPage();
    await loadLines();
    timer = setInterval(() => { if (auto && !document.hidden) loadLines(); }, 2000);
  },
  destroy() {
    if (timer) clearInterval(timer);
    timer = null; view = null; ctxRef = null;
  },
};
