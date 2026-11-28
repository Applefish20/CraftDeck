/* ================= 服务器列表页（联机） ================= */
import {
  h, toast, toastOk, toastErr, badge, emptyState, fmtNum, modal, confirmDialog, promptDialog, cleanMotd, loadingBlock,
} from '../ui.js';
import { state, api, loadState, subscribe } from '../state.js';
import { icon } from '../icons.js';

let view = null;
let ctxRef = null;
let pings = new Map(); // id -> {loading, status}
let lanWorlds = null;
let lanLoading = false;
let unsub = null;

function targetInstance() {
  return state.instances.find((i) => i.id === state.settings.lastInstanceId) || state.instances[0] || null;
}

function pingBars(latency) {
  if (!Number.isFinite(latency)) return null;
  const cls = latency < 80 ? 'good' : latency < 250 ? 'mid' : 'bad';
  return h('span', { class: 'ping-bar' }, [
    h('span', { class: `ping-bars ${cls}` }, [h('i'), h('i'), h('i'), h('i')]),
    h('span', {}, latency + ' ms'),
  ]);
}

async function pingServer(entry, force = false) {
  if (!force && pings.get(entry.id)?.status) return;
  pings.set(entry.id, { loading: true, status: pings.get(entry.id)?.status || null });
  renderList();
  try {
    const r = await api(`/api/servers/${entry.id}/ping`);
    pings.set(entry.id, { loading: false, status: r });
  } catch (e) {
    pings.set(entry.id, { loading: false, status: { online: false, error: e.message } });
  }
  renderList();
}

async function pingAll() {
  const list = [...state.servers];
  const workers = Array.from({ length: Math.min(5, list.length) }, async () => {
    while (list.length) {
      const s = list.shift();
      await pingServer(s, true);
    }
  });
  await Promise.all(workers);
  renderList();
}

function serverCard(entry) {
  const p = pings.get(entry.id) || {};
  const st = p.status;
  const running = state.running.length > 0;
  const inst = targetInstance();
  return h('div', { class: 'srv-card' }, [
    h('div', { class: 'srv-icon' }, st?.icon ? h('img', { src: st.icon, alt: '' }) : '◎'),
    h('div', { class: 'srv-main' }, [
      h('div', { class: 'srv-name' }, [
        h('span', { class: 'ellipsis' }, entry.name),
        st ? (st.online ? badge('在线', 'ok') : badge('离线', 'err')) : badge(p.loading ? '检测中…' : '未检测'),
      ]),
      h('div', { class: 'srv-addr' }, `${entry.address}${entry.port && entry.port !== 25565 ? ':' + entry.port : ''}`),
      h('div', { class: 'srv-motd' }, st?.online ? cleanMotd(st.motd) || '—' : (st?.error ? '无法连接：' + st.error : entry.notes || '点击右侧「检测」获取状态')),
      h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
        st?.online ? h('span', { class: 'srv-players' }, `👥 ${st.players?.online ?? 0} / ${st.players?.max ?? 0}`) : null,
        st?.online && st.version?.name ? badge(st.version.name) : null,
        st?.online ? pingBars(st.latencyMs) : null,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm btn-primary', disabled: !inst || running, title: running ? '游戏已在运行' : '启动游戏并直接进入服务器', onclick: () => joinServer(entry) }, '进入'),
        h('button', { class: 'btn btn-sm', onclick: () => pingServer(entry, true) }, '检测'),
        h('button', { class: 'btn btn-sm btn-ghost', title: '复制地址', onclick: () => { navigator.clipboard?.writeText(`${entry.address}${entry.port && entry.port !== 25565 ? ':' + entry.port : ''}`); toastOk('已复制地址'); } }, '⧉'),
        h('button', { class: 'btn btn-sm btn-ghost', title: '删除', html: icon('close', 13), onclick: () => removeServer(entry) }),
      ]),
    ]),
  ]);
}

async function joinServer(entry) {
  const inst = targetInstance();
  if (!inst) { toastErr('没有实例', '请先创建实例并安装游戏'); return; }
  if (state.running.length) { toastErr('游戏已在运行', '请先退出正在运行的游戏'); return; }
  try {
    const r = await api(`/api/instances/${inst.id}/launch`, {
      method: 'POST',
      body: { server: { host: entry.address, port: entry.port || 25565 } },
    });
    toastOk('正在加入服务器', `${entry.name} · 使用实例 ${inst.name}`);
  } catch (e) { toastErr('启动失败', e.message); }
}

async function removeServer(entry) {
  const ok = await confirmDialog({ title: '删除服务器', message: `从列表中移除「${entry.name}」？`, okText: '移除', danger: true });
  if (!ok) return;
  try { await api(`/api/servers/${entry.id}`, { method: 'DELETE' }); pings.delete(entry.id); await loadState(); renderList(); }
  catch (e) { toastErr('删除失败', e.message); }
}

