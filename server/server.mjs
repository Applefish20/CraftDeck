import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

import { ROOT, ensureLayout, instanceGameDir, LOGS_DIR, INSTANCES_DIR } from './core/paths.mjs';
import { DOWNLOADS_DIR } from './core/paths.mjs';
import { bus } from './core/events.mjs';
import { store, resolveInstance } from './core/store.mjs';
import { ensureDir, exists, jsonBody, uid, safeFileName, rmrf } from './core/util.mjs';
import { downloadFile, setDefaultThreads } from './core/downloader.mjs';
import { BUS_LOG_FILE } from './core/log.mjs';
import { launchInstance, isRunning, runningList, getLogTail, killInstance, dryRun, writeStdin } from './core/launcher.mjs';
import { listVersions, installVersion, installLoader, listLoaderVersions, resolveVersion, fetchManifest, isVersionInstalled, loaderInfoOf } from './core/versions.mjs';
import { readZipEntries } from './features/modrinth.mjs';

// Feature modules (created independently; tolerate a missing module at boot so the app still starts).
const FEATURES = [
  './features/modrinth.mjs',
  './features/accounts.mjs',
  './features/skins.mjs',
  './features/skinlibrary.mjs',
  './features/migrate.mjs',
  './features/feedback.mjs',
  './features/update.mjs',
  './features/installed.mjs',
  './features/servers.mjs',
  './features/hosts.mjs',
  './features/translation.mjs',
  './features/terracotta.mjs',
  './features/toolbox.mjs',
  './features/mcmod.mjs',
  './features/webresources.mjs',
  './features/news.mjs',
  './features/saves.mjs',
];

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const activeDownloads = new Map();
global.__MCL_REGISTER_TASK__ = (id, controller) => activeDownloads.set(id, controller);
global.__MCL_UNREGISTER_TASK__ = (id) => activeDownloads.delete(id);
const API_TOKEN = process.env.MCL_API_TOKEN || crypto.randomBytes(16).toString('hex');
const AUTH_DISABLED = process.env.MCL_NO_AUTH === '1';
const WEB_DIR = path.join(APP_ROOT, 'web');
const MEDIA_DIR = path.join(ROOT, 'media');
// 实例根目录由 paths.mjs 统一决定（便携模式为 minecraft/）。

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
};

/** 把本地地图/投影压缩包或单文件导入到实例。 */
async function importLocalArchive(file, instanceId, kind, originalName) {
  const gameDir = instanceGameDir(instanceId);
  const ext = path.extname(originalName || file).toLowerCase();
  if (kind === 'schematic') {
    const dir = path.join(gameDir, 'schematics');
    await ensureDir(dir);
    if (ext === '.zip') {
      const entries = await readZipEntries(file);
      const base = safeFileName(path.basename(originalName || '投影', '.zip')) || '投影';
      const target = path.join(dir, base);
      await ensureDir(target);
      let files = 0;
      for (const e of entries) {
        const dest = path.resolve(target, e.name);
        if (!dest.startsWith(target + path.sep)) continue;
        await ensureDir(path.dirname(dest));
        await fsp.writeFile(dest, e.data);
        files++;
      }
      return { path: target, files };
    }
    const name = safeFileName(originalName || `投影${ext || ''}`) || `投影${ext || ''}`;
    await fsp.copyFile(file, path.join(dir, name));
    return { path: path.join(dir, name), files: 1 };
  }
  if (ext !== '.zip') throw new Error('地图请选择 .zip 压缩包');
  const entries = await readZipEntries(file);
  const level = entries.filter((e) => /(^|\/)level\.dat$/i.test(e.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (!level) throw new Error('压缩包内没有找到 level.dat，可能不是地图存档');
  const root = level.name.includes('/') ? level.name.slice(0, level.name.lastIndexOf('/')) : '';
  const name = safeFileName(root ? path.basename(root) : path.basename(originalName || '地图', '.zip')) || '地图';
  const target = path.join(gameDir, 'saves', name);
  await ensureDir(target);
  let files = 0;
  for (const e of entries) {
    if (root && !e.name.startsWith(root + '/')) continue;
    const rel = root ? e.name.slice(root.length + 1) : e.name;
    if (!rel) continue;
    const dest = path.resolve(target, rel);
    if (!dest.startsWith(target + path.sep)) continue;
    await ensureDir(path.dirname(dest));
    await fsp.writeFile(dest, e.data);
    files++;
  }
  return { path: target, files };
}

class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const escaped = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m)
      .replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    const re = new RegExp('^' + escaped + '/?$');
    this.routes.push({ method, re, keys, handler, pattern });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
    }
    return null;
  }
}

const router = new Router();

function send(res, status, body, headers = {}) {
  // Streaming handlers (SSE) have already sent headers; never write twice.
  if (res.writableEnded || res.headersSent) return;
  const isJson = typeof body === 'object' && body !== null;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : String(body ?? ''));
}

