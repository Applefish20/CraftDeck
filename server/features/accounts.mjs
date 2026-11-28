/**
 * accounts.mjs — 账户功能模块
 *
 * 支持三种账户：
 *  - offline     离线账户（仅用户名，UUID 由名字派生）
 *  - microsoft   微软账户（OAuth 2.0 设备码流程 + Xbox Live / XSTS / Minecraft Services 链路）
 *  - thirdparty  第三方账户（authlib-injector，兼容 Yggdrasil 认证协议）
 *
 * 安全约定：任何对外的响应都不包含 accessToken / refreshToken / clientToken，
 * 统一经由 publicAccount() 或 store.publicState() 输出。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { store } from '../core/store.mjs';
import { bus } from '../core/events.mjs';
import { CORE_DIR, ROOT } from '../core/paths.mjs';
import { downloadFile } from '../core/downloader.mjs';
import { ensureDir, exists, offlineUuid, sha256 } from '../core/util.mjs';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const MS_OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const MS_SCOPE = 'XboxLive.signin offline_access';
/** 默认公共客户端（与 store.DEFAULT_SETTINGS.microsoftClientId 一致） */
const DEFAULT_MS_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MC_RELYING_PARTY = 'rp://api.minecraftservices.com/';
const UA = 'CraftDeck/1.0 (Minecraft Launcher)';

/** 令牌剩余有效期不足该值时视为需要刷新 */
const REFRESH_SKEW_MS = 2 * 60 * 1000;

const AUTHLIB_JAR = path.join(CORE_DIR, 'authlib-injector.jar');
const AUTHLIB_META_URLS = [
  'https://authlib-injector.yushi.moe/artifact/latest.json',
  'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json',
];
const AUTHLIB_FALLBACK_URL = 'https://authlib-injector.yushi.moe/artifact/latest/authlib-injector.jar';

/** 正在进行的微软登录流程：deviceCode -> flow */
const msFlows = new Map();

/* ------------------------------------------------------------------ *
 * 小型工具
 * ------------------------------------------------------------------ */

/** 不阻止 Node 退出进程的 sleep（后台轮询用） */
function sleepUnref(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

function msClientId() {
  const id = String(store.settings?.microsoftClientId || '').trim();
  return id || DEFAULT_MS_CLIENT_ID;
}

/** 32 位无短横线 UUID → 带短横线的小写 UUID */
function dashUuid(id) {
  const s = String(id || '').replace(/-/g, '').toLowerCase();
  if (s.length !== 32 || !/^[0-9a-f]{32}$/.test(s)) return String(id || '');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function normalizeSkinModel(v) {
  return String(v || '').toLowerCase() === 'slim' ? 'slim' : 'classic';
}

/** 对外的账户视图（绝不包含任何令牌） */
function publicAccount(acc) {
  if (!acc) return null;
  return {
    id: acc.id,
    type: acc.type,
    username: acc.username,
    uuid: acc.uuid,
    authServer: acc.authServer || null,
    skinModel: acc.skinModel || 'classic',
    hasAvatar: !!acc.avatar,
    avatar: acc.avatar || null,
    createdAt: acc.createdAt || null,
    expiresAt: acc.expiresAt || null,
    isDefault: store.settings.lastAccountId === acc.id,
  };
}

/**
 * 统一的 HTTP JSON 请求：不因 4xx/5xx 抛错，而是把状态码交回调用方判断。
 * @returns {Promise<{ok:boolean,status:number,data:any,text:string}>}
 */
async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      body,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    return { ok: res.ok, status: res.status, data, text: text.slice(0, 600) };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('网络请求超时，请检查网络后重试');
    throw new Error('网络请求失败：' + (e && e.message ? e.message : String(url)));
  } finally {
    clearTimeout(timer);
  }
}

function postJson(url, obj, opts = {}) {
  return httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(obj),
    ...opts,
  });
}

function formPost(url, params, opts = {}) {
  return httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) },
    body: new URLSearchParams(params).toString(),
    ...opts,
  });
}

/** 从微软/其他接口的响应里提取一段可读的错误描述 */
function apiErrorText(r) {
  const d = (r && r.data) || {};
  const raw = d.error_description || d.errorMessage || d.error || d.Message || (r && r.text) || '';
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return r ? `HTTP ${r.status}` : '未知错误';
  return s.length > 220 ? s.slice(0, 220) + '…' : s;
}

/** 带 HTTP 状态码的错误（server.mjs 会优先使用 e.status） */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** 微软登录的“还没好”错误：路由据此返回 {status:'pending'} */
function pendingError(message) {
  const e = new Error(message || '等待用户在浏览器中完成登录');
  e.pending = true;
  return e;
}

const XSTS_HINTS = {
  2148916233: '该微软账户还没有 Xbox 账户，请先在 xbox.com 创建 Xbox 档案',
  2148916235: '该微软账户所在国家/地区不支持 Xbox Live',
  2148916236: '该微软账户需要先在 xbox.com 完成年龄验证（成人验证）',
  2148916237: '该微软账户需要先在 xbox.com 完成年龄验证',
  2148916238: '该账户是儿童账户，需要家长先将其加入 Microsoft 家庭组',
  2148916227: '该微软账户已被 Xbox Live 封禁',
};

