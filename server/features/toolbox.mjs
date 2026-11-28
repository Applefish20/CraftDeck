/**
 * 百宝箱：内存优化、缓存清理、文件校验、网络诊断、端口检测、日志导出、设置重置。
 * 全部为本地操作，不联网执行危险命令。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import v8 from 'node:v8';
import { ROOT, INSTANCES_DIR, DOWNLOADS_DIR, LOGS_DIR, CACHE_DIR, instanceGameDir } from '../core/paths.mjs';
import { ensureDir, exists, formatBytes, uid, safeFileName } from '../core/util.mjs';
import { bus } from '../core/events.mjs';
import { store, resolveInstance } from '../core/store.mjs';
import { installVersion, resolveVersion, resetManifestCache } from '../core/versions.mjs';
import { runningList } from '../core/launcher.mjs';
import { downloadFile, setDefaultThreads } from '../core/downloader.mjs';
import { DEFAULT_SETTINGS } from '../core/store.mjs';

function forceGc() {
  try {
    if (typeof global.gc === 'function') { global.gc(); return true; }
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    if (typeof gc === 'function') { gc(); return true; }
  } catch { /* ignore */ }
  return false;
}

async function dirSize(dir, filter = null) {
  let total = 0;
  let count = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          const st = await fsp.stat(p);
          if (!filter || filter(p, st)) { total += st.size; count++; }
        } catch { /* ignore */ }
      }
    }
  };
  await walk(dir);
  return { bytes: total, count };
}

function memSnapshot() {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round(m.rss / 1048576),
    heapUsedMb: Math.round(m.heapUsed / 1048576),
    heapTotalMb: Math.round(m.heapTotal / 1048576),
    externalMb: Math.round(m.external / 1048576),
  };
}

async function cleanOldParts() {
  let bytes = 0;
  let count = 0;
  const roots = [DOWNLOADS_DIR, path.join(ROOT, 'launcher')];
  for (const root of roots) {
    const walk = async (d) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { await walk(p); continue; }
        if (/\.part(-\d+-\d+)?$|\.tmp-\d+$/.test(e.name)) {
          try { const st = await fsp.stat(p); await fsp.rm(p, { force: true }); bytes += st.size; count++; } catch { /* ignore */ }
        }
      }
    };
    await walk(root);
  }
  return { bytes, count };
}