function apiErrorStatus(e) {
  if (e.status) return e.status;
  if (/不存在|请先|未找到|缺少|无效|not found/i.test(e.message || '')) return 404;
  if (/不允许|不支持|已存在|已经在运行|没有/.test(e.message || '')) return 400;
  return 500;
}

async function exportMultiMc(inst) {
  const stage = path.join(DOWNLOADS_DIR, 'exports', `${safeFileName(inst.name)}-${uid()}`);
  const mine = path.join(stage, '.minecraft');
  await ensureDir(mine);
  for (const name of ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'saves', 'scripts', 'kubejs', 'options.txt', 'servers.dat']) {
    const src = path.join(instanceGameDir(inst.id), name);
    if (await exists(src)) await fsp.cp(src, path.join(mine, name), { recursive: true, force: true });
  }
  const loader = inst.loader || { type: 'vanilla' };
  const uidMap = {
    fabric: 'net.fabricmc.fabric-loader', quilt: 'org.quiltmc.quilt-loader',
    forge: 'net.minecraftforge', neoforge: 'net.neoforged', liteloader: 'com.mumfrey.liteloader',
  };
  const components = [{ uid: 'net.minecraft', version: inst.versionId || '', cachedName: 'Minecraft' }];
  if (uidMap[loader.type] && loader.version) components.push({ uid: uidMap[loader.type], version: String(loader.version) });
  await fsp.writeFile(path.join(stage, 'mmc-pack.json'), JSON.stringify({ formatVersion: 1, components }, null, 2));
  await fsp.writeFile(path.join(stage, 'instance.cfg'), `name=${inst.name}\nInstanceType=OneSix\n`);
  const outDir = path.join(DOWNLOADS_DIR, 'exports');
  await ensureDir(outDir);
  const out = path.join(outDir, `${safeFileName(inst.name)}-multimc.zip`);
  await fsp.rm(out, { force: true }).catch(() => {});
  const { execFile } = await import('node:child_process');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path ${q(path.join(stage, 'mmc-pack.json'))},${q(path.join(stage, 'instance.cfg'))},${q(path.join(stage, '.minecraft'))} -DestinationPath ${q(out)} -Force`,
    ], { windowsHide: true }, (err) => err ? reject(err) : resolve());
  });
  await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  return out;
}

async function handleApi(req, res, url) {
  const token = String(req.headers['x-craftdeck-token'] || url.searchParams.get('t') || '');
  // 图片只读接口用 <img> 直接加载，无法带自定义头，单独放行。
  const imageRead = req.method === 'GET' && /^\/api\/(accounts\/[^/]+\/(skin|avatar)|skins\/library\/image|skins\/mine\/[^/]+\/image|skins\/local\/[^/]+|instances\/[^/]+\/modicon|news\/image|csl\/[^/]+)$/.test(url.pathname);
  if (!AUTH_DISABLED && token !== API_TOKEN && !imageRead) {
    return send(res, 403, { ok: false, error: '禁止访问：缺少或错误的本地 API 令牌' });
  }
  const m = router.match(req.method, url.pathname);
  if (!m) return send(res, 404, { ok: false, error: '接口不存在: ' + url.pathname });
  const ctx = {
    params: m.params,
    query: Object.fromEntries(url.searchParams),
    instanceId: m.params.instanceId,
    instance: m.params.instanceId ? store.getInstance(m.params.instanceId) : null,
    store,
    state: store.state,
    root: ROOT,
    body: () => jsonBody(req),
    bus,
    app: { store, bus, ROOT },
  };
  try {
    const out = await m.route.handler(req, res, ctx);
    if (!res.writableEnded) {
      if (out === undefined) send(res, 200, { ok: true });
      else if (out && typeof out === 'object' && out.__raw) {
        res.writeHead(out.status || 200, { 'Content-Type': out.contentType || 'application/octet-stream', ...(out.headers || {}) });
        res.end(out.body);
      } else send(res, 200, out);
    }
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (!/账户校验失败/.test(message)) bus.log('error', `API ${url.pathname}: ${message}`);
    if (!res.writableEnded) send(res, apiErrorStatus(e), { ok: false, error: message });
  }
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  let file;
  if (pathname.startsWith('/media/')) {
    file = path.join(MEDIA_DIR, pathname.slice('/media/'.length));
  } else if (pathname.startsWith('/instance-media/')) {
    const rest = pathname.slice('/instance-media/'.length).split('/');
    const id = rest.shift();
    file = path.join(INSTANCES_DIR, id, ...rest);
  } else {
    file = path.join(WEB_DIR, pathname);
  }
  const normalized = path.normalize(file);
  const allowedRoots = [WEB_DIR, MEDIA_DIR, INSTANCES_DIR];
  if (!allowedRoots.some((r) => normalized.startsWith(r + path.sep) || normalized === r)) {
    return send(res, 403, '禁止访问');
  }
  try {
    const stat = await fsp.stat(normalized);
    if (stat.isDirectory()) return send(res, 404, '未找到');
    const ext = path.extname(normalized).toLowerCase();
    const isMedia = normalized.startsWith(MEDIA_DIR) || normalized.startsWith(INSTANCES_DIR);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': isMedia ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(normalized).pipe(res);
  } catch {
    send(res, 404, '未找到');
  }
}

function startSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const onEvent = (e) => {
    try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* ignore */ }
  };
  bus.on('event', onEvent);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', onEvent);
  });
}

export function registerCoreRoutes() {
  router.get('/api/health', () => ({ ok: true, name: 'CraftDeck', version: '3.6.1', root: ROOT, pid: process.pid }));

  router.get('/api/state', () => ({ ...store.publicState(), running: runningList() }));

  router.patch('/api/settings', async (req, res, ctx) => {
    const patch = await ctx.body();
    const settings = store.updateSettings(patch);
    if ('downloadThreads' in patch) setDefaultThreads(settings.downloadThreads);
    return { ok: true, settings };
  });

  // ---------------- instances
  router.get('/api/instances', () => ({ instances: store.instances.map((i) => ({ ...i, running: isRunning(i.id) })) }));

  router.post('/api/instances', async (req, res, ctx) => {
    const b = await ctx.body();
    const inst = store.addInstance({
      name: (b.name || '新实例').slice(0, 60),
      versionId: b.versionId || null,
      loader: b.loader || { type: 'vanilla', version: null },
      accountId: b.accountId || store.settings.lastAccountId || null,
      installing: b.installing === true,
    });
    return { ok: true, instance: inst };
  });

  router.get('/api/instances/:instanceId', (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    return { instance: ctx.instance, running: isRunning(ctx.instance.id), log: getLogTail(ctx.instance.id, 200) };
  });

  router.patch('/api/instances/:instanceId', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const b = await ctx.body();
    const allowed = ['name', 'versionId', 'loader', 'accountId', 'javaPath', 'memoryMb', 'jvmArgs', 'notes', 'modsEnabled', 'icon', 'cover', 'modpackIcon', 'favorite'];
    const patch = {};
    for (const k of allowed) if (k in b) patch[k] = b[k];
    if (patch.name) patch.name = String(patch.name).slice(0, 60);
    for (const k of ['icon', 'cover', 'modpackIcon']) {
      if (k in patch) {
        if (patch[k] !== null && (typeof patch[k] !== 'string' || patch[k].length > 3_000_000)) throw new Error('图片数据无效或过大');
      }
    }
    if ('memoryMb' in patch && patch.memoryMb !== null) patch.memoryMb = Math.max(512, Math.min(32768, Number(patch.memoryMb) || 2048));
    return { ok: true, instance: store.updateInstance(ctx.instance.id, patch) };
  });

  router.delete('/api/instances/:instanceId', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    if (isRunning(ctx.instance.id)) await killInstance(ctx.instance.id);
    const ok = store.removeInstance(ctx.instance.id);
    const dir = path.join(INSTANCES_DIR, ctx.instance.id);
    if (path.resolve(dir).startsWith(INSTANCES_DIR)) await rmrf(dir);
    return { ok };
  });

  router.post('/api/instances/:instanceId/launch', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const b = await ctx.body().catch(() => ({}));
    const r = await launchInstance(ctx.instance.id, b);
    return r;
  });

  router.post('/api/instances/:instanceId/kill', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    return { ok: await killInstance(ctx.instance.id) };
  });

  router.get('/api/instances/:instanceId/log', (req, res, ctx) => ({
    lines: getLogTail(ctx.instance.id, Number(ctx.query.tail) || 400),
    running: isRunning(ctx.instance.id),
  }));

  /** 下载第三方直链并导入为地图或投影。 */
  router.post('/api/instances/:instanceId/import-url', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const b = await ctx.body().catch(() => ({}));
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('请输入 http/https 直链');
    const kind = b.kind === 'schematic' ? 'schematic' : 'map';
    const u = new URL(url);
    const ext = (path.extname(u.pathname) || '').toLowerCase();
    const temp = path.join(DOWNLOADS_DIR, `import-${uid()}${ext || '.bin'}`);
    await ensureDir(DOWNLOADS_DIR);
    try {
      await downloadFile(url, temp, { source: 'official', retries: 2, timeoutMs: 300000 });
      const gameDir = instanceGameDir(ctx.instance.id);
      if (kind === 'schematic') {
        const dir = path.join(gameDir, 'schematics');
        await ensureDir(dir);
        if (ext === '.zip') {
          const entries = await readZipEntries(temp);
          const name = safeFileName(path.basename(u.pathname, '.zip')) || '投影';
          const target = path.join(dir, name);
          await ensureDir(target);
          let files = 0;
          for (const e of entries) {
            const dest = path.resolve(target, e.name);
            if (!dest.startsWith(target + path.sep)) continue;
            await ensureDir(path.dirname(dest));
            await fsp.writeFile(dest, e.data);
            files++;
          }
          return { ok: true, path: target, files };
        }
        const name = safeFileName(path.basename(u.pathname)) || `投影${ext || ''}`;
        await fsp.copyFile(temp, path.join(dir, name));
        return { ok: true, path: path.join(dir, name), files: 1 };
      }

      if (ext !== '.zip') throw new Error('地图需要下载 .zip 压缩包');
      const entries = await readZipEntries(temp);
      const level = entries.filter((e) => /(^|\/)level\.dat$/i.test(e.name)).sort((a, b2) => a.name.length - b2.name.length)[0];
      if (!level) throw new Error('压缩包内没有找到 level.dat，可能不是地图存档');
      const root = level.name.includes('/') ? level.name.slice(0, level.name.lastIndexOf('/')) : '';
      const name = safeFileName(root ? path.basename(root) : path.basename(u.pathname, '.zip')) || '地图';
      const target = path.join(gameDir, 'saves', name);
      await ensureDir(target);
      let files = 0;
      for (const e of entries) {
        if (root && !e.name.startsWith(root + '/')) continue;
        const rel = root ? e.name.slice(root.length + 1) : e.name;
        if (!rel) continue;
        const dest = path.resolve(target, rel);
        if (!dest.startsWith(target + path.sep)) continue;
        await ensureDir(path.dirname(dest));
        await fsp.writeFile(dest, e.data);
        files++;
      }
      return { ok: true, path: target, files };
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {});
    }
  });

  /** 上传本地地图/投影文件并导入。 */
  router.post('/api/instances/:instanceId/import-file', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const kind = req.headers['x-kind'] === 'schematic' ? 'schematic' : 'map';
    const originalName = decodeURIComponent(String(req.headers['x-filename'] || ''));
    const ext = (path.extname(originalName) || '').toLowerCase();
    const temp = path.join(DOWNLOADS_DIR, `local-${uid()}${ext || '.bin'}`);
    await ensureDir(DOWNLOADS_DIR);
    const chunks = [];
    let total = 0;
    try {
      for await (const c of req) {
        total += c.length;
        if (total > 1024 * 1024 * 1024) throw new Error('文件不能超过 1GB');
        chunks.push(c);
      }
      if (!chunks.length) throw new Error('文件为空');
      await fsp.writeFile(temp, Buffer.concat(chunks));
      const result = await importLocalArchive(temp, ctx.instance.id, kind, originalName);
      return { ok: true, ...result };
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {});
    }
  });

  /** 导出实例为 MultiMC / Prism 兼容压缩包。 */
  router.post('/api/instances/:instanceId/export-modpack', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const file = await exportMultiMc(ctx.instance);
    return { ok: true, path: file };
  });

  /** Open the instance game folder (or one content subfolder) in the OS file manager. */
  router.post('/api/instances/:instanceId/open', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const b = await ctx.body().catch(() => ({}));
    const allowed = ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'logs', 'config', 'screenshots', 'schematics'];
    const sub = allowed.includes(b.type) ? b.type : '';
    const { spawn } = await import('node:child_process');
    const dir = path.join(INSTANCES_DIR, ctx.instance.id, 'minecraft', sub);
    await ensureDir(dir);
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } catch (e) {
      throw new Error('无法打开文件管理器: ' + e.message);
    }
    return { ok: true, dir };
  });

  /** List files in an instance content folder (mods / resourcepacks / shaderpacks). */
  router.get('/api/instances/:instanceId/files', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const type = ['mods', 'resourcepacks', 'shaderpacks'].includes(ctx.query.type) ? ctx.query.type : 'mods';
    const dir = path.join(INSTANCES_DIR, ctx.instance.id, 'minecraft', type);
    await ensureDir(dir);
    const files = [];
    for (const name of await fsp.readdir(dir)) {
      if (!/\.(jar|zip|mrpack|disabled)$/i.test(name)) continue;
      try {
        const st = await fsp.stat(path.join(dir, name));
        files.push({ name, size: st.size, mtime: st.mtimeMs, disabled: /\.disabled$/i.test(name) });
      } catch { /* ignore */ }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { type, dir, files };
  });

  /** Enable/disable a mod by renaming it to .disabled. */
  router.post('/api/instances/:instanceId/files/toggle', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const b = await ctx.body();
    const type = ['mods', 'resourcepacks', 'shaderpacks'].includes(b.type) ? b.type : 'mods';
    const name = path.basename(String(b.name || ''));
    if (!name) throw new Error('缺少文件名');
    const dir = path.join(INSTANCES_DIR, ctx.instance.id, 'minecraft', type);
    const src = path.join(dir, name);
    if (!src.startsWith(dir)) throw new Error('非法路径');
    if (name.endsWith('.disabled')) {
      const dest = path.join(dir, name.slice(0, -'.disabled'.length));
      await fsp.rename(src, dest);
      return { ok: true, name: path.basename(dest), disabled: false };
    }
    const dest = src + '.disabled';
    await fsp.rename(src, dest);
    return { ok: true, name: path.basename(dest), disabled: true };
  });

  router.delete('/api/instances/:instanceId/files', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const b = await ctx.body().catch(() => ({}));
    const type = ['mods', 'resourcepacks', 'shaderpacks'].includes(b.type) ? b.type : 'mods';
    const name = path.basename(String(b.name || ''));
    if (!name) throw new Error('缺少文件名');
    const dir = path.join(INSTANCES_DIR, ctx.instance.id, 'minecraft', type);
    const file = path.join(dir, name);
    if (!file.startsWith(dir)) throw new Error('非法路径');
    await fsp.rm(file, { force: true });
    return { ok: true };
  });

  router.post('/api/instances/:instanceId/command', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    if (!isRunning(ctx.instance.id)) throw new Error('该实例未在运行');
    const b = await ctx.body();
    if (!b.command) throw new Error('缺少命令内容');
    writeStdin(ctx.instance.id, b.command);
    return { ok: true };
  });

  router.get('/api/instances/:instanceId/dryrun', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    return dryRun(ctx.instance.id, ctx.query.accountId);
  });

  // ---------------- versions
  router.get('/api/versions', async (req, res, ctx) => listVersions({
    includeSnapshots: ctx.query.snapshots === '1' || undefined,
    includeOld: ctx.query.old === '1' || undefined,
    query: ctx.query.q || '',
  }));

  router.get('/api/versions/installed', async () => {
    const ids = [];
    try {
      for (const d of await fsp.readdir(path.join(ROOT, 'launcher', 'shared', 'versions'))) {
        const j = path.join(ROOT, 'launcher', 'shared', 'versions', d, d + '.json');
        if (await exists(j)) {
          const json = JSON.parse(await fsp.readFile(j, 'utf8'));
          ids.push({ id: d, inheritsFrom: json.inheritsFrom || null, loader: json.__loader || null, type: json.type });
        }
      }
    } catch { /* ignore */ }
    return { installed: ids };
  });

  router.get('/api/versions/loaders', async (req, res, ctx) => {
    const { type, gameVersion } = ctx.query;
    if (!type || !gameVersion) throw new Error('需要 type 与 gameVersion 参数');
    return { versions: await listLoaderVersions(type, gameVersion) };
  });

  router.get('/api/versions/:versionId', async (req, res, ctx) => {
    const id = ctx.params.versionId;
    const json = await resolveVersion(id).catch(async () => null);
    return { id, installed: await isVersionInstalled(id), json: json ? { id: json.id, type: json.type, mainClass: json.mainClass, assets: json.assets, javaVersion: json.javaVersion, libraries: (json.libraries || []).length } : null };
  });

  router.post('/api/versions/install', async (req, res, ctx) => {
    const b = await ctx.body();
    if (!b.versionId) throw new Error('缺少 versionId');
    const taskId = b.taskId || uid('task_');
    const result = await installVersion(b.versionId, { taskId });
    return { ok: true, versionId: b.versionId, total: result.total };
  });

  router.post('/api/versions/loader', async (req, res, ctx) => {
    const b = await ctx.body();
    if (!b.versionId || !b.loader || b.loader === 'vanilla') throw new Error('参数不完整');
    const taskId = b.taskId || uid('task_');
    const id = await installLoader(b.loader, b.versionId, b.loaderVersion || null, { taskId });
    if (b.instanceId) {
      const inst = store.getInstance(b.instanceId);
      if (inst) store.updateInstance(inst.id, { loader: { type: b.loader, version: b.loaderVersion || loaderInfoOf(id)?.version || null, versionId: id } });
    }
    return { ok: true, versionId: id };
  });

  router.post('/api/versions/manifest/refresh', async () => {
    const m = await fetchManifest({ force: true });
    return { ok: true, latest: m.latest, count: m.versions.length };
  });

  /** Download a mod file to downloads/mods without requiring an instance. */
  router.post('/api/mods/download', async (req, res, ctx) => {
    const b = await ctx.body();
    const mod = await import('./features/modrinth.mjs').catch(() => null);
    if (!mod) throw new Error('模组模块未加载');
    const vers = await mod.versions(b.projectId, {});
    const v = (b.versionId && vers.find((x) => x.id === b.versionId)) || vers[0];
    if (!v) throw new Error('没有可用文件');
    const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
    if (!file) throw new Error('版本缺少文件');
    const dir = path.join(DOWNLOADS_DIR, 'mods');
    await ensureDir(dir);
    const dest = path.join(dir, safeFileName(file.filename || `mod-${v.id}.jar`));
    await downloadFile(file.url, dest, { sha1: file.hashes?.sha1, size: file.size, timeoutMs: 600000, retries: 3 });
    return { ok: true, path: dest, fileName: path.basename(dest) };
  });

  /** Download a resource/shader file to downloads without requiring an instance. */
  router.post('/api/resources/download', async (req, res, ctx) => {
    const b = await ctx.body();
    const mod = await import('./features/modrinth.mjs').catch(() => null);
    if (!mod) throw new Error('模组模块未加载');
    const vers = await mod.versions(b.projectId, {});
    const v = (b.versionId && vers.find((x) => x.id === b.versionId)) || vers[0];
    if (!v) throw new Error('没有可用文件');
    const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
    if (!file) throw new Error('版本缺少文件');
    const sub = b.kind === 'shader' ? 'shaderpacks' : 'resourcepacks';
    const dir = path.join(DOWNLOADS_DIR, sub);
    await ensureDir(dir);
    const dest = path.join(dir, safeFileName(file.filename || `pack-${v.id}.zip`));
    await downloadFile(file.url, dest, { sha1: file.hashes?.sha1, size: file.size, timeoutMs: 600000, retries: 3 });
    return { ok: true, path: dest, fileName: path.basename(dest) };
  });

  /** Online modpack install (Modrinth project): download .mrpack then install it via the modpacks feature. */
  router.post('/api/modpacks/install-project', async (req, res, ctx) => {
    const b = await ctx.body();
    if (!b.projectId) throw new Error('缺少 projectId');
    const mod = await import('./features/modrinth.mjs').catch(() => null);
    if (!mod) throw new Error('整合包模块未加载');
    const vers = await mod.versions(b.projectId, {});
    if (!vers || !vers.length) throw new Error('没有找到可安装的整合包文件');
    const v = (b.versionId && vers.find((x) => x.id === b.versionId)) || vers.find((x) => x.version_type === 'release') || vers[0];
    const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
    if (!file) throw new Error('整合包版本缺少文件');
    const dir = path.join(DOWNLOADS_DIR, 'modpacks');
    await ensureDir(dir);
    const dest = path.join(dir, `${safeFileName(b.name || b.projectId)}-${safeFileName(v.id)}.mrpack`);
    bus.progress({ taskId: 'modpack-' + b.projectId, scope: 'modpack', label: `下载整合包 ${file.filename}`, percent: 0.05 });
    await downloadFile(file.url, dest, {
      sha1: file.hashes?.sha1, size: file.size, timeoutMs: 600000, retries: 3,
      onProgress: (p) => bus.progress({
        taskId: 'modpack-' + b.projectId, scope: 'modpack', label: `下载整合包 ${file.filename}`,
        percent: p.total ? 0.05 + 0.25 * (p.received / p.total) : 0.2,
        bytes: p.received, totalBytes: p.total,
      }),
    });
    const created = [];
    const result = await mod.installModpackFromFile({
      filePath: dest,
      instanceId: b.instanceId || null,
      taskId: 'modpack-' + b.projectId,
      onInstanceCreated: ({ name, versionId, loader, mrpackName }) => {
        const inst = store.addInstance({
          name: String(name || b.name || '整合包实例').slice(0, 60),
          versionId: versionId || null,
          loader: loader || { type: 'vanilla', version: null },
          mrpackName: mrpackName || b.name || null,
          accountId: store.settings.lastAccountId || null,
          icon: b.iconUrl || null,
          cover: b.iconUrl || null,
          modpackIcon: b.iconUrl || null,
        });
        created.push(inst);
        return inst;
      },
    });
    // Kick off game files + loader in the background for the newly created instance only.
    const inst = created[0] || null;
    if (inst) backgroundSetup(inst, result?.loader || inst.loader || { type: 'vanilla' });
    return { ok: true, ...result, instanceId: inst?.id || b.instanceId || null };
  });

  /** Register the Java scan route early so the UI always has it. */
  router.get('/api/java', async () => {
    try {
      const mod = await import('./core/java.mjs');
      if (typeof mod.findJavas === 'function') {
        const javas = await mod.findJavas();
        return { javas, java: javas };
      }
    } catch { /* ignore */ }
    return { javas: [] };
  });

  /** One-shot instance setup: create game files + optional mod loader, async with SSE progress. */
  router.post('/api/instances/:instanceId/setup', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const b = await ctx.body();
    if (!b.versionId) throw new Error('缺少 versionId');
    const inst = ctx.instance;
    store.updateInstance(inst.id, { installing: true });
    const taskId = b.taskId || uid('task_');
    const loaderType = b.loader && b.loader !== 'vanilla' ? b.loader : 'vanilla';
    const controller = new AbortController();
    activeDownloads.set(taskId, controller);
    const runs = async () => {
      try {
        bus.progress({ taskId, scope: 'setup', label: `准备 ${b.versionId}`, versionId: b.versionId, percent: 0 });
        await installVersion(b.versionId, { taskId, signal: controller.signal });
        let loaderVersionId = null;
        if (loaderType !== 'vanilla') {
          loaderVersionId = await installLoader(loaderType, b.versionId, b.loaderVersion || null, { taskId, signal: controller.signal });
        }
        const loaderInfo = loaderVersionId ? loaderInfoOf(loaderVersionId) : null;
        store.updateInstance(inst.id, {
          versionId: b.versionId,
          installing: false,
          loader: loaderType === 'vanilla'
            ? { type: 'vanilla', version: null }
            : { type: loaderType, version: loaderInfo?.version || b.loaderVersion || null, versionId: loaderVersionId },
        });
        bus.progress({ taskId, scope: 'setup', label: '安装完成', finished: true, ok: true, percent: 1, versionId: b.versionId, loaderVersionId });
        bus.notify('success', '实例准备完成', `${inst.name} · ${b.versionId}${loaderType !== 'vanilla' ? ' · ' + loaderType : ''}`);
      } catch (e) {
        if (controller.signal.aborted) {
          bus.progress({ taskId, scope: 'setup', label: '已暂停', finished: true, ok: false, error: '已暂停，已下载的文件会保留', versionId: b.versionId });
          bus.notify('info', '安装已暂停', '重新点安装会从已下载的文件继续');
        } else {
          bus.progress({ taskId, scope: 'setup', label: '安装失败', finished: true, ok: false, error: e.message });
          bus.notify('error', '安装失败', e.message);
        }
      } finally {
        activeDownloads.delete(taskId);
      }
    };
    runs();
    return { ok: true, taskId, accepted: true };
  });

  router.post('/api/tasks/:taskId/cancel', async (req, res, ctx) => {
    const id = String(ctx.params.taskId || '');
    const ctrl = activeDownloads.get(id);
    if (!ctrl) return { ok: false, message: '任务已结束或不存在' };
    ctrl.abort();
    return { ok: true, canceled: true, taskId: id };
  });

  // ---------------- media / backgrounds
  router.post('/api/media/upload', async (req, res, ctx) => {
    const ct = String(req.headers['content-type'] || '');
    let ext = '.png';
    let buf;
    if (ct.includes('multipart/form-data')) {
      const raw = await readRaw(req, 30 * 1024 * 1024);
      const parsed = parseMultipart(raw, ct);
      if (!parsed) throw new Error('无法解析上传内容');
      const mime = parsed.contentType || 'image/png';
      ext = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : mime.includes('mp4') ? '.mp4' : '.png';
      buf = parsed.data;
    } else {
      buf = await readRaw(req, 30 * 1024 * 1024);
      const name = req.headers['x-filename'] || 'background.png';
      ext = path.extname(String(name)).toLowerCase() || '.png';
    }
    await ensureDir(MEDIA_DIR);
    const file = path.join(MEDIA_DIR, `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await fsp.writeFile(file, buf);
    return { ok: true, url: '/media/' + path.basename(file), size: buf.length };
  });

  router.get('/api/media/list', async () => {
    const list = [];
    try {
      for (const f of await fsp.readdir(MEDIA_DIR)) {
        if (/\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(f)) list.push({ url: '/media/' + f, name: f, mtime: (await fsp.stat(path.join(MEDIA_DIR, f))).mtimeMs });
      }
    } catch { /* ignore */ }
    return { files: list.sort((a, b) => b.mtime - a.mtime) };
  });

  // ---------------- system
  router.get('/api/system', async () => {
    const os = await import('node:os');
    const totalMem = os.totalmem();
    return {
      platform: process.platform, arch: process.arch, cpus: os.cpus().length,
      totalMemMb: Math.round(totalMem / 1024 / 1024), freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      hostname: os.hostname(), node: process.version, root: ROOT,
      running: runningList(),
    };
  });

  router.get('/api/events', (req, res) => startSse(req, res));
  router.get('/api/logs', () => ({ lines: bus.history.slice(-300) }));
  router.get('/api/logs/file', async (req, res, ctx) => {
    const tail = Math.max(50, Math.min(5000, Number(ctx.query.tail) || 800));
    try {
      const text = await fsp.readFile(path.join(LOGS_DIR, 'launcher.log'), 'utf8');
      return { lines: text.split(/\r?\n/).filter(Boolean).slice(-tail) };
    } catch {
      return { lines: [] };
    }
  });
}