/* ------------------------------------------------------------------ *
 * 离线账户
 * ------------------------------------------------------------------ */

/**
 * 创建离线账户。
 * @param {{username:string, skinModel?:'classic'|'slim'}} input
 */
export async function createOffline({ username, skinModel = 'classic' } = {}) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    throw httpError(400, '离线用户名需为 3-16 位字母、数字或下划线');
  }
  const acc = store.addAccount({
    type: 'offline',
    username: name,
    uuid: offlineUuid(name),
    accessToken: '0',
    skinModel: normalizeSkinModel(skinModel),
  });
  bus.notify('success', '已添加离线账户', name);
  return publicAccount(acc);
}

/* ------------------------------------------------------------------ *
 * 微软账户：设备码流程
 * ------------------------------------------------------------------ */

/**
 * 开始微软设备码登录：返回用户码给界面，同时在后台轮询并把结果通过 bus 的
 * `ms-login` 事件推送（status: pending | ok | error）。
 * @returns {Promise<{userCode:string, verificationUri:string, expiresIn:number, interval:number, deviceCode:string, message:string}>}
 */
export async function beginMicrosoftLogin() {
  const r = await formPost(`${MS_OAUTH}/devicecode`, {
    client_id: msClientId(),
    scope: MS_SCOPE,
  }, { timeoutMs: 20000 });

  if (!r.ok || !r.data || !r.data.device_code) {
    throw new Error('启动微软登录失败：' + apiErrorText(r));
  }
  const d = r.data;
  // 限制缓存中的流程数量，避免长期运行后内存膨胀
  if (msFlows.size > 20) {
    const oldest = [...msFlows.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))[0];
    if (oldest) msFlows.delete(oldest[0]);
  }
  const flow = {
    deviceCode: d.device_code,
    status: 'pending',
    accountId: null,
    error: null,
    loop: false,
    inFlight: false,
    interval: Math.max(3, Number(d.interval) || 5),
    expiresIn: Number(d.expires_in) || 900,
    createdAt: Date.now(),
    warnings: [],
  };
  msFlows.set(flow.deviceCode, flow);

  // 后台轮询：失败不抛出，前端仍可通过 /api/accounts/microsoft/poll 主动查询。
  pollMicrosoftLogin(flow.deviceCode).catch(() => { /* 已由事件/流程状态反映 */ });

  return {
    userCode: d.user_code,
    verificationUri: d.verification_uri || 'https://microsoft.com/devicelogin',
    expiresIn: flow.expiresIn,
    interval: flow.interval,
    deviceCode: d.device_code,
    message: d.message || '',
  };
}

/**
 * 后台轮询设备码状态，直到成功/失败/过期。结果通过 bus 事件 `ms-login` 推送。
 * 内部使用（beginMicrosoftLogin 会自动调用）。
 * @returns {Promise<object|null>} 成功时返回公开账户，失败返回 null
 */
export async function pollMicrosoftLogin(deviceCode) {
  const flow = msFlows.get(deviceCode);
  if (!flow) throw new Error('登录流程不存在，请重新开始微软登录');
  flow.loop = true;
  const deadline = Date.now() + (flow.expiresIn || 900) * 1000;
  try {
    while (flow.status === 'pending' && Date.now() < deadline) {
      await sleepUnref(Math.max(3, flow.interval || 5) * 1000);
      if (flow.status !== 'pending') break;
      try {
        return await runTokenAttempt(flow);
      } catch (e) {
        if (e && e.pending) continue; // 用户还没操作完，继续等
        return null;                  // 终态失败：runTokenAttempt 已记录状态并推送事件
      }
    }
    if (flow.status === 'pending') {
      flow.status = 'error';
      flow.error = '设备代码已过期，请重新开始微软登录';
      bus.emitEvent({ type: 'ms-login', status: 'error', deviceCode, error: flow.error });
    }
    return null;
  } finally {
    flow.loop = false;
  }
}

/**
 * 只做一次令牌兑换（不轮询）。
 * 待用户操作时抛出带有 `.pending === true` 的错误，路由据此返回 {status:'pending'}。
 * @param {string} deviceCode
 * @returns {Promise<object>} 公开账户
 */
export async function completeMicrosoft(deviceCode) {
  const code = String(deviceCode || '').trim();
  if (!code) throw httpError(400, '缺少设备代码（deviceCode），请重新开始微软登录');
  let flow = msFlows.get(code);
  if (!flow) {
    flow = { deviceCode: code, status: 'pending', accountId: null, error: null, loop: false, inFlight: false, interval: 5, expiresIn: 900, createdAt: Date.now(), warnings: [] };
    msFlows.set(code, flow);
  }
  if (flow.status === 'ok') return publicAccount(store.getAccount(flow.accountId));
  if (flow.status === 'error') throw new Error(flow.error || '微软登录失败，请重新开始');
  return runTokenAttempt(flow);
}

