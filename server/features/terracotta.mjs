/**
 * 陶瓦联机（Terracotta）集成。
 * 通过 Terracotta 官方 HTTP API 创建/加入房间，不修改其二进制、不链接其代码。
 * Terracotta 由 burningtnt 开发，AGPL-3.0-or-later；本项目仅在界面中调用其公开 HTTP 接口并注明版权。
 * 文档：https://burningtnt.github.io/Terracotta/http-api/
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { ROOT } from '../core/paths.mjs';
import { ensureDir, exists, readJson, writeJson, uid, safeFileName } from '../core/util.mjs';
import { downloadFile, fetchJson } from '../core/downloader.mjs';
import { bus } from '../core/events.mjs';
import { store } from '../core/store.mjs';

const TC_DIR = path.join(ROOT, 'terracotta');
const PORT_FILE = path.join(TC_DIR, 'ipc-port.json');
const VERSION_FILE = path.join(TC_DIR, 'version.json');
const GITHUB_API = 'https://api.github.com/repos/burningtnt/Terracotta/releases/latest';
const GITEE = 'https://gitee.com/burningtnt/Terracotta/releases/download';
const STATE_TIMEOUT = 1800;
const POLL_MS = 1000;

const EXCEPTIONS = {
  0: '无法连接房主（房间已关闭或网络不稳定）',
  1: '与房主的连接中断',
  2: '加入方 EasyTier 崩溃',
  3: '房主 EasyTier 崩溃',
  4: '房主端 Minecraft 服务器失联（房主退出存档后房间会自动关闭）',
  5: '陶瓦内部协议错误，请向陶瓦开发者反馈',
};

let runtime = {
  port: null,
  child: null,
  polling: null,
  lastState: { state: 'waiting', index: 0 },
  consecutiveErrors: 0,
  startedAt: null,
  lastError: null,
  running: false,
};

function exePath() {
  try {
    const files = fs.readdirSync(TC_DIR).filter((f) => /\.exe$/i.test(f));
    if (!files.length) return null;
    const archTag = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const exact = files.find((f) => f.toLowerCase().includes(`windows-${archTag}`));
    return path.join(TC_DIR, exact || files[0]);
  } catch {
    return null;
  }
}

/** Minimal POSIX tar reader (ustar/pax) for the Terracotta release archive. */
function extractTarGz(buffer, targetDir) {
  const tar = zlib.gunzipSync(buffer);
  let offset = 0;
  let lastLongName = null;
  const written = [];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) continue;
    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeStr = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    let name = rawName;
    if (type === 'x' || type === 'g') {
      const data = tar.subarray(offset, offset + size).toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(data);
      if (m) lastLongName = m[1];
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    if (lastLongName) { name = lastLongName; lastLongName = null; }
    else if (prefix) name = prefix + '/' + name;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === '5' || name.endsWith('/')) {
      fs.mkdirSync(path.join(targetDir, name), { recursive: true });
      continue;
    }
    const normalized = path.normalize(name).replace(/^([/\\])+/, '');
    if (normalized.includes('..')) continue;
    const out = path.join(targetDir, normalized);
    if (!out.startsWith(targetDir + path.sep) && out !== targetDir) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    written.push(normalized);
  }
  return written;
}

export async function latestRelease() {
  const rel = await fetchJson(GITHUB_API, { timeoutMs: 20000, retries: 2, source: 'official' });
  const tag = rel.tag_name || '';
  const archTag = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const asset = (rel.assets || []).find((a) => a.name.includes(`windows-${archTag}-pkg`))
    || (rel.assets || []).find((a) => /windows.*\.tar\.gz$/i.test(a.name));
  if (!asset) throw new Error('未能从 Terracotta 发布页找到 Windows 版本');
  return { tag, name: asset.name, url: asset.browser_download_url, size: asset.size || 0, notes: rel.body || '' };
}