export async function toolboxStatus() {
  if (!storageCache && !storagePromise) {
    storagePromise = computeStorage().catch(() => {}).finally(() => { storagePromise = null; });
  }
  return {
    memory: memSnapshot(),
    gcAvailable: typeof global.gc === 'function',
    disk: storageCache || { cache: 0, logs: 0, downloads: 0, instances: 0, shared: 0, root: ROOT },
    storagePending: !storageCache,
    running: runningList(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
}

let storageCache = null;
let storagePromise = null;

async function computeStorage() {
  const [cache, logs, downloads, instances, shared] = await Promise.all([
    dirSize(CACHE_DIR),
    dirSize(LOGS_DIR),
    dirSize(DOWNLOADS_DIR),
    dirSize(INSTANCES_DIR),
    dirSize(path.join(ROOT, 'launcher', 'shared')),
  ]);
  storageCache = {
    cache: cache.bytes, logs: logs.bytes, downloads: downloads.bytes,
    instances: instances.bytes, shared: shared.bytes, root: ROOT,
  };
  return storageCache;
}

export async function toolboxStorage() {
  if (storageCache) return { disk: storageCache, pending: false };
  await computeStorage();
  return { disk: storageCache, pending: false };
}

export async function optimizeMemory() {
  const before = memSnapshot();
  resetManifestCache();
  bus.history.splice(0, Math.max(0, bus.history.length - 120));
  const gcRan = forceGc();
  await new Promise((r) => setTimeout(r, 350));
  const after = memSnapshot();
  const freed = Math.max(0, before.rssMb - after.rssMb);
  bus.log('info', `内存优化完成：RSS ${before.rssMb}MB → ${after.rssMb}MB（释放 ${freed}MB）`);
  return { ok: true, before, after, freedMb: freed, gcRan };
}

export async function clean({ targets = ['cache', 'logs', 'temp', 'installers', 'modpacks'] } = {}) {
  let bytes = 0;
  const details = {};
  const rm = async (dir) => {
    const size = await dirSize(dir);
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    await ensureDir(dir);
    return size.bytes;
  };
  if (targets.includes('cache')) { details.cache = await rm(CACHE_DIR); bytes += details.cache; }
  if (targets.includes('logs')) {
    const size = await dirSize(LOGS_DIR);
    try {
      for (const f of await fsp.readdir(LOGS_DIR)) {
        if (/\.log(\.\d+)?$/.test(f)) await fsp.rm(path.join(LOGS_DIR, f), { force: true });
      }
    } catch { /* ignore */ }
    details.logs = size.bytes; bytes += size.bytes;
  }
  if (targets.includes('installers')) {
    details.installers = await rm(path.join(DOWNLOADS_DIR, 'installers'));
    bytes += details.installers;
  }
  if (targets.includes('modpacks')) {
    details.modpacks = await rm(path.join(DOWNLOADS_DIR, 'modpacks'));
    bytes += details.modpacks;
  }
  if (targets.includes('temp')) {
    const t = await cleanOldParts();
    details.temp = t.bytes; bytes += t.bytes;
  }
  forceGc();
  storageCache = null;
  bus.log('info', `清理完成，释放 ${(bytes / 1048576).toFixed(1)} MB`);
  return { ok: true, freedBytes: bytes, freedText: formatBytes(bytes), details };
}

export async function verifyInstance(instanceId) {
  const inst = resolveInstance(instanceId);
  if (!inst) throw new Error('实例不存在');
  if (!inst.versionId) throw new Error('该实例还没有选择游戏版本');
  const taskId = uid('verify_');
  const run = async () => {
    try {
      await installVersion(inst.versionId, { taskId });
      bus.notify('success', '文件校验完成', `${inst.name} · ${inst.versionId} 的文件完整`);
    } catch (e) {
      bus.notify('error', '文件校验失败', e.message);
    }
  };
  run();
  return { ok: true, taskId, versionId: inst.versionId };
}

const NET_TARGETS = [
  { key: 'mojang', name: 'Mojang 版本清单', url: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', method: 'HEAD' },
  { key: 'modrinth', name: 'Modrinth API', url: 'https://api.modrinth.com/v2/search?query=sodium&limit=1', method: 'GET' },
  { key: 'github', name: 'GitHub API', url: 'https://api.github.com/repos/burningtnt/Terracotta/releases/latest', method: 'GET' },
  { key: 'gitee', name: 'Gitee 镜像', url: 'https://gitee.com/burningtnt/Terracotta/releases', method: 'HEAD' },
  { key: 'bmcl', name: 'BMCLAPI 镜像', url: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json', method: 'HEAD' },
];

export async function networkTest() {
  const results = await Promise.all(NET_TARGETS.map(async (t) => {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(t.url, { method: t.method, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      return { key: t.key, name: t.name, ok: res.ok, status: res.status, ms: Date.now() - start };
    } catch (e) {
      return { key: t.key, name: t.name, ok: false, status: 0, ms: Date.now() - start, error: e.name === 'AbortError' ? '超时' : e.message };
    }
  }));
  return { results, at: Date.now() };
}

function testPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve({ port, free: false, error: e.code }));
    srv.once('listening', () => srv.close(() => resolve({ port, free: true })));
    srv.listen(port, '127.0.0.1');
  });
}

export async function portCheck() {
  const ports = [25555, 25556, 25565, 25566, 25570];
  const results = await Promise.all(ports.map(testPort));
  return { ports: results, serverPort: Number(process.env.MCL_PORT) || null };
}

export async function exportLogs() {
  const dir = path.join(DOWNLOADS_DIR, 'diagnostics');
  await ensureDir(dir);
  const file = path.join(dir, `CraftDeck-diagnostics-${Date.now()}.txt`);
  const lines = [];
  lines.push('CraftDeck 诊断报告');
  lines.push('时间: ' + new Date().toISOString());
  lines.push('Node: ' + process.version + ' / ' + process.platform + ' ' + process.arch);
  lines.push('数据目录: ' + ROOT);
  lines.push('设置: ' + JSON.stringify({ ...store.settings, curseforgeApiKey: store.settings.curseforgeApiKey ? '***' : '' }, null, 2));
  lines.push('实例: ' + JSON.stringify(store.instances.map((i) => ({ id: i.id, name: i.name, versionId: i.versionId, loader: i.loader })), null, 2));
  lines.push('内存: ' + JSON.stringify(memSnapshot()));
  lines.push('运行中的游戏: ' + JSON.stringify(runningList()));
  lines.push('');
  lines.push('---- 启动器日志（最近 500 行）----');
  lines.push(...bus.history.slice(-500).map((e) => `[${new Date(e.ts).toISOString()}] ${e.type} ${e.level || ''} ${e.message || e.label || ''}`));
  await fsp.writeFile(file, lines.join('\n'), 'utf8');
  return { ok: true, path: file, size: (await fsp.stat(file)).size };
}

export async function resetSettings() {
  const keep = { lastAccountId: store.settings.lastAccountId, lastInstanceId: store.settings.lastInstanceId, microsoftClientId: store.settings.microsoftClientId, curseforgeApiKey: store.settings.curseforgeApiKey };
  store.updateSettings({ ...DEFAULT_SETTINGS, ...keep, onboarded: true });
  return { ok: true, settings: store.settings };
}

export async function customDownload({ url, filename, target = 'downloads', instanceId } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('请输入 http/https 下载地址');
  const inst = instanceId ? resolveInstance(instanceId) : null;
  let dir;
  if (['mods', 'resourcepacks', 'shaderpacks'].includes(target)) {
    if (!inst) throw new Error('选择模组/材质目标时需要指定实例');
    dir = path.join(instanceGameDir(inst.id), target);
  } else {
    dir = path.join(DOWNLOADS_DIR, 'custom');
  }
  await ensureDir(dir);
  let base = filename || '';
  if (!base) {
    try { base = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download.bin'); } catch { base = 'download.bin'; }
  }
  const dest = path.join(dir, safeFileName(base));
  const taskId = uid('dl_');
  (async () => {
    try {
      await downloadFile(url, dest, {
        timeoutMs: 10 * 60 * 1000, retries: 2,
        onProgress: (p) => bus.progress({
          taskId, scope: 'custom', label: '自定义下载 ' + path.basename(dest),
          percent: p.total ? p.received / p.total : 0, bytes: p.received, totalBytes: p.total,
        }),
      });
      bus.notify('success', '自定义下载完成', path.basename(dest));
    } catch (e) {
      bus.notify('error', '自定义下载失败', e.message);
    }
  })();
  return { ok: true, taskId, path: dest, dir };
}

export function register(router) {
  router.get('/api/toolbox/status', async () => toolboxStatus());
  router.get('/api/toolbox/storage', async () => toolboxStorage());
  router.post('/api/toolbox/optimize', async () => optimizeMemory());
  router.post('/api/toolbox/clean', async (req, res, ctx) => clean(await ctx.body().catch(() => ({}))));
  router.post('/api/toolbox/verify', async (req, res, ctx) => {
    const b = await ctx.body();
    return verifyInstance(b.instanceId);
  });
  router.post('/api/toolbox/download', async (req, res, ctx) => customDownload(await ctx.body().catch(() => ({}))));
  router.get('/api/toolbox/network', async () => networkTest());
  router.get('/api/toolbox/ports', async () => portCheck());
  router.post('/api/toolbox/export-logs', async () => exportLogs());
  router.post('/api/toolbox/reset-settings', async () => resetSettings());
}