/** 单次设备码 → 令牌兑换，成功后走完整链路并保存账户 */
async function runTokenAttempt(flow) {
  if (flow.inFlight) throw pendingError('正在与微软服务器通信，请稍候');
  flow.inFlight = true;
  const deviceCode = flow.deviceCode;
  try {
    const r = await formPost(`${MS_OAUTH}/token`, {
      client_id: msClientId(),
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    }, { timeoutMs: 25000 });

    if (!r.ok || !r.data || !r.data.access_token) {
      const code = String((r.data && r.data.error) || '');
      const desc = String((r.data && r.data.error_description) || '');
      if (code === 'authorization_pending') throw pendingError('等待用户在浏览器中完成登录');
      if (code === 'slow_down') {
        flow.interval = Math.min(30, (flow.interval || 5) + 5);
        throw pendingError('微软要求降低轮询频率，请稍候');
      }
      if (code === 'expired_token') throw new Error('设备代码已过期，请重新开始微软登录');
      if (code === 'authorization_declined') throw new Error('用户拒绝了微软登录授权');
      if (code === 'bad_verification_code' || /AADSTS7000014|device_code/i.test(desc)) {
        throw new Error('设备代码无效或已过期，请重新开始微软登录');
      }
      throw new Error('微软账户登录失败：' + apiErrorText(r));
    }
    const acc = await finishMicrosoftLogin(r.data, flow);
    return publicAccount(acc);
  } catch (e) {
    if (!e || !e.pending) {
      flow.status = 'error';
      flow.error = (e && e.message) || '微软登录失败';
      bus.emitEvent({ type: 'ms-login', status: 'error', deviceCode, error: flow.error });
    }
    throw e;
  } finally {
    flow.inFlight = false;
  }
}

/** 用设备码换到的 OAuth 令牌完成 XBL → XSTS → MC 登录并落库 */
async function finishMicrosoftLogin(token, flow) {
  const chain = await xboxChain(token.access_token);

  // 无游戏所有权时 fetchMcProfile 会抛出明确的中文错误
  const profile = await fetchMcProfile(chain.mcToken);

  const existing = flow && flow.accountId ? store.getAccount(flow.accountId) : null;
  const acc = store.addAccount({
    type: 'microsoft',
    username: profile.name,
    uuid: dashUuid(profile.id),
    accessToken: chain.mcToken,
    refreshToken: token.refresh_token || (existing && existing.refreshToken) || null,
    expiresAt: Date.now() + (Number(chain.expiresIn) || 86400) * 1000,
    xuid: chain.xuid || null,
    skinModel: 'classic',
  });
  flow.accountId = acc.id;
  flow.status = 'ok';
  flow.error = null;
  bus.notify('success', '登录成功', acc.username);
  bus.emitEvent({ type: 'ms-login', status: 'ok', deviceCode: flow.deviceCode, account: publicAccount(acc) });
  return acc;
}

/**
 * Xbox Live → XSTS → Minecraft Services 认证链路。
 * @returns {Promise<{mcToken:string, expiresIn:number, xuid:string|null, uhs:string}>}
 */
async function xboxChain(msAccessToken) {
  const xbl = await postJson(XBL_URL, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: 'd=' + msAccessToken,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  }, { timeoutMs: 25000 });
  if (!xbl.ok || !xbl.data || !xbl.data.Token) {
    if (xbl.status === 401) {
      throw new Error('Xbox Live 身份验证失败：该微软账户尚未创建 Xbox 账户，请先访问 xbox.com 创建');
    }
    throw new Error('Xbox Live 身份验证失败：' + apiErrorText(xbl));
  }

  const xsts = await postJson(XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
    RelyingParty: MC_RELYING_PARTY,
    TokenType: 'JWT',
  }, { timeoutMs: 25000 });
  if (!xsts.ok || !xsts.data || !xsts.data.Token) {
    const xerr = Number(xsts.data && xsts.data.XErr);
    if (xerr && XSTS_HINTS[xerr]) throw new Error(XSTS_HINTS[xerr]);
    if (xsts.status === 401) throw new Error('XSTS 授权失败：请确认该微软账户可以正常使用 Xbox Live');
    throw new Error('XSTS 授权失败：' + apiErrorText(xsts));
  }

  const xui = (xsts.data.DisplayClaims && xsts.data.DisplayClaims.xui && xsts.data.DisplayClaims.xui[0]) || {};
  const uhs = xui.uhs;
  const xuid = xui.xid || null;
  if (!uhs) throw new Error('XSTS 响应缺少用户哈希（uhs），无法完成登录');

  const login = await postJson(MC_LOGIN_URL, {
    identityToken: `XBL3.0 x=${uhs};${xsts.data.Token}`,
  }, { timeoutMs: 25000 });
  if (!login.ok || !login.data || !login.data.access_token) {
    if (login.status === 429) throw new Error('微软接口请求过于频繁，请稍后再试');
    throw new Error('Minecraft 服务登录失败：' + apiErrorText(login));
  }

  return {
    mcToken: login.data.access_token,
    expiresIn: Number(login.data.expires_in) || 86400,
    xuid,
    uhs,
  };
}

/** 读取 Minecraft 档案（需要有效的 MC 访问令牌） */
async function fetchMcProfile(mcToken) {
  const r = await httpJson(MC_PROFILE_URL, {
    headers: { Authorization: 'Bearer ' + mcToken },
    timeoutMs: 20000,
  });
  if (r.status === 404) {
    const e = new Error('该微软账户没有已购买的 Minecraft: Java 版');
    e.noGame = true;
    e.status = 403;
    throw e;
  }
  if (r.status === 401 || r.status === 403) {
    const e = new Error('Minecraft 访问令牌已失效，请重新登录');
    e.unauthorized = true;
    e.status = 401;
    throw e;
  }
  if (!r.ok || !r.data || !r.data.id) {
    throw new Error('获取 Minecraft 档案失败：' + apiErrorText(r));
  }
  return r.data;
}

