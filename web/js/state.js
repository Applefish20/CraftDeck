/* ================= 状态与 API ================= */
export const state = {
  settings: {},
  accounts: [],
  instances: [],
  servers: [],
  hosts: [],
  stats: { launches: 0, playTimeMs: 0 },
  running: [],
  root: '',
  versions: { latest: {}, versions: [], fetchedAt: 0 },
  route: 'instances',
  routeParam: null,
  activeAccount: null,
  tasks: new Map(),
  logs: [],
  accountSkins: new Map(),
};

export const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(evt = {}) { for (const fn of [...listeners]) { try { fn(evt); } catch (e) { console.error(e); } } }

export const API_TOKEN = new URLSearchParams(location.search).get('t') || '';

export async function api(path, opts = {}) {
  const { method = 'GET', body, headers = {}, raw = false } = opts;
  const init = { method, headers: { ...headers } };
  if (API_TOKEN) init.headers['X-CraftDeck-Token'] = API_TOKEN;
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, init);
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : { error: await res.text().catch(() => '') };
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || data.message || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function loadState() {
  const s = await api('/api/state');
  Object.assign(state, {
    settings: s.settings || {},
    accounts: s.accounts || [],
    instances: s.instances || [],
    servers: s.servers || [],
    hosts: s.hosts || [],
    stats: s.stats || { launches: 0, playTimeMs: 0 },
    running: s.running || [],
    root: s.root || '',
  });
  syncActiveAccount();
  return s;
}

export function syncActiveAccount() {
  const id = state.settings.lastAccountId;
  state.activeAccount = state.accounts.find((a) => a.id === id) || state.accounts[0] || null;
  if (state.activeAccount && !state.settings.lastAccountId) state.settings.lastAccountId = state.activeAccount.id;
}

export async function patchSettings(patch) {
  const r = await api('/api/settings', { method: 'PATCH', body: patch });
  state.settings = r.settings;
  syncActiveAccount();
  applyAppearance();
  emit({ type: 'settings' });
  return r.settings;
}

export function applyAppearance() {  const s = state.settings || {};
  const root = document.documentElement;
  const theme = s.theme === 'light' ? 'light' : 'dark';
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  if (s.accent) {
    root.style.setProperty('--accent', s.accent);
    // Pick readable text on top of the accent color (users can pick pure white).
    try {
      const h = String(s.accent).replace('#', '');
      const v = h.length === 6 ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : [76, 194, 255];
      const lin = v.map((c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
      const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      root.style.setProperty('--accent-ink', lum > 0.45 ? '#0b1220' : '#ffffff');
    } catch { /* ignore */ }
  }
  const bg = s.background || {};
  const imgEl = document.getElementById('bg-image');
  const dimEl = document.getElementById('bg-dim');
  const layer = document.getElementById('bg-layer');
  if (!imgEl || !dimEl || !layer) return;
  layer.style.filter = '';
  layer.style.transform = '';
  if (bg.type === 'image' && bg.value) {
    imgEl.style.backgroundImage = `url("${bg.value}")`;
    imgEl.style.filter = `blur(${bg.blur || 0}px)`;
    imgEl.style.opacity = String(bg.opacity ?? 1);
    layer.className = 'bg-layer has-image';
  } else if (bg.type === 'none') {
    imgEl.style.backgroundImage = 'none';
    layer.className = 'bg-layer';
  } else {
    imgEl.style.backgroundImage = 'none';
    imgEl.style.filter = 'none';
    layer.className = `bg-layer bg-preset-${bg.value || 'aurora'}`;
    if (bg.blur) {
      layer.style.filter = `blur(${bg.blur}px)`;
      layer.style.transform = 'scale(1.03)';
    }
  }
  const dim = bg.dim ?? 0.35;
  dimEl.style.background = theme === 'light'
    ? `rgba(255, 255, 255, ${Math.min(0.95, dim)})`
    : `rgba(6, 9, 13, ${dim})`;
}

/** Hide navigation entries the user disabled in Settings. */
let navHiddenLast = null;
let navAnimTimer = null;
export function applyHiddenPages() {
  const hidden = new Set(Array.isArray(state.settings.hiddenPages) ? state.settings.hiddenPages : []);
  for (const a of document.querySelectorAll('#nav .nav-item[data-page]')) {
    if (['instances', 'downloads', 'accounts', 'skins', 'settings'].includes(a.dataset.page)) continue;
    a.style.display = hidden.has(a.dataset.page) ? 'none' : '';
  }
  const textHidden = state.settings.hideNavText === true;
  if (navHiddenLast !== null && navHiddenLast !== textHidden) {
    document.body.classList.add('nav-animating');
    clearTimeout(navAnimTimer);
    navAnimTimer = setTimeout(() => document.body.classList.remove('nav-animating'), 420);
  }
  navHiddenLast = textHidden;
  document.body.classList.toggle('nav-text-hidden', textHidden);
  if (!textHidden) document.querySelector('.nav-tooltip')?.classList.remove('show');
  for (const a of document.querySelectorAll('#nav .nav-item')) {
    const label = a.querySelector('span:last-child')?.textContent?.trim();
    if (!label) continue;
    // 始终关闭浏览器原生 title 提示，避免它贴在侧边栏白边上。
    a.removeAttribute('title');
    a.setAttribute('aria-label', label);
    if (textHidden) a.dataset.tip = label;
    else delete a.dataset.tip;
  }
}

export const instanceById = (id) => state.instances.find((i) => i.id === id) || null;
export const accountById = (id) => state.accounts.find((a) => a.id === id) || null;
export const isRunning = (id) => state.running.some((r) => r.instanceId === id);
export const runningOf = (id) => state.running.find((r) => r.instanceId === id) || null;

export function currentInstance() {
  return instanceById(state.settings.lastInstanceId) || state.instances[0] || null;
}

export function pageOf(route) {
  const map = {
    instances: { title: '启动', sub: '选择已安装的版本，一键开始游戏' },
    downloads: { title: '下载中心', sub: '版本、整合包、模组、材质光影与汉化' },
    versions: { title: '版本下载', sub: '原版游戏与模组加载器' },
    migrate: { title: '迁移导入', sub: '从 PCL / HMCL / 官方启动器一键迁移' },
    modpacks: { title: '整合包', sub: '一键安装完整整合包' },
    mods: { title: '模组', sub: '来自 Modrinth 的海量模组' },
    resources: { title: '材质与光影', sub: '资源包 / 光影包' },
    translation: { title: '汉化', sub: '模组简体中文汉化资源包' },
    servers: { title: '服务器列表', sub: '收藏与延迟检测，支持局域网发现' },
    terracotta: { title: '陶瓦联机', sub: '房间码联机，无需端口映射' },
    hosts: { title: '开服中心', sub: '一键开启本地联机服务器' },
    accounts: { title: '账户', sub: '正版 / 离线 / 第三方登录' },
    skins: { title: '皮肤', sub: '上传、下载并应用你的皮肤' },
    logs: { title: '日志', sub: '启动器日志与游戏日志' },
    toolbox: { title: '百宝箱', sub: '内存优化 · 清理 · 校验 · 诊断' },
    settings: { title: '设置', sub: '通用、外观、Java、下载与关于' },
  };
  return map[route] || map.instances;
}

export function taskKey(t) {
  return t.taskId || 'global';
}

export function updateTask(t) {
  const key = taskKey(t);
  const now = Date.now();
  const prev = state.tasks.get(key) || { taskId: key, scope: t.scope, label: t.label, percent: 0 };
  const bytes = Number(t.bytes) || 0;
  let speedBps = prev.speedBps || 0;
  if (prev.lastTs && now - prev.lastTs > 250 && bytes >= (prev.lastBytes || 0)) {
    const instant = ((bytes - (prev.lastBytes || 0)) * 1000) / (now - prev.lastTs);
    speedBps = speedBps ? speedBps * 0.65 + instant * 0.35 : instant;
  }
  state.tasks.set(key, {
    ...prev, ...t, updatedAt: now,
    lastBytes: bytes, lastTs: now, speedBps,
  });
  // 保留最近 8 个
  if (state.tasks.size > 8) {
    const oldest = [...state.tasks.entries()].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))[0];
    if (oldest && oldest[0] !== key) state.tasks.delete(oldest[0]);
  }
  emit({ type: 'task', task: state.tasks.get(key) });
}

