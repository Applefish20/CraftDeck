/**
 * translation.mjs — 汉化资源包模块
 *
 * 汉化来源（全部为公开资源，任一不可达都要优雅降级）：
 *  1. CFPA 简体中文汉化资源包 —— GitHub CFPAOrg/Minecraft-Mod-Language-Package releases（Autobuild）
 *  2. VM汉化组 汉化资源包 —— GitHub releases（仓库当前无 Release 时回退到 Modrinth 上的 vmct 项目）
 *  3. Modrinth 上的汉化资源包（project_type:resourcepack + categories:locale）
 *
 * 所有网络失败都不应让接口整体报错，最多返回静态条目。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { store, resolveInstance } from '../core/store.mjs';
import { bus } from '../core/events.mjs';
import { instanceDir, instanceGameDir } from '../core/paths.mjs';
import { downloadFile } from '../core/downloader.mjs';
import { ensureDir, exists, readText, safeFileName, formatBytes } from '../core/util.mjs';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const UA = 'CraftDeck/1.0 (Minecraft Launcher)';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_FACETS = JSON.stringify([['project_type:resourcepack'], ['categories:locale']]);
const GITHUB_API = 'https://api.github.com/repos';

/** 汉化包列表缓存 10 分钟 */
const CACHE_TTL = 10 * 60 * 1000;
/** 超过该体积只提示不阻止（汉化包体积可能较大） */
const BIG_PACK_BYTES = 80 * 1024 * 1024;

/** GitHub 不可达时仍要能列出 CFPA（Autobuild 固定标签） */
const CFPA_FALLBACK_URL = 'https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/releases/download/autobuild/Minecraft-Mod-Language-Modpack.zip';
const CFPA_HOMEPAGE = 'https://github.com/CFPAOrg/Minecraft-Mod-Language-Package';
const VM_HOMEPAGE = 'https://modrinth.com/resourcepack/vmct';
const VM_MODRINTH_SLUG = 'vmct';

/* ------------------------------------------------------------------ *
 * 网络工具
 * ------------------------------------------------------------------ */

/**
 * 统一的 HTTP JSON 请求：不因 4xx/5xx 抛错，状态码交回调用方判断。
 * @returns {Promise<{ok:boolean,status:number,data:any}>}
 */