/* ------------------------------------------------------------------ *
 * 第三方账户（authlib-injector / Yggdrasil）
 * ------------------------------------------------------------------ */

function normalizeAuthServer(input) {
  let s = String(input || '').trim();
  if (!s) throw httpError(400, '请填写认证服务器地址（如 https://littleskin.cn/api/yggdrasil）');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  let u;
  try { u = new URL(s); } catch { throw httpError(400, '认证服务器地址格式不正确：' + input); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw httpError(400, '认证服务器地址必须以 http:// 或 https:// 开头');
  }
  return s;
}

/** 读取 authlib-injector 元数据；不是有效认证服务器则抛中文错误 */
async function fetchAuthServerMeta(authServer) {
  let r;
  try {
    r = await httpJson(authServer, { timeoutMs: 20000 });
  } catch (e) {
    throw httpError(502, `无法连接到认证服务器 ${authServer}：${e.message}`);
  }
  if (!r.ok || !r.data || typeof r.data !== 'object') {
    throw httpError(400, `该地址不是有效的 authlib-injector 认证服务器（HTTP ${r.status}），请检查地址是否正确`);
  }
  const d = r.data;
  // 不同实现字段名不一致：官方为 signaturePublickey，部分实现为 signature_publickey
  if (!d.meta && !d.signaturePublickey && !d.signature_publickey) {
    throw httpError(400, '该地址不是有效的 authlib-injector 认证服务器（缺少 meta / signaturePublickey）');
  }
  return d;
}

/** 把 Yggdrasil 的错误体翻译成中文提示 */
function yggError(r) {
  const d = (r && r.data) || {};
  const code = String(d.error || '');
  const msg = String(d.errorMessage || '').trim();
  if (code === 'ForbiddenOperationException') {
    return '用户名或密码错误，或该账户已被服务器禁止登录' + (msg ? `（${msg}）` : '');
  }
  if (code === 'IllegalArgumentException') return '认证请求参数不合法' + (msg ? `（${msg}）` : '');
  if (msg) return msg;
  return '';
}

/**
 * 第三方账户登录（authlib-injector / Yggdrasil 协议）。
 * @param {{authServer:string, username:string, password:string, skinModel?:string}} input
 */
export async function loginThirdParty({ authServer, username, password, skinModel = 'classic' } = {}) {
  const server = normalizeAuthServer(authServer);
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user) throw httpError(400, '请输入邮箱/用户名');
  if (!pass) throw httpError(400, '请输入密码');

  await fetchAuthServerMeta(server);

  let r;
  try {
    r = await postJson(`${server}/authserver/authenticate`, {
      agent: { name: 'Minecraft', version: 1 },
      username: user,
      password: pass,
      requestUser: true,
    }, { timeoutMs: 30000 });
  } catch (e) {
    throw httpError(502, `无法连接到认证服务器 ${server}：${e.message}`);
  }

  if (r.status === 403) {
    throw httpError(401, yggError(r) || '第三方登录被拒绝：用户名或密码错误');
  }
  if (!r.ok || !r.data || !r.data.accessToken) {
    throw httpError(401, yggError(r) || `第三方登录失败（HTTP ${r.status}），请检查账户信息`);
  }

  const sp = r.data.selectedProfile;
  if (!sp || !sp.id) {
    throw httpError(400, '该账户没有可用的 Minecraft 角色（selectedProfile 为空），请先在认证服务器创建角色');
  }

  const acc = store.addAccount({
    type: 'thirdparty',
    username: sp.name || user,
    uuid: dashUuid(sp.id),
    accessToken: r.data.accessToken,
    clientToken: r.data.clientToken || null,
    authServer: server,
    skinModel: normalizeSkinModel(skinModel),
    // Yggdrasil 令牌通常长期有效，不设置过期时间；失效时由 refreshAccount 兜底。
  });
  bus.notify('success', '登录成功', acc.username);
  return publicAccount(acc);
}

/* ------------------------------------------------------------------ *
 * 第三方网址登录
 * ------------------------------------------------------------------ */

function parseAuthUrl(raw) {
  const text = String(raw || '').trim();
  if (/^authlib-injector:yggdrasil-server:/i.test(text)) {
    const server = decodeURIComponent(text.replace(/^authlib-injector:yggdrasil-server:/i, ''));
    return { authServer: normalizeAuthServer(server), accessToken: '', clientToken: '', username: '', uuid: '' };
  }
  const u = new URL(text);
  const q = u.searchParams;
  let authServer = q.get('authServer') || q.get('server') || q.get('api') || '';
  if (!authServer) {
    const idx = u.pathname.indexOf('/api/');
    authServer = idx >= 0 ? u.origin + u.pathname.slice(0, idx + 5) : u.origin;
  }
  return {
    authServer: normalizeAuthServer(authServer),
    accessToken: q.get('accessToken') || q.get('access_token') || q.get('token') || '',
    clientToken: q.get('clientToken') || '',
    username: q.get('username') || q.get('name') || '',
    uuid: q.get('uuid') || q.get('id') || '',
  };
}