async function addServer() {
  const name = h('input', { class: 'input', placeholder: '服务器名称（例如 我的生存服）' });
  const addr = h('input', { class: 'input', placeholder: '地址，例如 mc.example.com 或 127.0.0.1:25565' });
  const notes = h('input', { class: 'input', placeholder: '备注（可选）' });
  modal({
    title: '添加服务器',
    body: [
      h('div', { class: 'field' }, [h('label', {}, '名称'), name]),
      h('div', { class: 'field' }, [h('label', {}, '地址'), addr, h('div', { class: 'hint' }, '支持域名、IP，可带端口。')]),
      h('div', { class: 'field' }, [h('label', {}, '备注'), notes]),
    ],
    actions: [
      { label: '取消' },
      { label: '添加', kind: 'primary', onClick: async () => {
        if (!addr.value.trim()) { toastErr('请填写服务器地址'); return false; }
        try {
          const r = await api('/api/servers', { method: 'POST', body: { name: name.value.trim() || addr.value.trim(), address: addr.value.trim(), notes: notes.value } });
          await loadState();
          renderList();
          const created = r.server || r;
          toastOk('已添加服务器', created?.name || addr.value);
          if (created?.id) pingServer(created);
        } catch (e) { toastErr('添加失败', e.message); return false; }
      } },
    ],
  });
  setTimeout(() => addr.focus(), 80);
}

async function scanLan() {
  lanLoading = true;
  renderLan();
  try {
    const r = await api('/api/servers/lan');
    lanWorlds = r.worlds || [];
  } catch (e) {
    toastErr('局域网扫描失败', e.message);
    lanWorlds = [];
  }
  lanLoading = false;
  renderLan();
}

async function addLanWorld(w) {
  try {
    const r = await api('/api/servers', { method: 'POST', body: { name: `局域网世界 ${w.port}`, address: '127.0.0.1', port: w.port, notes: cleanMotd(w.motd || '') } });
    await loadState();
    renderList();
    toastOk('已添加局域网服务器', '127.0.0.1:' + w.port);
  } catch (e) { toastErr('添加失败', e.message); }
}

function renderLan() {
  const box = view?.querySelector('#lan-box');
  if (!box) return;
  box.innerHTML = '';
  if (lanLoading) { box.append(loadingBlock('正在广播搜索局域网世界（约 3 秒）…')); return; }
  if (!lanWorlds) return;
  if (!lanWorlds.length) {
    box.append(h('div', { class: 'hint' }, '没有发现局域网世界。请确保房主已在「对局域网开放」，且在同一网络。'));
    return;
  }
  box.append(h('div', { class: 'list' }, lanWorlds.map((w) => h('div', { class: 'list-item' }, [
    h('div', { class: 'li-main' }, [
      h('div', { class: 'li-title' }, cleanMotd(w.motd) || `局域网世界 :${w.port}`),
      h('div', { class: 'li-sub mono' }, `${w.address || '127.0.0.1'}:${w.port}`),
    ]),
    h('button', { class: 'btn btn-sm btn-primary', onclick: () => addLanWorld(w) }, '添加'),
  ]))));
}

function renderList() {
  if (!view) return;
  const list = view.querySelector('#srv-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.servers.length) {
    list.append(emptyState({
      icon: '◎', title: '还没有收藏服务器',
      sub: '添加常用服务器，实时查看在线人数与延迟；也可以扫描局域网里朋友开放的世界。',
      action: h('button', { class: 'btn btn-primary', onclick: addServer }, '添加服务器'),
    }));
    return;
  }
  list.append(h('div', { class: 'srv-grid' }, state.servers.map(serverCard)));
}

function renderPage() {
  if (!view) return;
  view.innerHTML = '';
  view.append(h('div', { class: 'home' }, [
    h('div', { class: 'panel', style: { padding: '14px' } }, [
      h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
        h('button', { class: 'btn btn-primary', onclick: addServer }, '＋ 添加服务器'),
        h('button', { class: 'btn', html: `${icon('refresh', 14)}<span>全部检测</span>`, onclick: pingAll }),
        h('button', { class: 'btn', onclick: scanLan }, '⌁ 扫描局域网'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn btn-ghost', onclick: () => { location.hash = '#/hosts'; } }, '自己开服 →'),
      ]),
      h('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        h('span', { class: 'muted small' }, '进入服务器会使用当前实例：'),
        targetInstance() ? badge(targetInstance().name + (targetInstance().versionId ? ' · ' + targetInstance().versionId : ''), 'accent') : badge('没有实例', 'err'),
        h('span', { class: 'muted small' }, '服务器版本需与实例版本兼容'),
      ]),
    ]),
    h('div', { id: 'lan-box' }),
    h('div', { id: 'srv-list' }),
  ]));
  renderList();
  if (!state.servers.length) renderLan();
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    renderPage();
    if (state.servers.length) setTimeout(pingAll, 120);
    unsub = subscribe((evt) => {
      if (evt.type === 'sse' && evt.evt.type === 'launch' && evt.evt.phase === 'running') renderList();
    });
  },
  destroy() { if (unsub) unsub(); unsub = null; view = null; ctxRef = null; },
};