async function readRaw(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limit) throw new Error('文件过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Install game files + mod loader for an instance in the background (used by modpack installs). */
async function backgroundSetup(inst, loader) {
  if (!inst || !inst.versionId) return;
  store.updateInstance(inst.id, { installing: true });
  const taskId = uid('task_');
  try {
    bus.progress({ taskId, scope: 'setup', label: `为 ${inst.name} 准备游戏文件`, versionId: inst.versionId, percent: 0 });
    await installVersion(inst.versionId, { taskId });
    let loaderVersionId = null;
    const type = loader?.type || 'vanilla';
    if (type !== 'vanilla') {
      loaderVersionId = await installLoader(type, inst.versionId, loader.version || null, { taskId });
    }
    store.updateInstance(inst.id, {
      installing: false,
      loader: type === 'vanilla' ? { type: 'vanilla', version: null } : { ...loader, type, versionId: loaderVersionId },
    });
    bus.progress({ taskId, scope: 'setup', label: '整合包准备完成', finished: true, ok: true, percent: 1 });
    bus.notify('success', '整合包准备完成', `${inst.name} 现在可以启动了`);
  } catch (e) {
    bus.progress({ taskId, scope: 'setup', label: '整合包准备失败', finished: true, ok: false, error: e.message });
    bus.notify('error', '整合包准备失败', e.message);
  }
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const parts = [];
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next < 0) break;
    const chunk = buf.subarray(pos + boundary.length + 2, next - 2);
    parts.push(chunk);
    pos = next;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.subarray(0, headerEnd).toString('utf8');
    if (!/filename=/i.test(headers)) continue;
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
    return { data: part.subarray(headerEnd + 4), contentType: ct ? ct[1].trim() : 'image/png' };
  }
  return null;
}