export async function loginThirdPartyUrl({ url } = {}) {
  let p;
  try { p = parseAuthUrl(url); } catch { throw httpError(400, '登录网址格式不正确'); }
  if (!p.authServer) throw httpError(400, '网址里没有认证服务器地址');
  if (!p.accessToken) throw httpError(400, '网址里没有登录令牌，请使用第三方启动器提供的完整回调网址');
  await fetchAuthServerMeta(p.authServer);

  let accessToken = p.accessToken;
  let clientToken = p.clientToken;
  let username = p.username;
  let uuid = p.uuid;

  // 先验证令牌；失效则尝试刷新，拿到角色信息。
  let valid = false;
  try {
    const r = await postJson(`${p.authServer}/authserver/validate`, { accessToken, clientToken: clientToken || undefined }, { timeoutMs: 15000 });
    valid = r.status === 204 || r.ok;
  } catch { /* try refresh */ }

  if (!valid) {
    try {
      const r = await postJson(`${p.authServer}/authserver/refresh`, { accessToken, clientToken: clientToken || undefined, requestUser: true }, { timeoutMs: 20000 });
      if (r.ok && r.data?.accessToken) {
        accessToken = r.data.accessToken;
        clientToken = r.data.clientToken || clientToken;
        const sp = r.data.selectedProfile;
        if (sp) { username = sp.name || username; uuid = sp.id || uuid; valid = true; }
      }
    } catch { /* keep */ }
  }
  if (!valid) throw httpError(401, '登录令牌已失效，请回到第三方平台重新获取网址');
  if (!username) throw httpError(400, '网址里缺少用户名，无法创建账户');
  const acc = store.addAccount({
    type: 'thirdparty',
    username,
    uuid: uuid ? dashUuid(uuid) : '',
    accessToken,
    clientToken: clientToken || null,
    authServer: p.authServer,
    skinModel: 'classic',
  });
  bus.notify('success', '第三方登录成功', acc.username);
  return publicAccount(acc);
}

/* ------------------------------------------------------------------ *
 * 令牌刷新 / 有效性
 * ------------------------------------------------------------------ */

/**
 * 刷新账户令牌。
 * @param {string} accountId
 * @returns {Promise<object>} 公开账户
 */
export async function refreshAccount(accountId) {
  const acc = store.getAccount(String(accountId || ''));
  if (!acc) throw new Error('账户不存在或已被删除');

  if (acc.type === 'offline') return publicAccount(acc);

  if (acc.type === 'microsoft') {
    if (!acc.refreshToken) throw httpError(401, '该微软账户缺少刷新令牌，请重新进行微软登录');
    const r = await formPost(`${MS_OAUTH}/token`, {
      client_id: msClientId(),
      grant_type: 'refresh_token',
      refresh_token: acc.refreshToken,
      scope: MS_SCOPE,
    }, { timeoutMs: 25000 });

    if (!r.ok || !r.data || !r.data.access_token) {
      const code = String((r.data && r.data.error) || '');
      if (code === 'invalid_grant' || code === 'interaction_required') {
        throw httpError(401, '微软登录已过期，请重新登录该账户');
      }
      throw httpError(502, '刷新微软令牌失败：' + apiErrorText(r));
    }

    const chain = await xboxChain(r.data.access_token);
    const profile = await fetchMcProfile(chain.mcToken);
    const updated = store.updateAccount(acc.id, {
      username: profile.name,
      uuid: dashUuid(profile.id),
      accessToken: chain.mcToken,
      refreshToken: r.data.refresh_token || acc.refreshToken,
      expiresAt: Date.now() + (Number(chain.expiresIn) || 86400) * 1000,
      xuid: chain.xuid || acc.xuid || null,
    });
    bus.log('info', `已刷新微软账户令牌：${updated.username}`);
    return publicAccount(updated);
  }

  if (acc.type === 'thirdparty') {
    if (!acc.authServer) throw new Error('该第三方账户缺少认证服务器地址，请重新登录');
    let r;
    try {
      r = await postJson(`${acc.authServer}/authserver/refresh`, {
        accessToken: acc.accessToken,
        clientToken: acc.clientToken,
        requestUser: true,
      }, { timeoutMs: 20000 });
    } catch (e) {
      throw httpError(502, '无法连接认证服务器，请检查网络后重试：' + e.message);
    }
    if (!r.ok || !r.data || !r.data.accessToken) {
      throw httpError(401, '登录已过期，请重新登录');
    }
    const sp = r.data.selectedProfile;
    const patch = {
      accessToken: r.data.accessToken,
      clientToken: r.data.clientToken || acc.clientToken || null,
    };
    if (sp) {
      if (sp.name) patch.username = sp.name;
      if (sp.id) patch.uuid = dashUuid(sp.id);
    }
    const updated = store.updateAccount(acc.id, patch);
    bus.log('info', `已刷新第三方账户令牌：${updated.username}`);
    return publicAccount(updated);
  }

  throw new Error('未知的账户类型：' + acc.type);
}

/**
 * 确保账户可直接用于启动游戏：微软账户令牌临近过期时自动刷新。
 * 刷新失败时记录告警并返回库中的账户（避免阻塞启动流程）。
 * @param {object} account 账户对象（可以是旧快照）
 * @returns {Promise<object|null>} 库中最新的账户对象
 */