export async function ensureInstalled({ force = false } = {}) {
  await ensureDir(TC_DIR);
  const exe = exePath();
  const meta = await readJson(VERSION_FILE, null);
  if (!force && exe && meta?.version) return { installed: true, exe, version: meta.version };
  const rel = await latestRelease();
  const cache = path.join(TC_DIR, `${safeFileName(rel.name)}`);
  // Prefer the Gitee mirror (much faster in mainland China), fall back to GitHub.
  const candidates = [`${GITEE}/${rel.tag}/${rel.name}`, rel.url];
  let lastErr = null;
  for (const url of candidates) {
    try {
      bus.progress({ taskId: 'terracotta-install', scope: 'terracotta', label: `下载陶瓦联机 ${rel.tag}`, percent: 0.1 });
      await downloadFile(url, cache, {
        size: rel.size || 0, source: 'official', timeoutMs: 180000, retries: 2,
        onProgress: (p) => bus.progress({
          taskId: 'terracotta-install', scope: 'terracotta', label: '下载陶瓦联机',
          percent: p.total ? 0.1 + 0.6 * (p.received / p.total) : 0.3,
          bytes: p.received, totalBytes: p.total,
        }),
      });
      lastErr = null;
      break;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw new Error('下载陶瓦联机失败: ' + lastErr.message);
  bus.progress({ taskId: 'terracotta-install', scope: 'terracotta', label: '解压陶瓦联机', percent: 0.8 });
  // Remove binaries from older architectures so only the current one remains.
  try {
    for (const f of await fsp.readdir(TC_DIR)) {
      if (/\.exe$/i.test(f)) await fsp.rm(path.join(TC_DIR, f), { force: true });
    }
  } catch { /* ignore */ }
  const buf = await fsp.readFile(cache);
  extractTarGz(buf, TC_DIR);
  const newExe = exePath();
  if (!newExe) throw new Error('解压后未找到陶瓦联机可执行文件');
  await writeJson(VERSION_FILE, { version: rel.tag, name: rel.name, installedAt: Date.now() });
  await fsp.rm(cache, { force: true });
  bus.progress({ taskId: 'terracotta-install', scope: 'terracotta', label: '陶瓦联机安装完成', percent: 1, finished: true, ok: true });
  bus.notify('success', '陶瓦联机已安装', `版本 ${rel.tag}`);
  return { installed: true, exe: newExe, version: rel.tag };
}

async function readPortFile() {
  try {
    const v = JSON.parse(await fsp.readFile(PORT_FILE, 'utf8'));
    return Number(v.port) || null;
  } catch {
    return null;
  }
}

async function apiGet(pathname, timeout = 4000) {
  if (!runtime.port) throw new Error('陶瓦联机未启动');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const err = new Error(`陶瓦接口返回 ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

function decorate(state) {
  if (!state) return state;
  const out = { ...state };
  if (state.state === 'exception') out.message = EXCEPTIONS[state.type] || '陶瓦联机发生未知异常';
  if (state.state === 'guest-ok' && state.url) out.directAddress = state.url.includes(':') ? state.url : `${state.url}:25565`;
  if (state.state === 'host-ok' && state.room) out.roomCode = state.room;
  return out;
}

async function pollOnce() {
  try {
    const state = await apiGet('/state', STATE_TIMEOUT);
    runtime.consecutiveErrors = 0;
    if (state && (state.state !== runtime.lastState.state || state.index !== runtime.lastState.index)) {
      runtime.lastState = state;
      bus.emitEvent({ type: 'terracotta', state: decorate(state), port: runtime.port });
    } else {
      runtime.lastState = state;
    }
  } catch (e) {
    runtime.consecutiveErrors++;
    if (runtime.consecutiveErrors >= 5) {
      runtime.lastError = '与陶瓦联机的连接已断开';
      stopPolling();
      runtime.port = null;
      runtime.child = null;
      runtime.running = false;
      bus.emitEvent({ type: 'terracotta', state: { state: 'disconnected' }, error: runtime.lastError });
    }
  }
}

function startPolling() {
  stopPolling();
  runtime.polling = setInterval(pollOnce, POLL_MS);
  if (runtime.polling.unref) runtime.polling.unref();
  pollOnce();
}

function stopPolling() {
  if (runtime.polling) { clearInterval(runtime.polling); runtime.polling = null; }
}

export async function status() {
  const meta = await readJson(VERSION_FILE, null);
  const exe = exePath();
  const installed = !!exe;
  if (runtime.port && runtime.running) {
    // Probe liveness without disturbing the poll state.
    try { await apiGet('/meta', 1200); } catch { /* polling handles */ }
  }
  return {
    installed,
    running: !!runtime.port && runtime.running,
    version: meta?.version || null,
    port: runtime.port,
    state: decorate(runtime.lastState || { state: 'waiting', index: 0 }),
    startedAt: runtime.startedAt,
    error: runtime.lastError,
    attribution: 'Terracotta 陶瓦联机 · burningtnt · AGPL-3.0-or-later',
  };
}

export async function start() {
  if (runtime.port && runtime.running) return status();
  await ensureInstalled();
  const exe = exePath();
  if (!exe) throw new Error('陶瓦联机尚未安装');
  try { await fsp.rm(PORT_FILE, { force: true }); } catch { /* ignore */ }
  const child = spawn(exe, ['--hmcl', PORT_FILE], {
    cwd: TC_DIR,
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
    env: { ...process.env },
  });
  runtime.child = child;
  runtime.startedAt = Date.now();
  runtime.lastError = null;
  runtime.lastState = { state: 'waiting', index: 0 };
  child.on('exit', () => {
    // On Windows the `--hmcl` bootstrap process forks a worker and exits immediately,
    // so a child exit does not mean the service is gone. Probe before declaring it dead.
    setTimeout(async () => {
      if (!runtime.port) return;
      try {
        await apiGet('/meta', 1500);
      } catch {
        stopPolling();
        runtime.port = null;
        runtime.running = false;
        runtime.child = null;
        bus.emitEvent({ type: 'terracotta', state: { state: 'disconnected' } });
      }
    }, 1200);
  });
  child.on('error', (e) => {
    runtime.lastError = '无法启动陶瓦联机: ' + e.message;
    bus.log('error', runtime.lastError);
  });

  let port = null;
  for (let i = 0; i < 48; i++) {
    await new Promise((r) => setTimeout(r, 250));
    port = await readPortFile();
    if (port) break;
    if (child.exitCode !== null) break;
  }
  if (!port) {
    runtime.lastError = '陶瓦联机启动超时（端口文件未生成）';
    throw new Error(runtime.lastError + '。请确认 Windows 10+ 且已安装 VC++ 运行库。');
  }
  runtime.port = port;
  runtime.running = true;
  try {
    const meta = await apiGet('/meta', 3000);
    bus.log('info', `陶瓦联机已启动 v${meta.version}，端口 ${port}`);
  } catch { /* ignore */ }
  startPolling();
  bus.emitEvent({ type: 'terracotta', state: decorate(runtime.lastState), port });
  return status();
}

export async function stop() {
  if (!runtime.port) {
    stopPolling();
    runtime.child = null;
    runtime.running = false;
    return { ok: true, running: false };
  }
  try { await apiGet('/panic?peaceful=true', 3000); } catch { /* process exits and closes the socket */ }
  const child = runtime.child;
  stopPolling();
  runtime.port = null;
  runtime.running = false;
  runtime.lastState = { state: 'waiting', index: 0 };
  await new Promise((r) => setTimeout(r, 500));
  if (child && child.exitCode === null) {
    try { child.kill(); } catch { /* ignore */ }
  }
  runtime.child = null;
  bus.emitEvent({ type: 'terracotta', state: { state: 'stopped' } });
  return { ok: true, running: false };
}

export async function host({ player = '' } = {}) {
  if (!runtime.port) await start();
  const name = player || store.getAccount(store.settings.lastAccountId)?.username || 'CraftDeck';
  await apiGet(`/state/scanning?player=${encodeURIComponent(name)}`, 6000);
  await new Promise((r) => setTimeout(r, 600));
  await pollOnce();
  return status();
}

export async function guest({ room, player = '' } = {}) {
  if (!runtime.port) await start();
  const code = String(room || '').trim();
  if (!code) throw new Error('请填写房间邀请码');
  if (!/^[A-Za-z0-9+/=_-]{4,64}$/.test(code)) throw new Error('房间邀请码格式不正确');
  const name = player || store.getAccount(store.settings.lastAccountId)?.username || 'CraftDeck';
  try {
    await apiGet(`/state/guesting?room=${encodeURIComponent(code)}&player=${encodeURIComponent(name)}`, 6000);
  } catch (e) {
    if (e.status === 400) throw new Error('邀请码无效，或陶瓦当前不处于待机状态');
    throw e;
  }
  await new Promise((r) => setTimeout(r, 600));
  await pollOnce();
  return status();
}

export async function reset() {
  if (!runtime.port) return { ok: true };
  await apiGet('/state/ide', 3000);
  runtime.lastState = { state: 'waiting', index: 0 };
  bus.emitEvent({ type: 'terracotta', state: runtime.lastState });
  return { ok: true };
}

export async function log() {
  if (!runtime.port) return { log: '' };
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/log?fetch=true`);
    return { log: await res.text() };
  } catch (e) {
    return { log: '', error: e.message };
  }
}

export function register(router) {
  router.get('/api/terracotta/status', async () => status());
  router.post('/api/terracotta/install', async (req, res, ctx) => {
    const b = await ctx.body().catch(() => ({}));
    return ensureInstalled({ force: !!b.force });
  });
  router.post('/api/terracotta/start', async () => start());
  router.post('/api/terracotta/stop', async () => stop());
  router.post('/api/terracotta/host', async (req, res, ctx) => host(await ctx.body().catch(() => ({}))));
  router.post('/api/terracotta/guest', async (req, res, ctx) => guest(await ctx.body().catch(() => ({}))));
  router.post('/api/terracotta/reset', async () => reset());
  router.get('/api/terracotta/log', async () => log());
}

// 进程退出时尽量优雅关闭陶瓦，避免残留后台进程。
process.on('exit', () => {
  if (runtime.child && runtime.child.exitCode === null) {
    try { runtime.child.kill(); } catch { /* ignore */ }
  }
});