async function cleanupTempFiles(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', '.git', 'media', 'skins', 'avatars'].includes(ent.name)) continue;
      await cleanupTempFiles(p, depth + 1);
    } else if (/\.(part|merge)-[^/\\]+$/i.test(ent.name) || /\.part-\d+-\d+$/i.test(ent.name)) {
      await fsp.rm(p, { force: true }).catch(() => {});
    }
  }
}

export async function createServer() {
  ensureLayout();
  await cleanupTempFiles(ROOT);
  setDefaultThreads(store.settings.downloadThreads || 12);
  await ensureDir(MEDIA_DIR);
  await ensureDir(INSTANCES_DIR);
  registerCoreRoutes();

  const loaded = [];
  // Load feature modules in parallel to shorten cold start; register in a stable order.
  const modules = await Promise.all(FEATURES.map(async (mod) => {
    try { return { mod, m: await import(mod) }; }
    catch (e) {
      bus.log('warn', `功能模块 ${mod} 加载失败: ${e.message}`);
      console.error(`[feature] ${mod} failed:`, e);
      return { mod, m: null };
    }
  }));
  for (const { mod, m } of modules) {
    if (m && typeof m.register === 'function') {
      try {
        m.register(router, { store, bus, ROOT, router });
        loaded.push(mod);
      } catch (e) {
        bus.log('warn', `功能模块 ${mod} 注册失败: ${e.message}`);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url);
  });

  server.on('error', (e) => {
    console.error('HTTP 服务错误:', e.message);
    bus.log('error', 'HTTP 服务错误: ' + e.message);
  });

  return { server, router, features: loaded };
}

