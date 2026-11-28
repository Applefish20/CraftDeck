/* ================= 陶瓦联机（Terracotta） ================= */
import {
  h, toast, toastOk, toastErr, badge, emptyState, modal, loadingBlock, fmtBytes, sectionTitle, copyText,
} from '../ui.js';
import { state, api, subscribe, loadState } from '../state.js';

let view = null;
let ctxRef = null;
let status = null;
let loading = false;
let timer = null;
let unsub = null;
let busy = false;
let mode = 'terracotta';

const STATE_TEXT = {
  waiting: '待机',
  'host-scanning': '正在扫描本机 Minecraft 端口',
  'host-starting': '正在创建房间',
  'host-ok': '房间已就绪',
  'guest-connecting': '正在连接房主',
  'guest-starting': '正在建立联机通道',
  'guest-ok': '已加入房间',
  exception: '发生异常',
  disconnected: '已断开',
  stopped: '已停止',
};

const DIFFICULTY = {
  EASIEST: '非常简单', SIMPLE: '简单', MEDIUM: '中等', TOUGH: '较难', UNKNOWN: '未知',
};

function targetInstance() {
  return state.instances.find((i) => i.id === state.settings.lastInstanceId) || state.instances[0] || null;
}

async function refresh() {
  try {
    status = await api('/api/terracotta/status');
  } catch (e) {
    status = { installed: false, running: false, error: e.message, state: { state: 'waiting' } };
  }
  renderPage();
}

async function ensureInstalled() {
  busy = true;
  renderPage();
  try {
    await api('/api/terracotta/install', { method: 'POST', body: {} });
    toastOk('陶瓦联机已就绪', '现在可以创建或加入房间了');
    await refresh();
  } catch (e) {
    toastErr('安装失败', e.message);
  } finally {
    busy = false;
    renderPage();
  }
}

async function startTerracotta() {
  busy = true;
  renderPage();
  try {
    await api('/api/terracotta/start', { method: 'POST', body: {} });
    toastOk('陶瓦联机已启动');
    await refresh();
  } catch (e) {
    toastErr('启动失败', e.message);
  } finally {
    busy = false;
    renderPage();
  }
}

async function stopTerracotta() {
  busy = true;
  try {
    await api('/api/terracotta/stop', { method: 'POST', body: {} });
    toastOk('陶瓦联机已关闭');
  } catch (e) { toastErr('关闭失败', e.message); }
  busy = false;
  await refresh();
}

async function doHost(player) {
  if (busy) return;
  busy = true;
  renderPage();
  try {
    await api('/api/terracotta/host', { method: 'POST', body: { player } });
    toast({ kind: 'info', title: '正在创建房间', message: '请先在游戏里进入存档并对局域网开放', timeout: 6000 });
    await refresh();
  } catch (e) {
    toastErr('创建房间失败', e.message);
  } finally { busy = false; renderPage(); }
}

async function doGuest(room, player) {
  if (!room.trim()) { toastErr('请填写房间码', ''); return; }
  busy = true;
  renderPage();
  try {
    await api('/api/terracotta/guest', { method: 'POST', body: { room: room.trim(), player } });
    await refresh();
  } catch (e) {
    toastErr('加入失败', e.message);
  } finally { busy = false; renderPage(); }
}

async function resetRoom() {
  try { await api('/api/terracotta/reset', { method: 'POST', body: {} }); await refresh(); }
  catch (e) { toastErr('返回待机失败', e.message); }
}

async function joinDirect(address) {
  const inst = targetInstance();
  if (!inst) { toastErr('没有实例', '请先创建实例并安装游戏'); return; }
  const [host, port] = String(address).split(':');
  try {
    await api(`/api/instances/${inst.id}/launch`, {
      method: 'POST', body: { server: { host: host || '127.0.0.1', port: Number(port) || 25565 } },
    });
    toastOk('正在启动游戏', `直连 ${address}`);
  } catch (e) { toastErr('启动失败', e.message); }
}