async function httpJson(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('网络请求超时');
    throw new Error('网络请求失败：' + (e && e.message ? e.message : url));
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 资源包列表
 * ------------------------------------------------------------------ */

function baseEntry(patch) {
  return {
    id: '',
    name: '',
    description: '',
    type: 'resourcepack',
    source: 'static',
    gameVersions: ['all'],
    url: null,
    homepage: null,
    recommended: false,
    // 以下为安装用的附加信息
    slug: null,
    fileName: null,
    size: 0,
    version: null,
    ...patch,
  };
}

/** 从 GitHub release 里挑一个 zip 资源（优先“全量包”名字，其次体积最大的） */
function pickZipAsset(release) {
  const assets = Array.isArray(release && release.assets)
    ? release.assets.filter((a) => a && /\.zip$/i.test(a.name || ''))
    : [];
  if (!assets.length) return null;
  const full = assets.find((a) => /^Minecraft-Mod-Language-Modpack\.zip$/i.test(a.name));
  if (full) return full;
  return assets.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

/** 1) CFPA 汉化资源包 */
async function cfpaPack() {
  const fallback = baseEntry({
    id: 'cfpa',
    name: 'CFPA 简体中文汉化资源包',
    description: 'CFPA 汉化包（Autobuild）：覆盖绝大多数模组的简体中文翻译，适用于全部游戏版本',
    source: 'github',
    gameVersions: ['all'],
    url: CFPA_FALLBACK_URL,
    homepage: CFPA_HOMEPAGE,
    recommended: true,
    fileName: 'Minecraft-Mod-Language-Modpack.zip',
  });

  try {
    const r = await httpJson(`${GITHUB_API}/CFPAOrg/Minecraft-Mod-Language-Package/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      timeoutMs: 15000,
    });
    if (!r.ok || !r.data) return fallback;
    const asset = pickZipAsset(r.data);
    if (!asset || !asset.browser_download_url) return fallback;
    return baseEntry({
      id: 'cfpa',
      name: 'CFPA 简体中文汉化资源包',
      description: 'CFPA 汉化包（Autobuild）：覆盖绝大多数模组的简体中文翻译，适用于全部游戏版本',
      source: 'github',
      gameVersions: ['all'],
      url: asset.browser_download_url,
      homepage: r.data.html_url || CFPA_HOMEPAGE,
      recommended: true,
      fileName: asset.name,
      size: asset.size || 0,
      version: r.data.tag_name || null,
    });
  } catch {
    return fallback; // 网络不可用时仍然列出
  }
}

/** 2) VM汉化组 汉化资源包 */
async function vmPack() {
  try {
    const r = await httpJson(`${GITHUB_API}/VM-Chinese-Translaters/VMTranslationPack/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      timeoutMs: 15000,
    });
    const asset = r.ok && r.data ? pickZipAsset(r.data) : null;
    if (asset && asset.browser_download_url) {
      return baseEntry({
        id: 'vm',
        name: 'VM汉化组 汉化资源包',
        description: 'VM汉化组维护的模组汉化资源包，覆盖 1.19 以上大量模组',
        source: 'github',
        gameVersions: ['all'],
        url: asset.browser_download_url,
        homepage: r.data.html_url || VM_HOMEPAGE,
        recommended: false,
        fileName: asset.name,
        size: asset.size || 0,
        version: r.data.tag_name || null,
      });
    }
  } catch { /* 忽略，走 Modrinth 回退 */ }

  // GitHub 上没有可用 Release（当前仓库返回 404）：回退到 Modrinth 上的官方分发项目
  return baseEntry({
    id: 'vm',
    name: 'VM汉化组 汉化资源包',
    description: 'VM汉化组模组汉化包（通过 Modrinth 分发），覆盖 1.19 以上大量模组',
    source: 'modrinth',
    gameVersions: ['all'],
    url: null,
    homepage: VM_HOMEPAGE,
    recommended: false,
    slug: VM_MODRINTH_SLUG,
  });
}

/** 3) Modrinth 汉化资源包搜索结果 */
async function modrinthPacks() {
  const queries = ['Chinese', '汉化'];
  const seen = new Map();
  for (const q of queries) {
    const url = `${MODRINTH_API}/search?query=${encodeURIComponent(q)}`
      + `&facets=${encodeURIComponent(MODRINTH_FACETS)}&limit=8`;
    let r;
    try {
      r = await httpJson(url, { timeoutMs: 15000 });
    } catch {
      continue;
    }
    if (!r.ok || !r.data || !Array.isArray(r.data.hits)) continue;
    for (const h of r.data.hits) {
      if (!h || !h.slug || seen.has(h.slug)) continue;
      seen.set(h.slug, baseEntry({
        id: 'modrinth:' + h.slug,
        name: h.title || h.slug,
        description: String(h.description || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        source: 'modrinth',
        gameVersions: Array.isArray(h.versions) && h.versions.length ? h.versions : ['all'],
        url: h.icon_url || null, // 这里放图标地址，下载地址在安装时按版本解析
        homepage: 'https://modrinth.com/resourcepack/' + h.slug,
        recommended: false,
        slug: h.slug,
      }));
    }
  }
  return [...seen.values()];
}

let packsCache = null; // { at, packs }
let packsInflight = null;

/**
 * 获取汉化资源包列表（静态条目 + 实时数据合并，缓存 10 分钟）。
 * @returns {Promise<Array<{id:string,name:string,description:string,type:string,source:string,gameVersions:string[],url:string|null,homepage:string|null,recommended:boolean}>>}
 */
export async function listPacks({ force = false } = {}) {
  if (!force && packsCache && Date.now() - packsCache.at < CACHE_TTL) return packsCache.packs;
  if (packsInflight) return packsInflight;

  packsInflight = (async () => {
    const [cfpa, vm, fromModrinth] = await Promise.all([
      cfpaPack().catch(() => null),
      vmPack().catch(() => null),
      modrinthPacks().catch(() => []),
    ]);

    const packs = [];
    const seenIds = new Set();
    const seenSlugs = new Set();
    for (const p of [cfpa, vm]) {
      if (!p || seenIds.has(p.id)) continue;
      seenIds.add(p.id);
      if (p.slug) seenSlugs.add(p.slug);
      packs.push(p);
    }
    for (const p of fromModrinth) {
      if (!p || seenIds.has(p.id)) continue;
      if (p.slug && seenSlugs.has(p.slug)) continue; // 避免与 vm 回退条目重复
      seenIds.add(p.id);
      packs.push(p);
    }
    if (!packs.length) packs.push(baseEntry({ id: 'cfpa', name: 'CFPA 简体中文汉化资源包', url: CFPA_FALLBACK_URL, homepage: CFPA_HOMEPAGE, recommended: true, source: 'github' }));
    packsCache = { at: Date.now(), packs };
    return packs;
  })().finally(() => { packsInflight = null; });

  return packsInflight;
}

/* ------------------------------------------------------------------ *
 * 资源包解析与安装
 * ------------------------------------------------------------------ */

/** 带 HTTP 状态码的错误（server.mjs 会优先使用 e.status） */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** 把 packId 解析成列表里的条目（缓存未命中时也能按 modrinth:slug 兜底） */
async function resolvePack(packId) {
  const id = String(packId || '').trim();
  if (!id) throw httpError(400, '缺少资源包 ID（packId）');
  const packs = await listPacks();
  let pack = packs.find((p) => p.id === id);
  if (!pack && id.startsWith('modrinth:')) {
    const slug = id.slice('modrinth:'.length);
    pack = packs.find((p) => p.slug === slug);
    if (!pack) {
      // 列表缓存里没有：直接按 slug 构造条目，安装时再解析下载地址
      let title = slug;
      let desc = '';
      try {
        const r = await httpJson(`${MODRINTH_API}/project/${encodeURIComponent(slug)}`, { timeoutMs: 15000 });
        if (r.ok && r.data) { title = r.data.title || slug; desc = r.data.description || ''; }
      } catch { /* 用默认标题 */ }
      pack = baseEntry({
        id, name: title, description: desc, source: 'modrinth', slug,
        homepage: 'https://modrinth.com/resourcepack/' + slug,
      });
    }
  }
  if (!pack) throw httpError(404, `未找到汉化资源包：${id}`);
  return pack;
}

/** 取 Modrinth 项目版本：优先匹配实例游戏版本，匹配不到回退到最新 */
async function modrinthVersions(slug, gameVersion) {
  const r = await httpJson(`${MODRINTH_API}/project/${encodeURIComponent(slug)}/version`, { timeoutMs: 20000 });
  if (!r.ok || !Array.isArray(r.data)) {
    if (r.status === 404) throw new Error('Modrinth 上不存在该项目：' + slug);
    throw new Error(`获取 Modrinth 项目版本失败（HTTP ${r.status}）`);
  }
  const usable = r.data.filter((v) => v && Array.isArray(v.files) && v.files.length);
  if (!usable.length) return [];
  const gv = String(gameVersion || '').trim();
  if (!gv) return usable;
  const matched = usable.filter((v) => Array.isArray(v.game_versions) && v.game_versions.includes(gv));
  return matched.length ? matched : usable; // 回退到最新
}

/** 解析出真正要下载的 URL / 文件名 */
async function resolveDownload(pack, gameVersion) {
  if (pack.source === 'modrinth' || pack.slug) {
    const slug = pack.slug || (String(pack.id).startsWith('modrinth:') ? String(pack.id).slice('modrinth:'.length) : String(pack.id));
    const versions = await modrinthVersions(slug, gameVersion);
    if (!versions.length) throw new Error(`「${pack.name}」没有可下载的文件`);
    const v = versions[0];
    const file = v.files[0];
    if (!file || !file.url) throw new Error(`「${pack.name}」的版本缺少下载链接`);
    return {
      url: file.url,
      fileName: file.filename || `${slug}.zip`,
      size: file.size || 0,
      version: v.version_number || v.name || null,
    };
  }
  if (!pack.url) throw new Error(`「${pack.name}」缺少下载地址`);
  let name = pack.fileName;
  if (!name) {
    try {
      const u = new URL(pack.url);
      name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '') || null;
    } catch { name = null; }
  }
  return { url: pack.url, fileName: name || `${pack.id}.zip`, size: pack.size || 0, version: pack.version || null };
}

/** 生成安全的 zip 文件名（保留中文） */
function zipFileName(name) {
  let n = safeFileName(String(name || 'translation-pack'));
  if (!/\.zip$/i.test(n)) n = n.replace(/\.(jar|mcpack)$/i, '') + '.zip';
  return n;
}

/** 实例定位：状态文件丢失但磁盘上有目录时也能工作 */
async function requireInstance(instanceId) {
  let inst = instanceId ? store.getInstance(instanceId) : resolveInstance();
  if (!inst && instanceId && await exists(instanceDir(instanceId))) {
    inst = { id: String(instanceId), name: String(instanceId), versionId: null, loader: { type: 'vanilla', version: null } };
  }
  if (!inst) throw httpError(404, '实例不存在，请先创建或选择一个实例');
  return inst;
}

/**
 * 安装汉化资源包到 `<instance>/minecraft/resourcepacks/`。
 * @param {{packId:string, instanceId?:string, gameVersion?:string}} input
 * @returns {Promise<{path:string, name:string, gameVersions:string[]}>}
 */
export async function installPack({ packId, instanceId, gameVersion, taskId: requestedTaskId = null, signal = null } = {}) {
  const inst = await requireInstance(instanceId);
  const pack = await resolvePack(packId);
  const gv = gameVersion || inst.versionId || null;
  const dl = await resolveDownload(pack, gv);

  const destDir = path.join(instanceGameDir(inst.id), 'resourcepacks');
  await ensureDir(destDir);
  const fileName = zipFileName(dl.fileName || pack.name);
  const dest = path.join(destDir, fileName);

  if (dl.size > BIG_PACK_BYTES) {
    bus.log('warn', `汉化资源包体积较大（${formatBytes(dl.size)}），下载可能需要较长时间`);
  }

  const taskId = requestedTaskId || ('translation-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  const task = bus.task(taskId, 'translation', `下载汉化资源包：${pack.name}`, dl.size || 0);
  task.update({ done: 0, total: dl.size || 0, phase: 'download', taskId, packId: pack.id, instanceId: inst.id });

  try {
    const res = await downloadFile(dl.url, dest, {
      source: 'official', // CDN 直连，不走 BMCLAPI 镜像
      retries: 3,
      timeoutMs: 300000,
      signal,
      onProgress: (p) => task.update({
        done: p.received || 0,
        total: p.total || dl.size || 0,
        bytes: p.received || 0,
        totalBytes: p.total || dl.size || 0,
        phase: 'download',
      }),
    });
    task.done({ message: `${pack.name} 已安装` });
    bus.notify('success', '汉化资源包已安装', `${pack.name}（${formatBytes(res.bytes)}）`);
    return {
      path: dest,
      name: pack.name,
      gameVersions: pack.gameVersions || ['all'],
      fileName,
      bytes: res.bytes,
      packId: pack.id,
      version: dl.version || null,
      cached: !!res.cached,
    };
  } catch (e) {
    task.fail(e);
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw httpError(502, `下载汉化资源包失败：${e && e.message ? e.message : e}`);
  }
}

/* ------------------------------------------------------------------ *
 * 自动汉化
 * ------------------------------------------------------------------ */

/** 确保 options.txt 中 lang:zh_cn（保留其余行与换行风格） */
async function ensureLangZhCn(gameDir) {
  const file = path.join(gameDir, 'options.txt');
  const raw = await readText(file, '');
  const text = raw.replace(/^\uFEFF/, '');
  const lines = text.length ? text.split(/\r?\n/) : [];
  let found = false;
  const out = lines.map((line) => {
    if (/^\s*lang\s*:/.test(line)) { found = true; return 'lang:zh_cn'; }
    return line;
  });
  if (!found) out.push('lang:zh_cn');
  while (out.length && out[out.length - 1] === '') out.pop();
  const next = out.join('\n') + '\n';
  if (next !== raw) {
    await ensureDir(gameDir);
    await fsp.writeFile(file, next, 'utf8');
    return true; // 有改动
  }
  return false;
}

async function listMods(modsDir) {
  try {
    const names = await fsp.readdir(modsDir);
    return names.filter((n) => /\.jar$/i.test(n) && !n.startsWith('.'));
  } catch {
    return [];
  }
}

/**
 * 已经存在的汉化资源包：文件名包含 CFPA / 汉化，
 * 或本启动器安装的 CFPA 官方资源名（Minecraft-Mod-Language-…）。
 */
async function existingTranslationPacks(rpDir) {
  try {
    const names = await fsp.readdir(rpDir);
    return names.filter((n) => /\.zip$/i.test(n) && /cfpa|汉化|minecraft-mod-language/i.test(n));
  } catch {
    return [];
  }
}

/**
 * 自动汉化：设置语言 → 检查模组 → 安装 CFPA 汉化包（已存在则跳过）。
 * @param {{instanceId?:string, gameVersion?:string}} input
 * @returns {Promise<{installed:boolean, packs:Array, reason?:string, modCount:number, lang:string}>}
 */
export async function autoTranslate({ instanceId, gameVersion } = {}) {
  const inst = await requireInstance(instanceId);
  const gv = gameVersion || inst.versionId || null;
  const gameDir = instanceGameDir(inst.id);
  await ensureDir(gameDir);

  // 1) 语言：始终确保简体中文
  let langChanged = false;
  try {
    langChanged = await ensureLangZhCn(gameDir);
  } catch (e) {
    bus.log('warn', '写入 options.txt 失败：' + e.message);
  }

  // 2) 是否装了模组（没有模组就没什么可汉化的）
  const mods = await listMods(path.join(gameDir, 'mods'));
  const modCount = mods.length;
  const base = { modCount, lang: 'zh_cn', langChanged, gameVersion: gv };
  if (!modCount) {
    return { installed: false, reason: '实例内没有模组', packs: [], ...base };
  }

  // 3) 已有汉化包则跳过
  const rpDir = path.join(gameDir, 'resourcepacks');
  await ensureDir(rpDir);
  const existing = await existingTranslationPacks(rpDir);
  if (existing.length) {
    return {
      installed: false,
      skipped: true,
      reason: '实例内已存在汉化资源包，无需重复安装',
      modCount,
      lang: 'zh_cn',
      langChanged,
      gameVersion: gv,
      packs: existing.map((n) => ({ path: path.join(rpDir, n), name: n, fileName: n })),
    };
  }

  // 4) 安装 CFPA 汉化包
  try {
    const r = await installPack({ packId: 'cfpa', instanceId: inst.id, gameVersion: gv });
    return { installed: true, packs: [r], ...base };
  } catch (e) {
    bus.log('warn', '自动汉化失败：' + (e && e.message));
    return {
      installed: false,
      reason: '汉化资源包安装失败：' + (e && e.message ? e.message : e),
      packs: [],
      ...base,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/**
 * 注册汉化相关路由。
 * @param {{get:Function,post:Function}} router
 * @param {object} ctx 服务器上下文（本模块只依赖自己 import 的模块）
 */
export function register(router, ctx = {}) {
  router.get('/api/translation/packs', async () => listPacks());

  router.post('/api/translation/install', async (req, res, c) => {
    const body = await c.body();
    if (!body || typeof body !== 'object') throw new Error('请求体不能为空');
    const taskId = 'translation-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const controller = new AbortController();
    if (typeof global.__MCL_REGISTER_TASK__ === 'function') global.__MCL_REGISTER_TASK__(taskId, controller);
    try {
      return await installPack({
        packId: body.packId || body.id,
        instanceId: body.instanceId,
        gameVersion: body.gameVersion,
        taskId,
        signal: controller.signal,
      });
    } finally {
      if (typeof global.__MCL_UNREGISTER_TASK__ === 'function') global.__MCL_UNREGISTER_TASK__(taskId);
    }
  });

  router.post('/api/translation/auto', async (req, res, c) => {
    const body = await c.body();
    return autoTranslate({
      instanceId: body && body.instanceId,
      gameVersion: body && body.gameVersion,
    });
  });
}
