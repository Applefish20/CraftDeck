/**
 * server/features/modrinth.mjs
 * Modrinth 模组 / 资源包 / 光影 / 整合包 的搜索、版本查询与安装。
 * 同时支持 .mrpack（Modrinth 整合包）与 CurseForge 整合包 .zip 的解析安装。
 *
 * 零依赖：只使用 Node 24 内置模块（fetch / zlib / crypto / fs）。
 * ZIP 读取为自己实现的极简解析器（只读，支持 stored/deflate，走中央目录）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { ensureDir, exists, jsonBody, uid } from '../core/util.mjs';
import { DOWNLOADS_DIR, instanceGameDir } from '../core/paths.mjs';
import { downloadFile, fetchJson } from '../core/downloader.mjs';
import { bus } from '../core/events.mjs';
import { store } from '../core/store.mjs';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MODRINTH_API = 'https://api.modrinth.com/v2';
// Modrinth 要求 UA 中带应用名与版本（便于他们统计/联系）
const USER_AGENT = 'CraftDeck/1.0.0 (Minecraft launcher; +https://github.com/craftdeck)';
const CACHE_TTL = 60 * 1000;          // 搜索/项目信息的进程内缓存时间
const MAX_DEP_DEPTH = 8;              // 模组依赖递归深度上限
const PACK_CONCURRENCY = 4;           // 整合包文件并发下载数
const DEFAULT_MAX_UPLOAD_MB = Math.max(64, Number(process.env.MCL_MAX_UPLOAD_MB) || 4096);
function uploadLimitMb() {
  const v = Number(store.settings?.maxUploadMb);
  return Math.max(64, Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_UPLOAD_MB);
}
function uploadLimitBytes() { return uploadLimitMb() * 1024 * 1024; }
function uploadLimitText() {
  const mb = uploadLimitMb();
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const TYPE_MAP = {
  mod: 'mod',
  mods: 'mod',
  modpack: 'modpack',
  modpacks: 'modpack',
  resourcepack: 'resourcepack',
  resourcepacks: 'resourcepack',
  shader: 'shader',
  shaders: 'shader',
  datapack: 'datapack',
  datapacks: 'datapack',
};

const SEARCH_INDEXES = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);

// ===========================================================================
// 一、极简 ZIP 读取器（中央目录 + stored/deflate）
// ===========================================================================

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC32（ZIP 条目校验用）。 */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

async function readAt(fh, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** 解析中央目录中的 ZIP64 扩展字段（0x0001），补齐被置为 0xFFFFFFFF 的字段。 */
function applyZip64Extra(extra, entry) {
  if (!extra || extra.length < 4) return;
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    const body = extra.subarray(p + 4, p + 4 + len);
    if (id === 0x0001) {
      let q = 0;
      if (entry.size === 0xffffffff && q + 8 <= body.length) { entry.size = Number(body.readBigUInt64LE(q)); q += 8; }
      if (entry.compressedSize === 0xffffffff && q + 8 <= body.length) { entry.compressedSize = Number(body.readBigUInt64LE(q)); q += 8; }
      if (entry.localOffset === 0xffffffff && q + 8 <= body.length) { entry.localOffset = Number(body.readBigUInt64LE(q)); }
      return;
    }
    p += 4 + len;
  }
}

function parseCentralDirectory(cd) {
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressedSize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen > cd.length) break;
    // 名称按 UTF-8 解码（绝大多数打包工具如此，ASCII 名称两种编码一致）
    // 部分 Windows 工具会用反斜杠作为路径分隔符，统一成 / 以便跨平台还原目录结构。
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const entry = {
      name,
      method,
      crc32: crc,
      compressedSize,
      size,
      localOffset,
      flags,
      isDir: name.endsWith('/'),
    };
    applyZip64Extra(extra, entry);
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readCentralDirectory(fh, fileSize) {
  if (fileSize < 22) throw new Error('不是有效的 ZIP 文件（文件过小）');
  const tailLen = Math.min(fileSize, 66560);
  const tail = await readAt(fh, fileSize - tailLen, tailLen);

  // 从尾部向前找 EOCD 签名 0x06054b50（尾部可能带注释）
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');

  let total = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  const eocdAbs = fileSize - tailLen + eocd;

  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64：先找 ZIP64 EOCD 定位器（20 字节）
    try {
      const loc = await readAt(fh, Math.max(0, eocdAbs - 20), 20);
      if (loc.length === 20 && loc.readUInt32LE(0) === 0x07064b50) {
        const z64Off = Number(loc.readBigUInt64LE(8));
        const z64 = await readAt(fh, z64Off, 56);
        if (z64.length >= 56 && z64.readUInt32LE(0) === 0x06064b50) {
          total = Number(z64.readBigUInt64LE(32));
          cdSize = Number(z64.readBigUInt64LE(40));
          cdOffset = Number(z64.readBigUInt64LE(48));
        }
      }
    } catch { /* ZIP64 读取失败则退回 32 位字段 */ }
  }

  if (!Number.isFinite(cdOffset) || !Number.isFinite(cdSize) || cdSize <= 0 || cdSize > 128 * 1024 * 1024) {
    throw new Error('ZIP 中央目录损坏');
  }
  const cd = await readAt(fh, cdOffset, cdSize);
  const entries = parseCentralDirectory(cd);
  if (!entries.length) throw new Error('ZIP 中没有可读取的条目');
  return entries.slice(0, total > 0 ? total : entries.length);
}

/**
 * 打开一个 ZIP 文件，返回可复用句柄。
 * 只需少量条目时用它避免重复解析中央目录。
 */