async function showLog() {
  try {
    const r = await api('/api/terracotta/log');
    modal({
      title: '陶瓦联机日志', wide: true,
      body: h('pre', { class: 'console-body', style: { height: '360px' } }, (r.log || '暂无日志').slice(-20000)),
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  } catch (e) { toastErr('读取日志失败', e.message); }
}

function playerName() {
  return state.activeAccount?.username || 'CraftDeck';
}

function statusPill() {
  if (!status) return badge('检测中…');
  if (busy) return badge('处理中…', 'warn');
  if (!status.installed) return badge('未安装', 'warn');
  if (!status.running) return badge('未启动');
  const st = status.state?.state;
  if (st === 'exception') return badge('异常', 'err');
  if (st === 'host-ok' || st === 'guest-ok') return badge('联机中', 'ok');
  return badge(STATE_TEXT[st] || st || '已启动', 'accent');
}

function topPanel() {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('div', { class: 'panel-title' }, ['陶瓦联机 ', statusPill()]),
      h('div', { class: 'row' }, [
        status?.version ? badge('v' + status.version) : null,
        status?.port ? h('span', { class: 'muted small mono' }, ':' + status.port) : null,
      ]),
    ]),
    h('p', { class: 'hint', style: { marginBottom: '12px', lineHeight: '1.7' } },
      '陶瓦联机基于 EasyTier 组网：房主进入存档并对局域网开放，创建房间后把房间码发给朋友，朋友输入房间码即可加入，无需端口映射。'),
    !status?.installed
      ? h('div', { class: 'callout info', style: { marginBottom: '12px' } }, [
        h('span', { class: 'c-icon' }, 'i'),
        h('div', { class: 'grow' }, '首次使用需要下载陶瓦联机组件（约 8 MB，来自官方 Gitee 镜像）。'),
        h('button', { class: 'btn btn-primary btn-sm', disabled: busy, onclick: ensureInstalled }, busy ? '正在安装…' : '下载并安装'),
      ])
      : h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, [
        !status.running
          ? h('button', { class: 'btn btn-primary', disabled: busy, onclick: startTerracotta }, '启动陶瓦联机')
          : h('button', { class: 'btn btn-danger', disabled: busy, onclick: stopTerracotta }, '退出陶瓦联机'),
        h('button', { class: 'btn btn-sm', disabled: busy, onclick: ensureInstalled, title: '重新下载最新版本' }, '检查更新'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: showLog }, '查看日志'),
        h('div', { class: 'spacer' }),
        h('span', { class: 'muted small' }, 'Powered by Terracotta · AGPL-3.0'),
      ]),
    status?.error ? h('div', { class: 'callout err', style: { marginTop: '10px' } }, status.error) : null,
  ]);
}

function waitingPanel() {
  const name = h('input', { class: 'input', value: playerName(), placeholder: '游戏内显示名（可选）' });
  const room = h('input', { class: 'input mono', placeholder: '粘贴房间码，例如 U/XXXX-XXXX-XXXX-XXXX' });
  const hostCard = h('div', { class: 'panel', style: { flex: '1 1 320px' } }, [
    h('div', { class: 'panel-title', style: { marginBottom: '8px' } }, '我是房主'),
    h('p', { class: 'hint', style: { marginBottom: '10px' } }, '请先启动游戏 → 进入存档 → 对局域网开放，然后点击创建房间。'),
    h('div', { class: 'field', style: { marginBottom: '10px' } }, [h('label', {}, '显示名'), name]),
    h('button', {
      class: 'btn btn-primary btn-block', disabled: busy,
      onclick: () => doHost(name.value.trim()),
    }, busy ? '处理中…' : '创建房间'),
  ]);
  const guestCard = h('div', { class: 'panel', style: { flex: '1 1 320px' } }, [
    h('div', { class: 'panel-title', style: { marginBottom: '8px' } }, '加入房间'),
    h('p', { class: 'hint', style: { marginBottom: '10px' } }, '输入房主发来的房间码，加入后可在多人游戏列表看到房间，或使用直连地址。'),
    h('div', { class: 'field', style: { marginBottom: '10px' } }, [h('label', {}, '房间码'), room]),
    h('button', {
      class: 'btn btn-primary btn-block', disabled: busy,
      onclick: () => doGuest(room.value, name.value.trim()),
    }, busy ? '连接中…' : '加入房间'),
  ]);
  return h('div', { class: 'row', style: { alignItems: 'stretch', flexWrap: 'wrap', gap: '14px' } }, [hostCard, guestCard]);
}