export async function startServer(port = Number(process.env.MCL_PORT) || 0, host = '127.0.0.1', { retryPorts = 0 } = {}) {
  const { server, features } = await createServer();
  let p = port;
  for (let i = 0; i <= retryPorts; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.off('listening', onListening); reject(e); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p, host);
      });
      break;
    } catch (e) {
      if (e && e.code === 'EADDRINUSE' && p && i < retryPorts) {
        console.log(`端口 ${p} 被占用，尝试 ${p + 1}…`);
        p++;
        continue;
      }
      throw e;
    }
  }
  const addr = server.address();
  global.__CRAFTDECK_PORT__ = addr.port;
  const url = `http://${host}:${addr.port}`;
  return { server, port: addr.port, url, loadUrl: `${url}/?t=${API_TOKEN}`, token: API_TOKEN, features };
}

function boot() {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.MCL_PORT) || 0;
  const open = args.includes('--open');

  startServer(port, '127.0.0.1', { retryPorts: port ? 12 : 0 }).then(async ({ url, loadUrl, server }) => {
    console.log('');
    console.log('  CraftDeck 启动器已就绪');
    console.log(`  本地地址: ${loadUrl}`);
    console.log(`  数据目录: ${ROOT}`);
    console.log('  按 Ctrl+C 退出');
    console.log('');
    bus.log('info', `启动器已就绪: ${url}`);
    if (open) {
      const { spawn } = await import('node:child_process');
      const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', loadUrl] : [loadUrl];
      spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    // Expose for desktop wrapper
    if (typeof global.__MCL_ON_READY__ === 'function') global.__MCL_ON_READY__(loadUrl);
    global.__MCL_URL__ = loadUrl;
    process.on('SIGINT', () => { store.flush(); server.close(() => process.exit(0)); });
    process.on('SIGTERM', () => { store.flush(); server.close(() => process.exit(0)); });
  }).catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) boot();

export { router, ROOT, store, bus, BUS_LOG_FILE, safeFileName };