export function activeTask() {
  let best = null;
  for (const t of state.tasks.values()) {
    if (t.finished) continue;
    if (!best || (t.updatedAt || 0) > (best.updatedAt || 0)) best = t;
  }
  return best;
}

/** Server-Sent Events: 全局进度/日志/通知 */
export function connectEvents() {
  if (typeof EventSource === 'undefined') return null;
  const es = new EventSource('/api/events?t=' + encodeURIComponent(API_TOKEN));
  es.onmessage = (msg) => {
    let evt;
    try { evt = JSON.parse(msg.data); } catch { return; }
    handleEvent(evt);
  };
  es.onerror = () => {
    // EventSource auto-reconnects; nudging the UI is enough.
    emit({ type: 'sse-error' });
  };
  return es;
}

function handleEvent(evt) {
  emit({ type: 'sse', evt });
  switch (evt.type) {
    case 'progress':
      updateTask(evt);
      break;
    case 'notify':
      import('./ui.js').then(({ toast }) => toast({ kind: evt.kind || 'info', title: evt.title, message: evt.message }));
      emit({ type: 'notify', evt });
      break;
    case 'log':
      state.logs.push({ ts: evt.ts, level: evt.level, message: evt.message });
      if (state.logs.length > 1200) state.logs.splice(0, 200);
      emit({ type: 'log', evt });
      break;
    case 'launch':
      if (evt.phase === 'running') {
        if (!state.running.some((r) => r.instanceId === evt.instanceId)) state.running.push({ instanceId: evt.instanceId, pid: evt.pid, startedAt: Date.now(), versionId: evt.versionId });
        emit({ type: 'running' });
      } else if (evt.phase === 'exit' || evt.phase === 'error') {
        state.running = state.running.filter((r) => r.instanceId !== evt.instanceId);
        emit({ type: 'running' });
      }
      emit({ type: 'launch', evt });
      break;
    case 'host':
      emit({ type: 'host', evt });
      break;
    case 'install':
      emit({ type: 'install', evt });
      break;
    default:
      emit(evt);
  }
}