function progressPanel(text, sub) {
  return h('div', { class: 'panel', style: { textAlign: 'center', padding: '36px 20px' } }, [
    h('div', { class: 'spinner', style: { margin: '0 auto 14px' } }),
    h('h3', {}, text),
    sub ? h('p', { class: 'hint', style: { marginTop: '8px' } }, sub) : null,
    h('button', { class: 'btn btn-sm', style: { marginTop: '16px' }, onclick: resetRoom }, '取消并返回待机'),
  ]);
}

function roomPanel(st) {
  const isHost = st.state === 'host-ok';
  const code = st.room || st.roomCode || '';
  const profiles = st.profiles || [];
  return h('div', { class: 'panel' }, [
    h('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
      h('h3', {}, isHost ? '房间已创建' : '已加入房间'),
      badge(isHost ? '房主' : '成员', isHost ? 'accent' : 'ok'),
    ]),
    code ? h('div', {
      class: 'row', style: { margin: '16px 0', padding: '16px', borderRadius: '12px', background: 'rgba(0,0,0,.28)', border: '1px dashed var(--line-strong)' },
    }, [
      h('div', { class: 'mono', style: { fontSize: '24px', fontWeight: '800', letterSpacing: '1px', flex: '1', wordBreak: 'break-all' } }, code),
      h('button', { class: 'btn btn-sm', onclick: () => copyText(code) }, '复制房间码'),
    ]) : null,
    st.directAddress ? h('div', { class: 'callout ok', style: { marginBottom: '12px' } }, [
      h('span', { class: 'c-icon' }, '✓'),
      h('div', { class: 'grow' }, [
        h('div', {}, '直连地址：' + st.directAddress),
        h('div', { class: 'hint' }, '如果多人列表里没有出现房间，可以在「服务器列表」添加这个地址，或直接点击右侧按钮启动游戏直连。'),
      ]),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => joinDirect(st.directAddress) }, '进入服务器'),
    ]) : null,
    h('div', { class: 'label', style: { marginBottom: '8px' } }, `房间成员（${profiles.length}）`),
    profiles.length
      ? h('div', { class: 'list' }, profiles.map((p) => h('div', { class: 'list-item' }, [
        h('div', { class: 'avatar' }, (p.name || '?').slice(0, 1).toUpperCase()),
        h('div', { class: 'li-main' }, [
          h('div', { class: 'li-title' }, p.name || '未知玩家'),
          h('div', { class: 'li-sub mono' }, (p.machine_id || '').slice(0, 24)),
        ]),
        badge(p.kind === 'HOST' ? '房主' : p.kind === 'LOCAL' ? '本机' : '玩家', p.kind === 'HOST' ? 'accent' : ''),
      ])))
      : h('div', { class: 'hint' }, '还没有其他玩家加入。'),
    h('div', { class: 'row', style: { marginTop: '14px' } }, [
      isHost ? h('p', { class: 'hint grow' }, '把房间码发给朋友；房主退出存档后房间会自动关闭。') : h('div', { class: 'grow' }),
      h('button', { class: 'btn btn-sm', onclick: resetRoom }, '返回待机'),
    ]),
  ]);
}