async function openZip(filePath) {
  const abs = path.resolve(String(filePath || ''));
  let fh;
  try {
    fh = await fsp.open(abs, 'r');
  } catch {
    throw new Error(`无法打开文件：${abs}`);
  }
  try {
    const st = await fh.stat();
    const entries = await readCentralDirectory(fh, st.size);
    const byName = new Map(entries.map((e) => [e.name, e]));
    return {
      path: abs,
      size: st.size,
      entries,
      byName,
      has: (name) => byName.has(name),
      /** 读取并解压单个条目（按中央目录记录的长度切分，可容忍 data descriptor）。 */
      async read(entry) {
        if (!entry) throw new Error('ZIP 条目不存在');
        if (entry.isDir) return Buffer.alloc(0);
        if (entry.compressedSize > MAX_ENTRY_BYTES) throw new Error(`ZIP 条目过大：${entry.name}`);
        const lh = await readAt(fh, entry.localOffset, 30);
        if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) {
          throw new Error(`ZIP 本地文件头损坏：${entry.name}`);
        }
        const nameLen = lh.readUInt16LE(26);
        const extraLen = lh.readUInt16LE(28);
        const dataStart = entry.localOffset + 30 + nameLen + extraLen;
        const raw = await readAt(fh, dataStart, entry.compressedSize);
        let data;
        if (entry.method === 0) data = raw;
        else if (entry.method === 8) {
          try {
            data = zlib.inflateRawSync(raw);
          } catch (e) {
            throw new Error(`ZIP 解压失败（${entry.name}）：${e.message}`);
          }
        } else {
          throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`);
        }
        if (entry.crc32 && crc32(data) !== entry.crc32) throw new Error(`ZIP 条目校验失败：${entry.name}`);
        return data;
      },
      async readByName(name) {
        const e = byName.get(name);
        return e ? this.read(e) : null;
      },
      async readJson(name) {
        const buf = await this.readByName(name);
        if (!buf) return null;
        try {
          return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
        } catch (e) {
          throw new Error(`${name} 解析失败：${e.message}`);
        }
      },
      async close() {
        try { await fh.close(); } catch { /* ignore */ }
      },
    };
  } catch (e) {
    try { await fh.close(); } catch { /* ignore */ }
    throw e;
  }
}

/** 列出 ZIP 内所有条目元数据（不解压）。 */
export async function listZipEntries(filePath) {
  const zip = await openZip(filePath);
  try {
    return zip.entries.map((e) => ({
      name: e.name,
      size: e.size,
      compressedSize: e.compressedSize,
      method: e.method,
      crc32: e.crc32,
      isDir: e.isDir,
    }));
  } finally {
    await zip.close();
  }
}

/**
 * 读取 ZIP 中满足条件的条目内容。
 * @param {string} filePath
 * @param {(name:string)=>boolean} [filterFn]
 * @returns {Promise<Array<{name:string,size:number,compressedSize:number,method:number,data:Buffer}>>}
 */
export async function readZipEntries(filePath, filterFn) {
  const zip = await openZip(filePath);
  try {
    const out = [];
    for (const entry of zip.entries) {
      if (entry.isDir) continue;
      if (typeof filterFn === 'function' && !filterFn(entry.name)) continue;
      const data = await zip.read(entry);
      out.push({
        name: entry.name,
        size: entry.size,
        compressedSize: entry.compressedSize,
        method: entry.method,
        data,
      });
    }
    return out;
  } finally {
    await zip.close();
  }
}

// ===========================================================================
// 二、Modrinth API 封装（带 60s 内存缓存）
// ===========================================================================

const cache = new Map();

function pruneCache(now) {
  for (const [k, v] of cache) {
    if (v.exp <= now) cache.delete(k);
  }
}

/** 以 Promise 为单位缓存，避免同一时刻重复请求；失败时立即清除缓存以便重试。 */
function memo(key, producer, ttl = CACHE_TTL) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.value;
  const p = Promise.resolve().then(producer);
  cache.set(key, { exp: now + ttl, value: p });
  if (cache.size > 256) pruneCache(now);
  p.catch(() => { const cur = cache.get(key); if (cur && cur.value === p) cache.delete(key); });
  return p;
}

/** 把底层网络错误翻译成中文提示。 */
function cnNetworkError(err, what = 'Modrinth') {
  const msg = String(err && err.message ? err.message : err);
  const status = /HTTP (\d{3})/.exec(msg);
  if (status) {
    const code = Number(status[1]);
    if (code === 404) return `${what} 上找不到请求的资源（404）`;
    if (code === 401 || code === 403) return `${what} 拒绝访问（${code}），可能需要配置 API Key`;
    if (code === 429) return `${what} 请求过于频繁（429），请稍后再试`;
    if (code >= 500) return `${what} 服务器错误（${code}），请稍后再试`;
    return `${what} 请求失败（${code}）`;
  }
  if (/abort|timeout|timed out/i.test(msg)) return `${what} 请求超时，请检查网络后重试`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network/i.test(msg)) {
    return `无法连接 ${what} 服务器，请检查网络连接`;
  }
  return `${what} 请求失败：${msg}`;
}

async function apiGet(pathname, { timeoutMs = 15000 } = {}) {
  const url = MODRINTH_API + pathname;
  try {
    return await fetchJson(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      source: 'official',
      timeoutMs,
      retries: 2,
    });
  } catch (e) {
    throw new Error(cnNetworkError(e, 'Modrinth'));
  }
}

function normalizeType(type) {
  return TYPE_MAP[String(type || '').trim().toLowerCase()] || 'mod';
}

/** 实例内部使用 'vanilla' 表示无加载器，查询 Modrinth 时应当视为“不筛选”。 */
function normalizeLoader(loader) {
  const v = String(loader || '').trim().toLowerCase();
  if (!v || v === 'vanilla' || v === 'none' || v === '原版') return '';
  return v;
}

/** GET /search —— 返回 Modrinth 原始响应（UI 读取 hits / total_hits）。 */
export async function search({
  query = '',
  type = 'mod',
  gameVersion = '',
  loader = '',
  index = 'relevance',
  offset = 0,
  limit = 20,
  categories = [],
} = {}) {
  const projectType = normalizeType(type);
  const facets = [[`project_type:${projectType}`]];
  const gv = String(gameVersion || '').trim();
  const ld = normalizeLoader(loader);
  if (gv) facets.push([`versions:${gv}`]);
  if (ld) facets.push([`categories:${ld}`]);

  const cats = (Array.isArray(categories) ? categories : String(categories || '').split(','))
    .map((c) => String(c || '').trim().toLowerCase())
    .filter(Boolean);
  if (cats.length) facets.push(cats.map((c) => `categories:${c}`));

  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const sort = SEARCH_INDEXES.has(String(index)) ? String(index) : 'relevance';

  const qs = new URLSearchParams({
    query: String(query || ''),
    index: sort,
    offset: String(off),
    limit: String(lim),
    facets: JSON.stringify(facets),
  });
  const key = `search:${qs.toString()}`;
  const data = await memo(key, () => apiGet(`/search?${qs.toString()}`));
  return {
    ...data,
    hits: Array.isArray(data?.hits) ? data.hits : [],
    total_hits: Number(data?.total_hits) || 0,
    offset: Number(data?.offset ?? off),
    limit: Number(data?.limit ?? lim),
  };
}

/** GET /project/{id|slug} —— 返回原始项目 JSON。 */
export async function project(idOrSlug) {
  const id = String(idOrSlug || '').trim();
  if (!id) throw new Error('缺少项目 ID');
  try {
    return await memo(`project:${id}`, () => apiGet(`/project/${encodeURIComponent(id)}`));
  } catch (e) {
    throw new Error(e.message.includes('找不到') ? `找不到项目「${id}」` : e.message);
  }
}

/** GET /version/{id} —— 按版本 ID 精确获取。 */
async function getVersion(versionId) {
  const id = String(versionId || '').trim();
  if (!id) throw new Error('缺少版本 ID');
  return memo(`version:${id}`, () => apiGet(`/version/${encodeURIComponent(id)}`));
}

/**
 * GET /project/{id}/version —— 返回原始版本数组（默认按发布时间倒序）。
 * @param {string} idOrSlug
 * @param {{gameVersion?:string, loader?:string, featured?:boolean}} [opts]
 */
export async function versions(idOrSlug, { gameVersion = '', loader = '', featured = false } = {}) {
  const id = String(idOrSlug || '').trim();
  if (!id) throw new Error('缺少项目 ID');
  const qs = new URLSearchParams();
  const gv = String(gameVersion || '').trim();
  const ld = normalizeLoader(loader);
  if (gv) qs.set('game_versions', JSON.stringify([gv]));
  if (ld) qs.set('loaders', JSON.stringify([ld]));
  if (featured) qs.set('featured', 'true');
  const q = qs.toString();
  const pathname = `/project/${encodeURIComponent(id)}/version${q ? `?${q}` : ''}`;
  const list = await memo(`versions:${pathname}`, () => apiGet(pathname));
  return Array.isArray(list) ? list : [];
}

// ===========================================================================
// 三、通用小工具
// ===========================================================================

function requireInstanceId(instanceId) {
  const id = String(instanceId || '').trim();
  if (!id) throw new Error('缺少实例 ID');
  if (id === '.' || id === '..' || /[\\/\0]/.test(id)) throw new Error(`实例 ID 非法：${id}`);
  return id;
}

/** 拼接整合包内相对路径，拒绝跳出实例目录（zip slip 防护）。 */
function safeJoin(rootDir, relPath) {
  const root = path.resolve(rootDir);
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const dest = path.resolve(root, rel);
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new Error(`整合包文件路径非法：${relPath}`);
  }
  return dest;
}

function safeModFileName(name, fallback) {
  let base = path.basename(String(name || '').replace(/\\/g, '/'));
  base = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
  if (!base || base === '.' || base === '..') base = fallback;
  return base.slice(0, 200);
}

function safeZipName(name) {
  let base = path.basename(String(name || 'upload.zip'));
  base = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!base) base = 'upload.zip';
  if (!/\.(zip|mrpack)$/i.test(base)) base += '.zip';
  return base.slice(0, 160);
}

function pickFile(version) {
  const files = Array.isArray(version?.files) ? version.files : [];
  return files.find((f) => f && f.primary) || files[0] || null;
}

function makeTicker(fn, ms = 150) {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(); }
  };
}

async function verifySha512(file, expected) {
  const want = String(expected || '').toLowerCase();
  if (!want) return true;
  try {
    const hash = crypto.createHash('sha512');
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(file);
      s.on('data', (d) => hash.update(d));
      s.on('end', resolve);
      s.on('error', reject);
    });
    return hash.digest('hex').toLowerCase() === want;
  } catch {
    return false;
  }
}

/** 从 mrpack 的 dependencies 推导加载器。 */
function loaderFromDependencies(deps = {}) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const val = (k) => (d[k] == null || d[k] === '' ? null : String(d[k]));
  if (val('fabric-loader')) return { type: 'fabric', version: val('fabric-loader') };
  if (val('quilt-loader')) return { type: 'quilt', version: val('quilt-loader') };
  if (val('neoforge')) return { type: 'neoforge', version: val('neoforge') };
  if (val('forge')) return { type: 'forge', version: val('forge') };
  return { type: 'vanilla', version: null };
}

/** 从 CurseForge manifest 的 modLoaders 推导加载器（id 形如 forge-47.2.0）。 */
function loaderFromCurseForge(modLoaders = [], mcVersion = '') {
  const list = Array.isArray(modLoaders) ? modLoaders : [];
  const primary = list.find((l) => l && l.primary) || list[0];
  if (!primary || !primary.id) return { type: 'vanilla', version: null };
  const id = String(primary.id);
  const idx = id.indexOf('-');
  if (idx < 0) return { type: 'vanilla', version: null };
  let type = id.slice(0, idx).trim().toLowerCase();
  let version = id.slice(idx + 1).trim();
  if (type === 'fabricloader' || type === 'fabric-loader') type = 'fabric';
  if (type === 'quiltloader') type = 'quilt';
  if (mcVersion && version.startsWith(mcVersion + '-')) version = version.slice(mcVersion.length + 1);
  return { type: type || 'vanilla', version: version || null };
}

function defaultInstanceCreator({ name, versionId, loader, mrpackName }) {
  const inst = store.addInstance({
    name: name || '整合包实例',
    versionId: versionId || null,
    loader: loader || { type: 'vanilla', version: null },
    mrpackName: mrpackName || name || null,
  });
  return inst;
}

// ===========================================================================
// 四、模组安装
// ===========================================================================

/**
 * 安装一个模组（可选递归安装 required 依赖）。
 * 目标目录：<instance>/minecraft/mods
 * @returns {Promise<{installed:Array, skipped:string[], failed:string[]}>}
 */
export async function installMod({
  projectId,
  versionId = null,
  instanceId,
  gameVersion = '',
  loader = '',
  taskId = null,
  withDependencies = true,
  signal = null,
} = {}) {
  const rootId = String(projectId || '').trim();
  if (!rootId) throw new Error('缺少模组项目 ID');
  const instId = requireInstanceId(instanceId);
  const inst = typeof store.getInstance === 'function' ? store.getInstance(instId) : null;
  const gv = String(gameVersion || inst?.versionId || '').trim();
  const ld = normalizeLoader(loader || inst?.loader?.type || '');
  const tid = taskId || uid('mods_');

  const modsDir = path.join(instanceGameDir(instId), 'mods');
  await ensureDir(modsDir);

  const installed = [];
  const skipped = [];
  const failed = [];
  const seen = new Set();
  const queue = [{ projectId: rootId, versionId: versionId ? String(versionId) : null, depth: 0 }];

  let total = 1;
  let doneCount = 0;
  let bytes = 0;
  let totalBytes = 0;

  const emit = (label, phase, extra = {}) => {
    bus.progress({
      taskId: tid,
      scope: 'mods',
      label,
      done: doneCount,
      total: Math.max(total, 1),
      bytes,
      totalBytes,
      percent: Math.min(1, doneCount / Math.max(total, 1)),
      phase,
      ...extra,
    });
  };

  emit('准备安装模组', 'prepare');

  try {
    // 使用 BFS 以保证依赖层级可控、去重简单
    while (queue.length) {
      if (signal && signal.aborted) throw new Error('已取消下载');
      const item = queue.shift();
      const pid = String(item.projectId);
      if (seen.has(pid)) {
        skipped.push(`${pid}：已处理过，跳过重复依赖`);
        continue;
      }
      seen.add(pid);
      if (item.depth > MAX_DEP_DEPTH) {
        skipped.push(`${pid}：依赖层级超过 ${MAX_DEP_DEPTH} 层，已跳过`);
        continue;
      }
      const isRoot = item.depth === 0;

      // 项目元信息（用于标题、类型、客户端兼容性）；根项目失败时仍然尝试安装
      let proj = null;
      try {
        proj = await project(pid);
      } catch (e) {
        if (!isRoot) {
          skipped.push(`${pid}：无法获取项目信息（${e.message}）`);
          continue;
        }
      }
      const title = proj?.title || pid;
      if (proj && proj.project_type && proj.project_type !== 'mod') {
        if (isRoot) throw new Error(`项目「${title}」不是模组（类型：${proj.project_type}）`);
        skipped.push(`${title}：不是模组（${proj.project_type}），已跳过`);
        continue;
      }
      if (proj && proj.client_side === 'unsupported') {
        skipped.push(`${title}：该模组不支持客户端，已跳过`);
        continue;
      }

      // 选择版本
      let ver = null;
      try {
        if (item.versionId) {
          ver = await getVersion(item.versionId);
        } else {
          const list = await versions(pid, { gameVersion: gv, loader: ld });
          ver = list[0] || null;
        }
      } catch (e) {
        failed.push(`${title}：获取版本失败（${e.message}）`);
        doneCount++;
        emit(`获取 ${title} 版本失败`, 'download');
        continue;
      }
      if (!ver) {
        const cond = [gv ? `Minecraft ${gv}` : '', ld || ''].filter(Boolean).join(' / ');
        failed.push(`${title}：找不到${cond ? `适用于 ${cond} 的` : '可用的'}版本`);
        doneCount++;
        emit(`${title} 没有匹配版本`, 'download');
        continue;
      }

      const file = pickFile(ver);
      if (!file || !file.url) {
        failed.push(`${title}：版本 ${ver.version_number || ver.id} 没有可下载文件`);
        doneCount++;
        continue;
      }
      // 只安装客户端可用文件（服务端专用文件跳过）
      if (file.env && file.env.client === 'unsupported') {
        skipped.push(`${title}：该版本文件仅支持服务端，已跳过`);
        doneCount++;
        continue;
      }

      const filename = safeModFileName(file.filename, `${pid}-${ver.version_number || ver.id}.jar`);
      const dest = path.join(modsDir, filename);
      totalBytes += Number(file.size) || 0;
      emit(`下载 ${title}`, 'download');

      try {
        let last = 0;
        const tick = makeTicker(() => emit(`下载 ${title}`, 'download'));
        await downloadFile(file.url, dest, {
          sha1: file.hashes?.sha1 || null,
          size: Number(file.size) || 0,
          source: 'official',
          retries: 3,
          signal,
          onProgress: (p) => {
            const received = Number(p.received) || 0;
            bytes += received - last;
            last = received;
            tick();
          },
        });
      } catch (e) {
        failed.push(`${title}：下载失败（${e.message}）`);
        doneCount++;
        emit(`${title} 下载失败`, 'download');
        continue;
      }

      installed.push({
        projectId: pid,
        title,
        filename,
        versionId: ver.id,
        path: dest,
      });
      doneCount++;
      emit(`已安装 ${title}`, 'download');

      // 递归收集 required 依赖
      if (withDependencies) {
        const deps = Array.isArray(ver.dependencies) ? ver.dependencies : [];
        for (const dep of deps) {
          if (!dep || dep.dependency_type !== 'required') continue;
          const depId = dep.project_id ? String(dep.project_id) : '';
          if (!depId || seen.has(depId)) continue;
          queue.push({ projectId: depId, versionId: null, depth: item.depth + 1 });
          total++;
        }
      }
    }
  } catch (e) {
    bus.progress({
      taskId: tid, scope: 'mods', label: '模组安装失败',
      done: doneCount, total: Math.max(total, 1), bytes, totalBytes,
      percent: Math.min(1, doneCount / Math.max(total, 1)),
      finished: true, ok: false, error: e.message,
    });
    throw e;
  }

  bus.progress({
    taskId: tid, scope: 'mods',
    label: installed.length ? `已安装 ${installed.length} 个模组` : '没有安装任何模组',
    done: Math.max(doneCount, 1), total: Math.max(total, 1),
    bytes, totalBytes, percent: 1,
    phase: 'done', finished: true, ok: failed.length === 0,
  });

  if (installed.length && typeof bus.log === 'function') {
    bus.log('info', `已为实例 ${instId} 安装 ${installed.length} 个模组`);
  }
  return { installed, skipped, failed };
}

/**
 * 安装资源包 / 光影。
 * kind: 'resourcepack' | 'shader'，缺省时按项目类型推断。
 */
export async function installResource({
  projectId,
  versionId = null,
  instanceId,
  kind = '',
  gameVersion = '',
  taskId = null,
} = {}) {
  const pid = String(projectId || '').trim();
  if (!pid) throw new Error('缺少资源项目 ID');
  const instId = requireInstanceId(instanceId);
  const inst = typeof store.getInstance === 'function' ? store.getInstance(instId) : null;
  const gv = String(gameVersion || inst?.versionId || '').trim();
  const tid = taskId || uid('res_');

  let k = String(kind || '').trim().toLowerCase();
  if (k === 'resourcepacks') k = 'resourcepack';
  if (k === 'shaders') k = 'shader';
  if (k !== 'resourcepack' && k !== 'shader') {
    let type = '';
    try { type = (await project(pid))?.project_type || ''; } catch { /* 忽略，按资源包处理 */ }
    k = type === 'shader' ? 'shader' : 'resourcepack';
  }
  const dirName = k === 'shader' ? 'shaderpacks' : 'resourcepacks';
  const destDir = path.join(instanceGameDir(instId), dirName);
  await ensureDir(destDir);

  const installed = [];
  const skipped = [];
  const failed = [];
  let totalBytes = 0;
  let bytes = 0;

  const emit = (label, phase, done = 0, total = 1, extra = {}) => {
    bus.progress({
      taskId: tid, scope: 'resources', label, done, total: Math.max(total, 1),
      bytes, totalBytes, percent: Math.min(1, done / Math.max(total, 1)), phase, ...extra,
    });
  };

  emit('准备下载资源', 'prepare');

  try {
    let proj = null;
    try { proj = await project(pid); } catch { /* 允许仅用版本信息 */ }
    const title = proj?.title || pid;

    let ver = null;
    if (versionId) ver = await getVersion(versionId);
    else {
      let list = await versions(pid, { gameVersion: gv });
      // 资源包版本上的 game_versions 常缺失，筛选为空时退化为全部版本
      if (!list.length && gv) list = await versions(pid, {});
      ver = list[0] || null;
    }
    if (!ver) throw new Error(`「${title}」没有可用的下载版本`);
    const file = pickFile(ver);
    if (!file || !file.url) throw new Error(`「${title}」版本 ${ver.version_number || ver.id} 没有可下载文件`);

    const filename = safeModFileName(file.filename, `${pid}-${ver.version_number || ver.id}.zip`);
    const dest = path.join(destDir, filename);
    totalBytes = Number(file.size) || 0;
    emit(`下载 ${title}`, 'download', 0, 1);

    let last = 0;
    const tick = makeTicker(() => emit(`下载 ${title}`, 'download', 0, 1));
    await downloadFile(file.url, dest, {
      sha1: file.hashes?.sha1 || null,
      size: Number(file.size) || 0,
      source: 'official',
      retries: 3,
      onProgress: (p) => {
        const received = Number(p.received) || 0;
        bytes += received - last;
        last = received;
        tick();
      },
    });

    installed.push({
      projectId: pid, title, filename, versionId: ver.id, path: dest, kind: k,
    });
    emit(`已安装 ${title}`, 'done', 1, 1, { finished: true, ok: true });
  } catch (e) {
    failed.push(String(e.message || e));
    bus.progress({
      taskId: tid, scope: 'resources', label: '资源下载失败',
      done: 0, total: 1, bytes, totalBytes, percent: 0,
      finished: true, ok: false, error: String(e.message || e),
    });
    throw e;
  }

  return { kind: k, installed, skipped, failed };
}

// ===========================================================================
// 五、整合包元数据（.mrpack / CurseForge .zip）
// ===========================================================================

/**
 * 读取整合包元数据，返回统一的内部结构。
 * @param {Awaited<ReturnType<typeof openZip>>} zip
 */
async function readPackMeta(zip) {
  // ---- Modrinth .mrpack ----
  if (zip.has('modrinth.index.json')) {
    const index = await zip.readJson('modrinth.index.json');
    if (!index || typeof index !== 'object') throw new Error('modrinth.index.json 内容无效');
    const formatVersion = Number(index.formatVersion ?? 1);
    if (formatVersion !== 1) throw new Error(`不支持的 Modrinth 整合包格式版本：${index.formatVersion}`);

    const deps = index.dependencies && typeof index.dependencies === 'object' ? index.dependencies : {};
    const files = [];
    let skipped = 0;
    for (const f of Array.isArray(index.files) ? index.files : []) {
      if (!f || !f.path) continue;
      // 客户端不支持的文件直接跳过
      if (f.env && f.env.client === 'unsupported') { skipped++; continue; }
      files.push({
        destRel: String(f.path).replace(/\\/g, '/'),
        url: Array.isArray(f.downloads) && f.downloads.length ? String(f.downloads[0]) : null,
        sha1: f.hashes?.sha1 || null,
        sha512: f.hashes?.sha512 || null,
        size: Number(f.fileSize) || 0,
      });
    }
    return {
      format: 'mrpack',
      name: String(index.name || 'Modrinth 整合包'),
      versionId: String(index.versionId || ''),
      summary: String(index.summary || ''),
      mcVersion: deps.minecraft ? String(deps.minecraft) : '',
      loader: loaderFromDependencies(deps),
      files,
      skipped,
      overrideDirs: ['overrides', 'client-overrides'],
      manifest: index,
    };
  }

  // ---- CurseForge manifest ----
  if (zip.has('manifest.json')) {
    const manifest = await zip.readJson('manifest.json');
    if (!manifest || typeof manifest !== 'object') throw new Error('manifest.json 内容无效');
    const mc = manifest.minecraft || {};
    const files = [];
    for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
      if (!f || f.projectID == null || f.fileID == null) continue;
      files.push({
        cf: true,
        projectID: Number(f.projectID),
        fileID: Number(f.fileID),
        required: f.required !== false,
      });
    }
    return {
      format: 'curseforge',
      name: String(manifest.name || 'CurseForge 整合包'),
      versionId: String(manifest.version || ''),
      summary: '',
      mcVersion: mc.version ? String(mc.version) : '',
      loader: loaderFromCurseForge(mc.modLoaders, mc.version ? String(mc.version) : ''),
      files,
      skipped: 0,
      overrideDirs: [String(manifest.overrides || 'overrides'), 'client-overrides'],
      manifest,
    };
  }

  // ---- MultiMC / Prism / PCL 多加载器整合包 ----
  if (zip.has('mmc-pack.json')) {
    const mmc = await zip.readJson('mmc-pack.json');
    if (!mmc || typeof mmc !== 'object') throw new Error('mmc-pack.json 内容无效');
    const components = Array.isArray(mmc.components) ? mmc.components : [];
    const mcComp = components.find((c) => /net\.minecraft$/i.test(String(c.uid || '')));
    const loaderComp = components.find((c) => /fabric-loader|quilt-loader|net\.minecraftforge|neoforged|liteloader/i.test(String(c.uid || '')));
    let type = 'vanilla';
    if (loaderComp) {
      const uid = String(loaderComp.uid || '').toLowerCase();
      if (uid.includes('fabric-loader')) type = 'fabric';
      else if (uid.includes('quilt-loader')) type = 'quilt';
      else if (uid.includes('neoforged')) type = 'neoforge';
      else if (uid.includes('minecraftforge')) type = 'forge';
      else if (uid.includes('liteloader')) type = 'liteloader';
    }
    let cfgName = '';
    try {
      const cfgEntry = zip.entries.find((e) => /^instance\.cfg$/i.test(e.name));
      if (cfgEntry) {
        const text = (await zip.read(cfgEntry)).toString('utf8');
        cfgName = /^name=(.+)$/mi.exec(text)?.[1]?.trim() || '';
      }
    } catch { /* ignore */ }
    const loader = { type, version: loaderComp?.version ? String(loaderComp.version) : null };
    return {
      format: 'multimc',
      name: cfgName || String(mmc.name || 'MultiMC 整合包'),
      versionId: '',
      summary: '',
      mcVersion: mcComp?.version ? String(mcComp.version) : '',
      loader,
      files: [],
      skipped: 0,
      overrideDirs: ['.minecraft', 'minecraft'],
      manifest: mmc,
    };
  }

  throw new Error('不是有效的整合包：压缩包内缺少 modrinth.index.json、manifest.json 或 mmc-pack.json');
}

async function readPackIcon(zip) {
  const entry = zip.entries.find((e) => !e.isDir && /^icon\.png$/i.test(e.name));
  if (!entry || !entry.size || entry.size > 2 * 1024 * 1024) return null;
  try {
    const data = await zip.read(entry);
    return `data:image/png;base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

const LOADER_LABELS = { vanilla: '原版', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

/** 加载器 → 便于界面直接显示的文本，如 "Fabric 0.16.9"。 */
function loaderLabel(loader) {
  if (!loader || !loader.type || loader.type === 'vanilla') return '原版';
  const name = LOADER_LABELS[loader.type] || loader.type;
  return loader.version ? `${name} ${loader.version}` : name;
}

/**
 * 只读取整合包元数据，不安装。
 * loader 为可直接展示的字符串（如 "Fabric 0.16.9"），结构化的加载器信息在 loaderInfo。
 * @returns {Promise<{format:string,name:string,versionId:string,loader:string,
 *   loaderInfo:{type:string,version:string|null},summary:string,icon:string|null,gameVersion:string}>}
 */
export async function inspectModpack(filePath) {
  const abs = path.resolve(String(filePath || ''));
  if (!filePath) throw new Error('缺少整合包文件路径');
  if (!(await exists(abs))) throw new Error(`整合包文件不存在：${abs}`);
  let zip;
  try {
    zip = await openZip(abs);
  } catch (e) {
    throw new Error(`无法解析整合包：${e.message}`);
  }
  try {
    const pack = await readPackMeta(zip);
    const icon = await readPackIcon(zip);
    return {
      format: pack.format,
      name: pack.name,
      versionId: pack.versionId,
      loader: loaderLabel(pack.loader),
      loaderInfo: pack.loader,
      summary: pack.summary,
      icon,
      gameVersion: pack.mcVersion,
      fileCount: pack.files.length,
    };
  } catch (e) {
    throw new Error(`无法解析整合包：${e.message}`);
  } finally {
    await zip.close();
  }
}

// ===========================================================================
// 六、CurseForge 文件地址解析（无 API Key 时优雅降级）
// ===========================================================================

function curseForgeCdnUrl(fileName, fileId) {
  const id = Number(fileId);
  if (!fileName || !Number.isFinite(id)) return null;
  const dir = Math.floor(id / 1000);
  const name = encodeURIComponent(String(fileName));
  return `https://edge.forgecdn.net/files/${dir}/${id % 1000}/${name}`;
}

/**
 * 解析 CurseForge 文件下载地址：
 *  1. 有 curseforgeApiKey → /v1/mods/{id}/files/{fid} 取 fileName + downloadUrl
 *  2. 无 Key → 尝试 /download-url 端点（可能 403）
 *  3. 兜底用 edge.forgecdn.net 直链（需要 fileName 才能拼出）
 */
async function resolveCurseForgeFile(projectID, fileID) {
  const apiKey = String(store.settings?.curseforgeApiKey || '').trim();
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (apiKey) {
    try {
      const data = await fetchJson(`https://api.curseforge.com/v1/mods/${projectID}/files/${fileID}`, {
        headers: { ...headers, 'x-api-key': apiKey },
        source: 'official',
        retries: 1,
        timeoutMs: 15000,
      });
      const d = data?.data;
      if (d) {
        const fileName = d.fileName || null;
        const url = d.downloadUrl || curseForgeCdnUrl(fileName, fileID);
        if (url) return { url, fileName };
      }
    } catch { /* 继续尝试下一策略 */ }
  }
  try {
    const data = await fetchJson(`https://api.curseforge.com/v1/mods/${projectID}/files/${fileID}/download-url`, {
      headers, source: 'official', retries: 0, timeoutMs: 12000,
    });
    const url = typeof data?.data === 'string' ? data.data : '';
    if (url) {
      const tail = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
      return { url, fileName: tail || null };
    }
  } catch { /* 无 Key 时通常 403，忽略 */ }
  return null;
}

// ===========================================================================
// 七、整合包安装
// ===========================================================================

/** 收集 overrides / client-overrides 中的条目（不解压，仅记录）。 */
function collectOverrideEntries(zip, dirs) {
  const out = [];
  const seen = new Set();
  for (const dirName of dirs) {
    const prefix = String(dirName || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    if (prefix === '/') continue;
    for (const entry of zip.entries) {
      if (entry.isDir || !entry.name.startsWith(prefix)) continue;
      const rel = entry.name.slice(prefix.length);
      if (!rel) continue;
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push({ entry, rel });
    }
  }
  return out;
}

/**
 * 从文件安装整合包（.mrpack 或 CurseForge .zip）。
 * 加载器本体由调用方（server.mjs）安装，这里只铺开文件与覆盖目录。
 *
 * @param {{filePath:string, instanceId?:string|null, taskId?:string|null,
 *          onInstanceCreated?:(arg:{name:string,versionId:string,loader:object,mrpackName:string})=>Promise<object>|object}} opts
 */
export async function installModpackFromFile({
  filePath,
  instanceId = null,
  taskId = null,
  onInstanceCreated = null,
} = {}) {
  if (!filePath) throw new Error('缺少整合包文件路径');
  const abs = path.resolve(String(filePath));
  if (!(await exists(abs))) throw new Error(`整合包文件不存在：${abs}`);

  const tid = taskId || uid('modpack_');
  let zip;
  try {
    zip = await openZip(abs);
  } catch (e) {
    throw new Error(`无法读取整合包：${e.message}`);
  }

  const failed = [];
  try {
    const pack = await readPackMeta(zip);
    const name = pack.name;
    const loader = pack.loader;
    const totalBytes = pack.files.reduce((a, f) => a + (Number(f.size) || 0), 0);

    // ---- 1. 目标实例（必要时新建） ----
    let instId = instanceId ? String(instanceId) : '';
    if (!instId) {
      const creator = typeof onInstanceCreated === 'function' ? onInstanceCreated : defaultInstanceCreator;
      const created = await creator({
        name,
        versionId: pack.mcVersion || '',
        loader,
        mrpackName: name,
      });
      if (!created || !created.id) throw new Error('创建实例失败：未返回实例信息');
      instId = String(created.id);
    }
    instId = requireInstanceId(instId);
    const gameDir = instanceGameDir(instId);
    await ensureDir(gameDir);

    const overrideEntries = collectOverrideEntries(zip, pack.overrideDirs);
    const total = pack.files.length + overrideEntries.length;

    let done = 0;
    let bytes = 0;
    let fileCount = 0;
    let overrideCount = 0;
    let skipped = pack.skipped || 0;

    const emit = (label, phase, extra = {}) => {
      bus.progress({
        taskId: tid,
        scope: 'modpack',
        label,
        done,
        total: Math.max(total, 1),
        bytes,
        totalBytes,
        percent: Math.min(1, done / Math.max(total, 1)),
        phase,
        ...extra,
      });
    };

    emit(`准备安装整合包「${name}」`, 'prepare');

    // ---- 2. CurseForge 文件地址预解析 ----
    const tasks = [];
    if (pack.format === 'curseforge') {
      emit('正在解析 CurseForge 文件地址', 'resolve');
      for (const f of pack.files) {
        const r = await resolveCurseForgeFile(f.projectID, f.fileID);
        if (!r || !r.url) {
          failed.push(`CurseForge 文件 ${f.projectID}/${f.fileID}：无法获取下载地址（可在设置中填写 CurseForge API Key）`);
          done++;
          continue;
        }
        const fileName = safeModFileName(r.fileName, `cf-${f.projectID}-${f.fileID}.jar`);
        tasks.push({
          destRel: `mods/${fileName}`,
          url: r.url,
          sha1: null,
          sha512: null,
          size: 0,
        });
      }
    } else {
      for (const f of pack.files) {
        try {
          // 提前校验目标路径，避免安装中途整包失败
          safeJoin(gameDir, f.destRel);
        } catch (e) {
          failed.push(`${f.destRel}：${e.message}`);
          done++;
          continue;
        }
        tasks.push(f);
      }
    }

    // ---- 3. 并发下载（4 路） ----
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        if (!t.url) {
          failed.push(`${t.destRel}：该文件没有下载地址`);
          done++;
          emit(`跳过 ${t.destRel}`, 'download');
          continue;
        }
        try {
          const dest = safeJoin(gameDir, t.destRel);
          let last = 0;
          const tick = makeTicker(() => emit(`下载 ${t.destRel}`, 'download'));
          await downloadFile(t.url, dest, {
            sha1: t.sha1 || null,
            size: Number(t.size) || 0,
            source: 'official',
            retries: 3,
            onProgress: (p) => {
              const received = Number(p.received) || 0;
              bytes += received - last;
              last = received;
              tick();
            },
          });
          // 仅有 sha512 时下载后补校验
          if (!t.sha1 && t.sha512) {
            if (!(await verifySha512(dest, t.sha512))) {
              await fsp.rm(dest, { force: true }).catch(() => {});
              throw new Error('文件校验失败（sha512 不匹配）');
            }
          }
          fileCount++;
          done++;
          emit(`已下载 ${t.destRel}`, 'download');
        } catch (e) {
          failed.push(`${t.destRel}：${e.message}`);
          done++;
          emit(`下载失败 ${t.destRel}`, 'download');
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(PACK_CONCURRENCY, Math.max(1, tasks.length)) },
      () => worker(),
    );
    await Promise.all(workers);

    // ---- 4. 展开 overrides / client-overrides ----
    if (overrideEntries.length) {
      emit('正在展开覆盖文件', 'overrides');
      for (const item of overrideEntries) {
        try {
          const dest = safeJoin(gameDir, item.rel);
          const data = await zip.read(item.entry);
          await ensureDir(path.dirname(dest));
          await fsp.writeFile(dest, data);
          overrideCount++;
        } catch (e) {
          failed.push(`${item.rel}：覆盖文件写入失败（${e.message}）`);
        }
        done++;
        if (done % 10 === 0 || done === total) emit('正在展开覆盖文件', 'overrides');
      }
    }

    bus.progress({
      taskId: tid, scope: 'modpack',
      label: `整合包「${name}」安装完成`,
      done: Math.max(done, 1), total: Math.max(total, 1),
      bytes, totalBytes, percent: 1,
      phase: 'done', finished: true, ok: failed.length === 0,
    });
    if (typeof bus.log === 'function') {
      bus.log('info', `整合包「${name}」已安装到实例 ${instId}（${fileCount} 个文件、${overrideCount} 个覆盖文件）`);
    }

    return {
      instanceId: instId,
      name,
      files: fileCount,
      overrides: overrideCount,
      loader,
      failed,
      skipped,
      format: pack.format,
    };
  } catch (e) {
    bus.progress({
      taskId: tid, scope: 'modpack', label: '整合包安装失败',
      done: 0, total: 1, finished: true, ok: false, error: String(e.message || e),
    });
    throw e;
  } finally {
    await zip.close();
  }
}

// ===========================================================================
// 八、上传与请求辅助
// ===========================================================================

function isMultipart(req) {
  return String(req?.headers?.['content-type'] || '').toLowerCase().startsWith('multipart/form-data');
}

function readBody(ctxObj, req) {
  if (ctxObj && typeof ctxObj.body === 'function') return ctxObj.body();
  return jsonBody(req);
}

function queryReader(ctxObj, req) {
  let src = ctxObj?.query;
  if (src instanceof URLSearchParams) {
    return (name, def = '') => {
      const v = src.get(name);
      return v === null || v === undefined ? def : v;
    };
  }
  if (src && typeof src === 'object') {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(src)) if (v != null) usp.set(k, String(v));
    return (name, def = '') => {
      const v = usp.get(name);
      return v === null || v === undefined ? def : v;
    };
  }
  let usp;
  try {
    usp = new URL(req?.url || '/', 'http://localhost').searchParams;
  } catch {
    usp = new URLSearchParams();
  }
  return (name, def = '') => {
    const v = usp.get(name);
    return v === null || v === undefined ? def : v;
  };
}

/** 原始 body 上传：x-filename 头携带文件名。 */
async function saveRawUpload(req, filename) {
  const dir = path.join(DOWNLOADS_DIR, 'modpacks');
  await ensureDir(dir);
  const dest = path.join(dir, `${Date.now()}-${safeZipName(filename)}`);
  let total = 0;
  const maxUpload = uploadLimitBytes();
  const out = fs.createWriteStream(dest);
  out.on('error', () => { /* 由下方 await 统一捕获 */ });
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxUpload) throw new Error(`上传文件过大（当前上限 ${uploadLimitText()}）`);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
  } catch (e) {
    try { out.destroy(); } catch { /* ignore */ }
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!total) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw new Error('上传内容为空');
  }
  return { path: dest, filename: safeZipName(filename), size: total };
}

/**
 * 解析 multipart/form-data 上传（只关心第一个文件字段）。
 * 流式落盘，避免把整个整合包读进内存；默认上限 4GB，可用 MCL_MAX_UPLOAD_MB 调整。
 */
async function parseMultipartUpload(req, { limit = null } = {}) {
  const maxUpload = limit || uploadLimitBytes();
  const ctype = String(req.headers['content-type'] || '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (!m) throw new Error('上传请求缺少 multipart 边界（boundary）');
  const boundary = Buffer.from('--' + String(m[1] || m[2]).trim(), 'utf8');
  const delim = Buffer.concat([Buffer.from('\r\n'), boundary]);
  const dir = path.join(DOWNLOADS_DIR, 'modpacks');
  await ensureDir(dir);

  let buf = Buffer.alloc(0);
  let state = 'preamble';
  let total = 0;
  let outStream = null;
  let filePath = null;
  let filename = 'upload.zip';
  let fileSize = 0;

  const writeChunk = async (chunk) => {
    if (!chunk || !chunk.length) return;
    fileSize += chunk.length;
    if (!outStream.write(chunk)) await new Promise((r) => outStream.once('drain', r));
  };

  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxUpload) throw new Error(`上传文件过大（当前上限 ${uploadLimitText()}）`);
      if (state === 'drain') continue;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      // 状态机：preamble（找首个分隔线）→ headers → body → drain
      for (;;) {
        if (state === 'preamble') {
          const i = buf.indexOf(boundary);
          if (i < 0) {
            if (buf.length > boundary.length) buf = buf.subarray(buf.length - boundary.length);
            break;
          }
          const rest = buf.subarray(i + boundary.length);
          if (rest.length >= 2 && rest[0] === 0x2d && rest[1] === 0x2d) { state = 'drain'; buf = Buffer.alloc(0); break; }
          if (rest.length < 2) { buf = buf.subarray(i); break; }
          buf = rest.subarray(2); // 跳过 CRLF
          state = 'headers';
          continue;
        }
        if (state === 'headers') {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) {
            if (buf.length > 65536) throw new Error('上传请求格式错误：分段头过大');
            break;
          }
          const head = buf.subarray(0, i).toString('utf8');
          buf = buf.subarray(i + 4);
          if (!/filename/i.test(head)) { state = 'preamble'; continue; }
          const fm = /filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i.exec(head);
          if (fm) {
            const raw = fm[1].trim();
            try { filename = decodeURIComponent(raw); } catch { filename = raw; }
          }
          filePath = path.join(dir, `${Date.now()}-${safeZipName(filename)}`);
          outStream = fs.createWriteStream(filePath);
          fileSize = 0;
          state = 'body';
          continue;
        }
        if (state === 'body') {
          const i = buf.indexOf(delim);
          if (i >= 0) {
            await writeChunk(buf.subarray(0, i));
            buf = Buffer.alloc(0);
            state = 'drain';
            break;
          }
          const keep = delim.length + 2;
          if (buf.length > keep) {
            await writeChunk(buf.subarray(0, buf.length - keep));
            buf = buf.subarray(buf.length - keep);
          }
          break;
        }
        break;
      }
    }
  } catch (e) {
    try { outStream?.destroy(); } catch { /* ignore */ }
    if (filePath) await fsp.rm(filePath, { force: true }).catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    if (outStream) {
      outStream.on('error', () => { /* 错误已在上方处理 */ });
      await new Promise((resolve) => {
        if (outStream.destroyed) return resolve();
        outStream.end(resolve);
      });
    }
  }

  if (!filePath) throw new Error('上传请求中没有找到文件字段（file）');
  if (!fileSize) await fsp.rm(filePath, { force: true }).catch(() => {});
  return { path: filePath, filename: safeZipName(filename), size: fileSize };
}