export async function ensureValid(account) {
  if (!account) return null;
  const current = (account.id && store.getAccount(account.id)) || account;
  if (current.type !== 'microsoft') return current;
  const exp = Number(current.expiresAt) || 0;
  if (exp && exp - Date.now() > REFRESH_SKEW_MS) return current;
  try {
    await refreshAccount(current.id);
  } catch (e) {
    bus.log('warn', `刷新微软令牌失败：${e.message}`);
    bus.notify('warning', '微软令牌刷新失败', e.message);
  }
  return store.getAccount(current.id) || current;
}

/* ------------------------------------------------------------------ *
 * authlib-injector
 * ------------------------------------------------------------------ */

let authlibJob = null;

/** 确保 authlib-injector.jar 已就绪（并发调用只会下载一次） */
function ensureAuthlibJar() {
  if (!authlibJob) {
    authlibJob = downloadAuthlibJar().finally(() => { authlibJob = null; });
  }
  return authlibJob;
}

async function fetchAuthlibMeta() {
  for (const url of AUTHLIB_META_URLS) {
    try {
      const r = await httpJson(url, { timeoutMs: 15000 });
      if (r.ok && r.data && r.data.download_url) {
        const sha = (r.data.checksums && r.data.checksums.sha256) || r.data.sha256 || r.data.checksum || null;
        return {
          url: String(r.data.download_url),
          sha256: sha ? String(sha).toLowerCase() : null,
          version: r.data.version || null,
        };
      }
    } catch { /* 换下一个源 */ }
  }
  return { url: AUTHLIB_FALLBACK_URL, sha256: null, version: null };
}

async function downloadAuthlibJar() {
  // 已存在且大小合理时直接复用
  try {
    const st = await fsp.stat(AUTHLIB_JAR);
    if (st.isFile() && st.size > 16 * 1024) return AUTHLIB_JAR;
  } catch { /* 不存在，继续下载 */ }

  await ensureDir(path.dirname(AUTHLIB_JAR));
  const meta = await fetchAuthlibMeta();
  if (!meta.url) throw new Error('无法获取 authlib-injector 下载地址，请检查网络或稍后重试');

  const tmp = `${AUTHLIB_JAR}.part-${process.pid}`;
  try {
    await downloadFile(meta.url, tmp, { source: 'official', retries: 3, timeoutMs: 120000 });
  } catch (e) {
    // 有旧的 jar 就先用旧的（优雅降级）
    if (await exists(AUTHLIB_JAR)) {
      bus.log('warn', `下载 authlib-injector 失败，继续使用已有文件：${e.message}`);
      return AUTHLIB_JAR;
    }
    throw new Error('下载 authlib-injector 失败：' + e.message);
  }

  if (meta.sha256) {
    let got = null;
    try { got = sha256(await fsp.readFile(tmp)); } catch { got = null; }
    if (got !== meta.sha256) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new Error('authlib-injector 校验失败（SHA-256 不匹配），已删除损坏文件，请重试');
    }
  }
  await fsp.rename(tmp, AUTHLIB_JAR);
  bus.log('info', `已下载 authlib-injector${meta.version ? ' ' + meta.version : ''}：${AUTHLIB_JAR}`);
  return AUTHLIB_JAR;
}

/**
 * 第三方账户启动参数：`-javaagent:<jar>=<authServer>`。
 * 传入的账户对象可能是启动引擎持有的旧快照，因此只依赖 authServer 字段。
 * @param {object} account
 * @returns {Promise<{args:string[], authServer:string|null}>}
 */
export async function authlibJvmArgs(account) {
  if (!account || account.type !== 'thirdparty') return { args: [], authServer: null };
  let server = account.authServer;
  if (!server && account.id) server = (store.getAccount(account.id) || {}).authServer;
  if (!server) throw httpError(400, '第三方账户缺少认证服务器地址，请重新登录');
  const authServer = normalizeAuthServer(server);
  const jar = await ensureAuthlibJar();
  return { args: [`-javaagent:${jar}=${authServer}`], authServer };
}

/* ------------------------------------------------------------------ *
 * 皮肤 / 披风
 * ------------------------------------------------------------------ */

/**
 * 读取账户皮肤信息。
 * @param {object} account
 * @returns {Promise<{name:string,id:string,skinUrl:string|null,capeUrl:string|null,model:string}>}
 */