function exceptionPanel(st) {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'callout err', style: { marginBottom: '12px' } }, [
      h('span', { class: 'c-icon' }, '!'),
      h('div', { class: 'grow' }, st.message || '陶瓦联机发生异常'),
    ]),
    h('div', { class: 'row' }, [
      h('button', { class: 'btn btn-primary', onclick: resetRoom }, '返回待机'),
      h('button', { class: 'btn btn-sm', onclick: showLog }, '查看日志'),
    ]),
  ]);
}

function bodyFor(state) {
  if (!status?.installed) return emptyState({ icon: '◈', title: '还没有安装陶瓦联机', sub: '点击上方「下载并安装」即可，约 8 MB。' });
  if (!status.running) return emptyState({ icon: '◈', title: '陶瓦联机未启动', sub: '点击上方「启动陶瓦联机」，然后创建或加入房间。' });
  switch (state.state) {
    case 'waiting':
    case 'stopped':
    case 'disconnected':
      return waitingPanel();
    case 'host-scanning':
      return progressPanel('正在扫描本机 Minecraft 端口…', '请先启动游戏、进入存档并在「对局域网开放」中开放端口。');
    case 'host-starting':
      return progressPanel('正在创建房间…', '正在通过 EasyTier 建立联机通道，通常需要几秒。');
    case 'host-ok':
    case 'guest-ok':
      return roomPanel(state);
    case 'guest-connecting':
      return progressPanel('正在连接房主…', '正在寻找最优线路。');
    case 'guest-starting':
      return progressPanel('正在建立联机通道…', state.difficulty ? 'NAT 难度：' + (DIFFICULTY[state.difficulty] || state.difficulty) : '');
    case 'exception':
      return exceptionPanel(state);
    default:
      return waitingPanel();
  }
}

function guidePanel() {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-title', style: { marginBottom: '10px' } }, '怎么联机？'),
    h('ol', { style: { margin: 0, paddingLeft: '18px', color: 'var(--text-dim)', fontSize: '12.5px', lineHeight: '1.9' } }, [
      h('li', {}, '房主启动游戏并进入存档，按 Esc → 对局域网开放。'),
      h('li', {}, '房主在此页点击「创建房间」，把房间码发给朋友。'),
      h('li', {}, '朋友启动游戏并保持多人游戏界面打开，在此页输入房间码加入。'),
      h('li', {}, '加入后在多人游戏列表会出现「陶瓦联机大厅」，双击进入；或使用直连地址。'),
    ]),
    h('div', { class: 'hint', style: { marginTop: '10px' } },
      '陶瓦联机只在本机 127.0.0.1 上提供接口，本启动器通过其官方 HTTP API 调用，不会上传你的账号信息。'),
  ]);
}

function modeTabs() {
  return h('div', { class: 'mode-tabs' }, [
    h('button', { class: mode === 'terracotta' ? 'active' : '', onclick: () => { mode = 'terracotta'; renderPage(); } }, '陶瓦联机'),
    h('button', { class: mode === 'redstone' ? 'active' : '', onclick: () => { mode = 'redstone'; renderPage(); } }, '红石联机'),
  ]);
}