/** 上传入口：multipart 走流式解析，其余按 raw body + x-filename 处理。 */
async function handleUpload(req) {
  if (isMultipart(req)) return parseMultipartUpload(req);
  const header = req.headers['x-filename'] || req.headers['x-file-name'] || 'upload.zip';
  let filename = String(header);
  try { filename = decodeURIComponent(filename); } catch { /* 保持原样 */ }
  return saveRawUpload(req, filename);
}

/**
 * 按 Modrinth 项目下载整合包文件到 downloads/modpacks（供 /api/modpacks/install 的 projectId 参数使用）。
 * 加载器与游戏文件仍由调用方负责安装。
 */
async function downloadPackForProject(projectId, displayName = '', taskId = null) {
  const list = await versions(projectId, {});
  if (!list.length) throw new Error('该整合包没有可下载的版本');
  const ver = list.find((x) => x.version_type === 'release') || list[0];
  const file = pickFile(ver);
  if (!file || !file.url) throw new Error('该整合包版本缺少可下载文件');

  const dir = path.join(DOWNLOADS_DIR, 'modpacks');
  await ensureDir(dir);
  const base = safeModFileName(String(displayName || projectId), 'pack').replace(/\.(mrpack|zip)$/i, '');
  const dest = path.join(dir, `${base}-${safeModFileName(String(ver.id || 'version'), 'version')}.mrpack`);

  let last = null;
  const tick = makeTicker(() => {
    if (!last) return;
    bus.progress({
      taskId, scope: 'modpack', label: `下载整合包 ${file.filename}`, phase: 'download-pack',
      bytes: last.received, totalBytes: last.total,
      percent: last.total ? 0.01 + 0.09 * (last.received / last.total) : 0.05,
    });
  }, 200);
  await downloadFile(file.url, dest, {
    sha1: file.hashes?.sha1 || null,
    size: Number(file.size) || 0,
    source: 'official',
    retries: 3,
    timeoutMs: 600000,
    onProgress: (p) => { last = p; tick(); },
  });
  return dest;
}