export async function fetchProfile(account) {
  if (!account) throw new Error('账户不存在');
  const acc = (account.id && store.getAccount(account.id)) || account;
  const fallback = {
    name: acc.username,
    id: acc.uuid,
    skinUrl: null,
    capeUrl: null,
    model: normalizeSkinModel(acc.skinModel),
  };

  if (acc.type === 'offline') return fallback;

  if (acc.type === 'microsoft') {
    const fresh = await ensureValid(acc);
    if (!fresh || !fresh.accessToken) throw httpError(401, '该微软账户缺少访问令牌，请重新登录');
    let token = fresh.accessToken;
    let r = await httpJson(MC_PROFILE_URL, { headers: { Authorization: 'Bearer ' + token }, timeoutMs: 20000 });

    // 令牌可能刚好被吊销：强制刷新一次再试
    if (r.status === 401 || r.status === 403) {
      try {
        await refreshAccount(fresh.id);
        token = (store.getAccount(fresh.id) || {}).accessToken;
        if (token) r = await httpJson(MC_PROFILE_URL, { headers: { Authorization: 'Bearer ' + token }, timeoutMs: 20000 });
      } catch { /* 保留原始响应，下面统一报错 */ }
    }
    if (r.status === 404) throw httpError(403, '该微软账户没有已购买的 Minecraft: Java 版');
    if (!r.ok || !r.data || !r.data.id) throw new Error('获取 Minecraft 档案失败：' + apiErrorText(r));

    const p = r.data;
    const skins = Array.isArray(p.skins) ? p.skins : [];
    const capes = Array.isArray(p.capes) ? p.capes : [];
    const skin = skins.find((s) => s && s.state === 'ACTIVE') || skins[0] || null;
    const cape = capes.find((c) => c && c.state === 'ACTIVE') || null;
    return {
      name: p.name || acc.username,
      id: dashUuid(p.id),
      skinUrl: (skin && skin.url) || null,
      capeUrl: (cape && cape.url) || null,
      model: skin && skin.variant === 'SLIM' ? 'slim' : 'classic',
      skins,
      capes,
    };
  }

  if (acc.type === 'thirdparty') {
    if (!acc.authServer) return fallback;
    const server = normalizeAuthServer(acc.authServer);
    const rawId = String(acc.uuid || '').replace(/-/g, '');
    let r;
    try {
      r = await httpJson(`${server}/sessionserver/session/minecraft/profile/${rawId}`, { timeoutMs: 15000 });
    } catch (e) {
      bus.log('warn', `获取第三方皮肤失败：${e.message}`);
      return fallback;
    }
    if (!r.ok || !r.data || !r.data.id) return fallback;

    const prop = (r.data.properties || []).find((x) => x && x.name === 'textures');
    let textures = null;
    if (prop && prop.value) {
      try { textures = JSON.parse(Buffer.from(String(prop.value), 'base64').toString('utf8')); } catch { textures = null; }
    }
    const t = (textures && textures.textures) || {};
    const skinEntry = t.SKIN || {};
    return {
      name: r.data.name || acc.username,
      id: dashUuid(r.data.id) || acc.uuid,
      skinUrl: skinEntry.url || null,
      capeUrl: (t.CAPE && t.CAPE.url) || null,
      model: skinEntry.metadata && skinEntry.metadata.model === 'slim' ? 'slim' : normalizeSkinModel(acc.skinModel),
      textures: textures || undefined,
    };
  }

  return fallback;
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

function respondJson(res, data, status = 200) {
  if (res && typeof res.json === 'function') { res.json(data, status); return undefined; }
  if (res && typeof res.writeHead === 'function' && typeof res.end === 'function') {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return undefined;
  }
  return data;
}

function addRoute(router, method, routePath, handler) {
  const direct = router[method] || router[method.toLowerCase()];
  if (typeof direct === 'function') return direct.call(router, routePath, handler);
  if (typeof router.route === 'function') return router.route(method, routePath, handler);
  if (typeof router.add === 'function') return router.add(method, routePath, handler);
  bus.log('warn', `路由器不支持 ${method} ${routePath}，该接口未注册`);
  return undefined;
}

/** 没有皮肤时的头像兜底（外链） */
function avatarFallback(acc) {
  if (acc.type === 'offline') return `https://mc-heads.net/avatar/${encodeURIComponent(acc.username)}/64`;
  return `https://crafatar.com/avatars/${encodeURIComponent(String(acc.uuid || '').replace(/-/g, ''))}?overlay`;
}

/**
 * 注册账户相关路由。
 * @param {{get:Function,post:Function,delete?:Function}} router
 * @param {object} ctx 服务器上下文（本模块只依赖自己 import 的模块）
 */
export function register(router, ctx = {}) {
  // 注意：字面量路由先于 `:id` 路由注册，避免被参数路由抢占。
  router.get('/api/accounts', async () => store.publicState().accounts);

  router.post('/api/accounts/offline', async (req, res, c) => {
    const body = await c.body();
    return createOffline({ username: body.username, skinModel: body.skinModel });
  });

  router.post('/api/accounts/microsoft/start', async () => beginMicrosoftLogin());

  router.post('/api/accounts/microsoft/poll', async (req, res, c) => {
    const body = await c.body();
    const deviceCode = String(body.deviceCode || '').trim();
    if (!deviceCode) throw new Error('缺少设备代码（deviceCode）');
    const flow = msFlows.get(deviceCode);
    if (flow && flow.status === 'ok') {
      return { status: 'ok', account: publicAccount(store.getAccount(flow.accountId)) };
    }
    if (flow && flow.status === 'error') {
      return { status: 'error', error: flow.error };
    }
    // 后台轮询正在进行：直接回报 pending，避免重复消耗设备码
    if (flow && flow.loop && flow.status === 'pending') {
      return { status: 'pending', message: '等待用户在浏览器中完成登录' };
    }
    try {
      const account = await completeMicrosoft(deviceCode);
      return { status: 'ok', account };
    } catch (e) {
      if (e && e.pending) return { status: 'pending', message: e.message };
      return { status: 'error', error: (e && e.message) || '微软登录失败' };
    }
  });

  router.post('/api/accounts/thirdparty/url', async (req, res, c) => {
    const body = await c.body();
    return loginThirdPartyUrl({ url: body.url });
  });

  router.post('/api/accounts/thirdparty', async (req, res, c) => {
    const body = await c.body();
    return loginThirdParty({
      authServer: body.authServer,
      username: body.username,
      password: body.password,
      skinModel: body.skinModel,
    });
  });

  router.get('/api/accounts/:id/profile', async (req, res, c) => {
    const acc = store.getAccount(c.params.id);
    if (!acc) throw new Error('账户不存在或已被删除');
    return fetchProfile(acc);
  });

  // ---------------- 自定义头像 ----------------
  router.get('/api/accounts/:id/avatar', async (req, res, c) => {
    const acc = store.getAccount(c.params.id);
    if (!acc) throw new Error('账户不存在或已被删除');
    const base = path.join(ROOT, 'avatars', String(acc.uuid || acc.id).replace(/[^A-Za-z0-9-]/g, ''));
    for (const [ext, mime] of [['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]) {
      try {
        const buf = await fsp.readFile(base + ext);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        res.end(buf);
        return undefined;
      } catch { /* next */ }
    }
    // 没有自定义头像时：离线/未设置头像的账户自动使用 Steve / Alex 头部。
    const head = acc.skinModel === 'slim' ? 'alex-head.png' : 'steve-head.png';
    res.writeHead(302, { Location: `/assets/skins/${head}`, 'Cache-Control': 'no-cache' });
    res.end();
    return undefined;
  });

  router.post('/api/accounts/:id/avatar', async (req, res, c) => {
    const acc = store.getAccount(c.params.id);
    if (!acc) throw new Error('账户不存在或已被删除');
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 3 * 1024 * 1024) throw new Error('头像文件不能超过 3MB');
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    const png = buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
    const jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
    const webp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpg && !webp) throw new Error('仅支持 PNG / JPG / WebP 图片');
    await ensureDir(path.join(ROOT, 'avatars'));
    const base = path.join(ROOT, 'avatars', String(acc.uuid || acc.id).replace(/[^A-Za-z0-9-]/g, ''));
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) await fsp.rm(base + ext, { force: true }).catch(() => {});
    const ext = png ? '.png' : jpg ? '.jpg' : '.webp';
    await fsp.writeFile(base + ext, buf);
    const updated = store.updateAccount(acc.id, { avatar: `/api/accounts/${acc.id}/avatar?t=${Date.now()}` });
    bus.notify('success', '头像已更新', acc.username);
    return publicAccount(updated);
  });

  router.delete('/api/accounts/:id/avatar', async (req, res, c) => {
    const acc = store.getAccount(c.params.id);
    if (!acc) throw new Error('账户不存在或已被删除');
    const base = path.join(ROOT, 'avatars', String(acc.uuid || acc.id).replace(/[^A-Za-z0-9-]/g, ''));
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) await fsp.rm(base + ext, { force: true }).catch(() => {});
    const updated = store.updateAccount(acc.id, { avatar: null });
    return publicAccount(updated);
  });

  router.get('/api/accounts/:id/skin', async (req, res, c) => {
    const acc = store.getAccount(c.params.id);
    if (!acc) throw new Error('账户不存在或已被删除');
    // 本地上传/下载的皮肤优先（离线账户也能显示）。
    try {
      const local = path.join(ROOT, 'skins', `${String(acc.uuid || acc.id).replace(/[^A-Za-z0-9-]/g, '')}.png`);
      const buf = await fsp.readFile(local);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(buf);
      return undefined;
    } catch { /* fall through to remote */ }
    if (acc.type === 'offline') {
      const skin = acc.skinModel === 'slim' ? 'alex.png' : 'steve.png';
      res.writeHead(302, { Location: `/assets/skins/${skin}`, 'Cache-Control': 'no-cache' });
      res.end();
      return undefined;
    }
    let profile = null;
    try { profile = await fetchProfile(acc); } catch (e) { bus.log('warn', '获取皮肤失败：' + e.message); }
    const target = (profile && profile.skinUrl) || avatarFallback(acc);
    // 代理远程皮肤，避免 <img>/WebGL 纹理因跨域或防盗链加载失败。
    try {
      const r = await fetch(target, { headers: { 'User-Agent': 'CraftDeck/3.6.1', Accept: 'image/*' } });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 4 * 1024 * 1024) {
          res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/png', 'Cache-Control': 'public, max-age=300' });
          res.end(buf);
          return undefined;
        }
      }
    } catch { /* fall through */ }
    if (res && typeof res.writeHead === 'function' && typeof res.end === 'function') {
      res.writeHead(302, { Location: target, 'Cache-Control': 'public, max-age=300' });
      res.end();
      return undefined;
    }
    return respondJson(res, { url: target });
  });

  router.post('/api/accounts/:id/refresh', async (req, res, c) => {
    const acc = await refreshAccount(c.params.id);
    return acc;
  });

  addRoute(router, 'DELETE', '/api/accounts/:id', async (req, res, c) => {
    const acc = store.getAccount(c.params.id);
    if (!acc) throw new Error('账户不存在或已被删除');
    store.removeAccount(acc.id); // 同时清理 settings.lastAccountId 与实例引用
    bus.notify('info', '已删除账户', acc.username);
    return { ok: true, id: acc.id };
  });
}