function redstonePanel() {
  const url = 'https://modrinth.com/mod/redstoneonline';
  const install = async (ev) => {
    const inst = state.instances.find((i) => i.id === state.settings.lastInstanceId) || state.instances[0];
    if (!inst?.versionId) { toastErr('没有可安装的实例', '请先创建一个带游戏版本的实例'); return; }
    const btn = ev.currentTarget;
    btn.disabled = true; btn.textContent = '安装中…';
    try {
      await api('/api/mods/install', {
        method: 'POST',
        body: {
          projectId: 'redstoneonline',
          instanceId: inst.id,
          gameVersion: inst.versionId,
          loader: inst.loader?.type || 'fabric',
          withDependencies: true,
        },
      });
      toastOk('RedstoneLink 已安装', `${inst.name} · 启动游戏后即可使用`);
    } catch (e) { toastErr('安装失败', e.message); }
    finally { btn.disabled = false; btn.textContent = '一键安装到当前实例'; }
  };
  return h('div', { class: 'panel', style: { padding: '18px' } }, [
    h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' } }, [
      h('div', {}, [
        h('div', { class: 'panel-title' }, '红石联机 · RedstoneLink'),
        h('div', { class: 'hint', style: { marginTop: '4px' } }, '另一种基于 RedstoneLink 的联机方式，需要先在实例里安装对应模组。'),
      ]),
      badge('外部模组', 'violet'),
    ]),
    h('div', { class: 'callout info', style: { marginTop: '14px' } }, '红石联机由 RedstoneLink 模组提供房间与连接能力；本启动器负责引导安装和打开页面，不在后台替游戏建立连接。'),
    h('div', { class: 'row', style: { marginTop: '12px', gap: '8px', flexWrap: 'wrap' } }, [
      h('button', { class: 'btn btn-primary', onclick: install }, '一键安装到当前实例'),
      h('button', { class: 'btn', onclick: () => window.desktopWindow?.openExternal?.(url) || window.open(url, '_blank', 'noopener') }, '打开 RedstoneLink 页面'),
      h('button', { class: 'btn', onclick: () => copyText(url) }, '复制下载地址'),
    ]),
    sectionTitle('使用方式'),
    h('div', { class: 'guide-list' }, [
      h('div', { class: 'guide-step' }, [h('div', { class: 'guide-num' }, '1'), h('div', {}, [h('div', { class: 'guide-title' }, '安装模组'), h('div', { class: 'guide-text' }, '在实例「内容 → 模组」中安装 RedstoneLink，或把对应 jar 放进 mods。')])]),
      h('div', { class: 'guide-step' }, [h('div', { class: 'guide-num' }, '2'), h('div', {}, [h('div', { class: 'guide-title' }, '进入游戏'), h('div', { class: 'guide-text' }, '启动当前实例，在游戏内创建或加入红石联机房间。')])]),
      h('div', { class: 'guide-step' }, [h('div', { class: 'guide-num' }, '3'), h('div', {}, [h('div', { class: 'guide-title' }, '分享房间'), h('div', { class: 'guide-text' }, '把游戏内生成的房间信息发给朋友即可。')])]),
    ]),
  ]);
}

function renderPage() {
  if (!view) return;
  view.innerHTML = '';
  const st = status?.state || { state: 'waiting' };
  if (mode === 'redstone') {
    view.append(h('div', { class: 'home' }, [modeTabs(), redstonePanel()]));
    return;
  }
  view.append(h('div', { class: 'home' }, [
    modeTabs(),
    topPanel(),
    bodyFor(st),
    sectionTitle('使用说明'),
    guidePanel(),
  ]));
}

export default {
  async render(el, ctx) {
    view = el;
    ctxRef = ctx;
    if (!state.instances.length) { try { await loadState(); } catch { /* ignore */ } }
    view.append(loadingBlock('正在读取陶瓦联机状态…'));
    await refresh();
    timer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const s = await api('/api/terracotta/status');
        const changed = JSON.stringify(s.state) !== JSON.stringify(status?.state) || s.running !== status?.running || s.installed !== status?.installed;
        status = s;
        if (changed) renderPage();
      } catch { /* ignore */ }
    }, 1200);
    unsub = subscribe((evt) => {
      if (evt.type === 'sse' && evt.evt.type === 'terracotta') {
        status = { ...(status || {}), running: evt.evt.state?.state !== 'disconnected', state: evt.evt.state };
        renderPage();
      }
      if (evt.type === 'sse' && evt.evt.type === 'progress' && evt.evt.scope === 'terracotta') {
        if (evt.evt.finished && evt.evt.ok) refresh();
      }
    });
  },
  destroy() {
    if (timer) clearInterval(timer);
    timer = null;
    if (unsub) unsub();
    unsub = null;
    view = null;
    ctxRef = null;
    status = null;
  },
};