// ===========================================================================
// 九、路由注册
// ===========================================================================

export function register(router, ctx = {}) {
  const app = ctx?.app || {};
  const cfg = app.store || store;

  const instanceOf = (id) => {
    if (!id) return null;
    try { return cfg.getInstance(id); } catch { return null; }
  };

  // GET /api/mods/search?query=&type=mod&gameVersion=&loader=&offset=&limit=&index=
  router.get('/api/mods/search', async (req, res, c) => {
    const get = queryReader(c, req);
    const inst = instanceOf(get('instanceId'));
    return search({
      query: get('query'),
      type: get('type', 'mod'),
      gameVersion: get('gameVersion', inst?.versionId || ''),
      loader: get('loader', inst?.loader?.type || ''),
      index: get('index', 'relevance'),
      offset: Number(get('offset', '0')) || 0,
      limit: Number(get('limit', '20')) || 20,
      categories: get('categories') || get('category') || '',
    });
  });

  // GET /api/mods/project/:id
  router.get('/api/mods/project/:id', async (req, res, c) => {
    const id = c?.params?.id || '';
    if (!id) throw new Error('缺少项目 ID');
    return project(id);
  });

  // GET /api/mods/versions/:id?gameVersion=&loader=
  router.get('/api/mods/versions/:id', async (req, res, c) => {
    const get = queryReader(c, req);
    const id = c?.params?.id || '';
    if (!id) throw new Error('缺少项目 ID');
    return versions(id, {
      gameVersion: get('gameVersion'),
      loader: get('loader'),
      featured: get('featured') === 'true',
    });
  });

  // POST /api/mods/install {projectId, versionId?, instanceId, gameVersion, loader, withDependencies}
  router.post('/api/mods/install', async (req, res, c) => {
    const body = (await readBody(c, req)) || {};
    const taskId = body.taskId || uid('mods_');
    const controller = new AbortController();
    if (typeof global.__MCL_REGISTER_TASK__ === 'function') global.__MCL_REGISTER_TASK__(taskId, controller);
    try {
      const result = await installMod({
        projectId: body.projectId || body.id || body.slug,
        versionId: body.versionId || null,
        instanceId: body.instanceId || c?.instance?.id || c?.params?.instanceId,
        gameVersion: body.gameVersion || '',
        loader: body.loader || '',
        taskId,
        withDependencies: body.withDependencies !== false,
        signal: controller.signal,
      });
      return { ...result, taskId };
    } finally {
      if (typeof global.__MCL_UNREGISTER_TASK__ === 'function') global.__MCL_UNREGISTER_TASK__(taskId);
    }
  });

  // POST /api/resources/install {projectId, versionId?, instanceId, kind}
  router.post('/api/resources/install', async (req, res, c) => {
    const body = (await readBody(c, req)) || {};
    const taskId = body.taskId || uid('res_');
    const result = await installResource({
      projectId: body.projectId || body.id || body.slug,
      versionId: body.versionId || null,
      instanceId: body.instanceId || c?.instance?.id || c?.params?.instanceId,
      kind: body.kind || '',
      gameVersion: body.gameVersion || '',
      taskId,
    });
    return { ...result, taskId };
  });

  // POST /api/modpacks/inspect {path} 或 multipart 上传
  router.post('/api/modpacks/inspect', async (req, res, c) => {
    let filePath = '';
    if (isMultipart(req)) {
      const up = await parseMultipartUpload(req);
      filePath = up.path;
    } else {
      const body = (await readBody(c, req)) || {};
      filePath = body.path || body.filePath || '';
    }
    if (!filePath) throw new Error('缺少整合包文件路径');
    const meta = await inspectModpack(filePath);
    return { path: filePath, meta, ...meta };
  });

  // POST /api/modpacks/install {path?|projectId?, instanceId?, name?}（也支持 multipart 直接上传）
  router.post('/api/modpacks/install', async (req, res, c) => {
    let body = {};
    let filePath = '';
    if (isMultipart(req)) {
      const up = await parseMultipartUpload(req);
      filePath = up.path;
      const get = queryReader(c, req);
      body = { instanceId: get('instanceId') || null, name: get('name') || '' };
    } else {
      body = (await readBody(c, req)) || {};
      filePath = body.path || body.filePath || '';
    }
    const taskId = body.taskId || uid('modpack_');
    const overrideName = body.name ? String(body.name) : '';
    const projectRef = body.projectId || body.id || body.slug || '';
    // 允许只给 Modrinth 项目 ID：先下载 .mrpack 再安装（界面的“安装整合包”按钮走这条路径）
    if (!filePath && projectRef) {
      filePath = await downloadPackForProject(projectRef, overrideName, taskId);
    }
    if (!filePath) throw new Error('缺少整合包文件路径（path 或 projectId）');

    const creator = async (arg) => defaultInstanceCreator({
      ...arg,
      name: overrideName || arg.name,
      mrpackName: overrideName || arg.mrpackName,
    });

    const result = await installModpackFromFile({
      filePath,
      instanceId: body.instanceId || c?.instance?.id || c?.params?.instanceId || null,
      taskId,
      onInstanceCreated: creator,
    });
    return { ...result, taskId };
  });

  // POST /api/modpacks/upload（raw body + x-filename，或 multipart）→ {path, meta}
  router.post('/api/modpacks/upload', async (req) => {
    const saved = await handleUpload(req);
    let meta = null;
    let warning = null;
    try {
      meta = await inspectModpack(saved.path);
    } catch (e) {
      warning = e.message;
    }
    if (warning) {
      const err = new Error(warning);
      err.status = 400;
      throw err;
    }
    return { path: saved.path, meta };
  });
}
