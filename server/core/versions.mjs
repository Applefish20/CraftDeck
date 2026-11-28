/**
 * Minecraft version manager: manifest, inheritance resolution, libraries, assets, mod loaders.
 * Everything is global (shared between instances) under ROOT/launcher/shared.
 */
import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ensureDir, exists, readJson, writeJson, rmrf, sleep, uid, safeId, hostOsName, readText,
} from './util.mjs';
import {
  VERSIONS_DIR, LIBRARIES_DIR, ASSETS_DIR, INDEXES_DIR, OBJECTS_DIR, DOWNLOADS_DIR, ROOT,
  versionDir, versionJsonFile, versionJarFile, nativesDirFor,
} from './paths.mjs';
import { fetchJson, fetchRaw, downloadFile, downloadBatch, mirrorUrl, mavenPathFor } from './downloader.mjs';
import { bus } from './events.mjs';
import { store } from './store.mjs';

const MANIFEST_FILE = path.join(VERSIONS_DIR, 'version_manifest.json');
const MANIFEST_TTL = 30 * 60 * 1000;
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases';
const FORGE_INSTALLER_API = 'https://files.minecraftforge.net/net/minecraftforge/forge';

let manifestMem = null;

/** Drop the in-memory manifest so the garbage collector can reclaim it (百宝箱-内存优化). */
export function resetManifestCache() {
  manifestMem = null;
}

export function getManifestPath() { return MANIFEST_FILE; }

/** Version manifest, cached on disk and in memory. */
export async function fetchManifest({ force = false, source } = {}) {
  const src = source || store.settings.downloadSource || 'auto';
  if (!force && manifestMem && Date.now() - manifestMem.__fetchedAt < MANIFEST_TTL) return manifestMem;
  if (!force) {
    const cached = await readJson(MANIFEST_FILE, null);
    if (cached && cached.versions && Date.now() - (cached.__fetchedAt || 0) < MANIFEST_TTL) {
      manifestMem = cached;
      return cached;
    }
  }
  try {
    const url = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
    const data = await fetchJson(url, { source: src, timeoutMs: 30000, retries: 2 });
    if (!data || !Array.isArray(data.versions)) throw new Error('版本清单格式异常');
    data.__fetchedAt = Date.now();
    await ensureDir(VERSIONS_DIR);
    await writeJson(MANIFEST_FILE, data);
    manifestMem = data;
    return data;
  } catch (e) {
    const cached = await readJson(MANIFEST_FILE, null);
    if (cached && cached.versions) {
      manifestMem = cached;
      bus.log('warn', `获取版本清单失败，使用本地缓存: ${e.message}`);
      return cached;
    }
    throw e;
  }
}

export function manifestEntry(manifest, versionId) {
  return (manifest.versions || []).find((v) => v.id === versionId) || null;
}

/** All versions, newest first, filtered by UI settings. */
export async function listVersions({ includeSnapshots, includeOld, query } = {}) {
  const s = store.settings;
  const showSnap = includeSnapshots ?? s.showSnapshots;
  const showOld = includeOld ?? s.showOldVersions;
  const manifest = await fetchManifest();
  let list = manifest.versions || [];
  list = list.filter((v) => {
    if (v.type === 'release') return true;
    if (v.type === 'snapshot') return showSnap;
    return showOld;
  });
  if (query) {
    const q = String(query).toLowerCase();
    list = list.filter((v) => v.id.toLowerCase().includes(q));
  }
  return {
    latest: manifest.latest,
    fetchedAt: manifest.__fetchedAt || 0,
    versions: list.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime, url: v.url })),
  };
}

/** Download and cache one version JSON locally, returning its parsed content. */
export async function fetchVersionJson(versionId, { force = false, url } = {}) {
  const file = versionJsonFile(versionId);
  if (!force) {
    const local = await readJson(file, null);
    if (local && local.id) return local;
  }
  let remoteUrl = url;
  if (!remoteUrl) {
    const manifest = await fetchManifest();
    const entry = manifestEntry(manifest, versionId);
    if (!entry) throw new Error(`版本清单中找不到 ${versionId}`);
    remoteUrl = entry.url;
  }
  const data = await fetchJson(remoteUrl, { timeoutMs: 30000, retries: 3 });
  if (!data || !data.id) throw new Error('版本 JSON 格式异常');
  await ensureDir(versionDir(versionId));
  await writeJson(file, data);
  return data;
}

export function readLocalVersionJson(versionId) {
  const file = versionJsonFile(versionId);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Loader metadata recorded in a generated version JSON (type/version/installedAt). */
export function loaderInfoOf(versionId) {
  const json = readLocalVersionJson(versionId);
  return json?.__loader || null;
}

/** Is this version fully installed (json + client jar)? */
export async function isVersionInstalled(versionId) {
  const json = readLocalVersionJson(versionId);
  if (!json) return false;
  const jar = versionJarFile(versionId);
  if (await exists(jar)) return true;
  // inherited versions may not need their own jar
  return !!json.inheritsFrom;
}

/**
 * Resolve an inherited version chain into a single launch descriptor.
 * Child entries override parent ones (libraries by group:artifact, arguments concatenated).
 */
export async function resolveVersion(versionId, depth = 0) {
  if (depth > 6) throw new Error('版本继承层级过深，可能已损坏');
  const json = readLocalVersionJson(versionId) || await fetchVersionJson(versionId);
  const parentId = json.inheritsFrom;
  let parent = null;
  if (parentId) {
    try {
      parent = await resolveVersion(parentId, depth + 1);
    } catch (e) {
      throw new Error(`无法解析父版本 ${parentId}: ${e.message}`);
    }
  }

  const libMap = new Map();
  const addLibs = (libraries) => {
    for (const lib of libraries || []) {
      if (!lib || !lib.name) continue;
      const parts = lib.name.split(':');
      // Keep the classifier in the key: native variants share group:artifact but must all be kept
      // (they are filtered by OS/arch later), while duplicate loader libraries collapse.
      const key = parts.slice(0, 2).join(':') + ':' + (parts[3] || '');
      // Child loader libraries win over base ones with the same artifact.
      libMap.set(key, lib);
    }
  };
  addLibs(parent?.libraries);
  addLibs(json.libraries);

  const jvmArgs = [...(parent?.arguments?.jvm || []), ...(json.arguments?.jvm || [])];
  const gameArgs = [...(parent?.arguments?.game || []), ...(json.arguments?.game || [])];

  const chain = [versionId, ...(parent?.__chain || [])];
  return {
    ...parent,
    ...json,
    id: versionId,
    mainClass: json.mainClass || parent?.mainClass,
    assets: json.assets || parent?.assets,
    assetIndex: json.assetIndex || parent?.assetIndex,
    downloads: { ...(parent?.downloads || {}), ...(json.downloads || {}) },
    javaVersion: json.javaVersion || parent?.javaVersion,
    minecraftArguments: json.minecraftArguments || parent?.minecraftArguments,
    arguments: { jvm: jvmArgs, game: gameArgs },
    libraries: [...libMap.values()],
    __chain: chain,
    type: json.type || parent?.type || 'release',
  };
}

/** Does a library apply to this OS/arch? */
export function libraryAllowed(lib, features = {}) {
  // Mojang ships every native variant (windows / windows-x86 / windows-arm64) with
  // identical `os.name` rules — the arch is encoded in the classifier, so filter it here.
  const nativeMatch = /:natives-([a-z0-9-]+)$/i.exec(lib.name || '');
  if (nativeMatch) {
    const tail = nativeMatch[1].toLowerCase();
    const want = tail.endsWith('-arm64') ? 'arm64' : tail.endsWith('-x86') ? 'x86' : 'x86_64';
    const archMap = { x86_64: 'x64', x86: 'ia32', arm64: 'arm64' };
    if (process.arch !== archMap[want]) return false;
  }

  const rules = lib.rules;
  if (!rules || !rules.length) return true;
  let allow = false;
  const osName = hostOsName();
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName) match = false;
      if (rule.os.arch) {
        const arch = process.arch;
        const want = String(rule.os.arch);
        if (want === 'x86' && arch !== 'ia32') match = false;
        if (want === 'x86_64' && arch !== 'x64') match = false;
        if (want === 'arm64' && arch !== 'arm64') match = false;
      }
      if (rule.os.version) {
        try { if (!new RegExp(rule.os.version).test(os.release())) match = false; } catch { /* ignore */ }
      }
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (!!features[k] !== !!v) match = false;
      }
    }
    if (match) allow = rule.action === 'allow';
  }
  return allow;
}

export function arcForNative(lib) {
  const natives = lib.natives;
  if (!natives) return null;
  const osName = hostOsName();
  let key = natives[osName];
  if (!key) return null;
  key = key.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
  return key;
}

/** Build the download task list for a resolved version (libraries + client jar + asset index). */
export async function buildDownloadPlan(resolved, { includeAssets = true } = {}) {
  const tasks = [];
  let nativeTasks = 0;
  for (const lib of resolved.libraries || []) {
    if (!libraryAllowed(lib)) continue;
    const dl = lib.downloads || {};
    if (dl.artifact && dl.artifact.url) {
      const rel = dl.artifact.path || mavenPathFor(lib.name);
      if (!rel) continue;
      tasks.push({
        url: dl.artifact.url, sha1: dl.artifact.sha1, size: dl.artifact.size || 0,
        dest: path.join(LIBRARIES_DIR, rel), kind: 'library', name: lib.name,
      });
    }
    const nativeClassifier = arcForNative(lib);
    if (nativeClassifier && dl.classifiers && dl.classifiers[nativeClassifier]) {
      const artifact = dl.classifiers[nativeClassifier];
      const base = mavenPathFor(lib.name);
      const rel = base ? base.replace(/\.jar$/, `-${nativeClassifier}.jar`) : null;
      if (!rel) continue;
      tasks.push({
        url: artifact.url, sha1: artifact.sha1, size: artifact.size || 0,
        dest: path.join(LIBRARIES_DIR, rel), kind: 'native', name: lib.name, classifier: nativeClassifier,
      });
      nativeTasks++;
    }
    // Fabric-style libraries: no downloads object, only maven coordinates -> use Mojang central if present
    if (!dl.artifact && lib.url && /^https?:\/\//.test(lib.url)) {
      const rel = mavenPathFor(lib.name);
      if (rel) tasks.push({ url: lib.url.replace(/\/?$/, '/') + rel, dest: path.join(LIBRARIES_DIR, rel), kind: 'library', name: lib.name, optional: true });
    }
  }

  const client = resolved.downloads?.client;
  if (client && client.url && !resolved.inheritsFrom) {
    tasks.push({
      url: client.url, sha1: client.sha1, size: client.size || 0,
      dest: versionJarFile(resolved.id), kind: 'client', name: `${resolved.id}.jar`,
      mirrorUrl: `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(resolved.id)}/client`,
    });
  }

  const assetTasks = [];
  if (includeAssets && resolved.assetIndex?.url) {
    const idxFile = path.join(INDEXES_DIR, `${resolved.assetIndex.id}.json`);
    tasks.push({
      url: resolved.assetIndex.url, sha1: resolved.assetIndex.sha1, size: resolved.assetIndex.size || 0,
      dest: idxFile, kind: 'assetIndex', name: `${resolved.assetIndex.id}.json`,
    });
    const localIdx = await readJson(idxFile, null);
    if (localIdx?.objects) {
      for (const [name, obj] of Object.entries(localIdx.objects)) {
        const dest = path.join(OBJECTS_DIR, obj.hash.slice(0, 2), obj.hash);
        assetTasks.push({ url: `https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`, sha1: obj.hash, size: obj.size || 0, dest, kind: 'asset', name });
      }
    }
  }
  return { tasks, assetTasks, nativeTasks };
}

/** Make sure a version's JSON + client jar + libraries + (optionally) assets are present. */
export async function installVersion(versionId, job) {
  const taskId = job?.taskId || uid('task_');
  const signal = job?.signal || null;
  const resolved = await resolveVersion(versionId);
  await ensureDir(versionDir(versionId));
  // Persist resolved loader JSON so other tools can see it (already written for vanilla).
  const plan = await buildDownloadPlan(resolved);
  let total = plan.tasks.length;
  let bytesTotal = plan.tasks.reduce((a, t) => a + (t.size || 0), 0);
  const prog = { done: 0, total, bytes: 0, totalBytes: bytesTotal };
  const emit = (label, extra = {}) => {
    bus.progress({
      taskId, scope: 'version', label, versionId,
      done: prog.done, total: prog.total, bytes: prog.bytes, totalBytes: prog.totalBytes,
      percent: prog.total ? Math.min(1, prog.done / prog.total) : 1, ...extra,
    });
  };
  emit('准备文件');

  const res = await downloadBatch(plan.tasks, {
    concurrency: store.settings.maxConcurrentDownloads || 16,
    source: store.settings.downloadSource,
    signal,
    label: '下载游戏文件',
    onProgress: (p) => {
      prog.bytes = p.bytes;
      prog.done = Math.floor((p.done / Math.max(1, p.total)) * plan.tasks.length);
      emit(`下载游戏文件 ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''}`);
    },
  });
  if (signal && signal.aborted) throw new Error('已暂停');
  if (res.failed) {
    const fatal = res.errors.filter((e) => !e.optional && ['client', 'library', 'assetIndex'].includes(e.kind));
    if (fatal.length) {
      const msg = fatal.map((e) => e.error).slice(0, 3).join('; ');
      throw new Error('游戏文件下载失败: ' + msg);
    }
  }

  // Extract legacy natives + fabric-style natives after libraries are in place.
  emit('解压本地库');
  await extractNatives(resolved);

  // Asset objects: the index must be on disk first, so this happens after the first batch.
  const assetTasks = await collectAssetTasks(resolved);
  if (signal && signal.aborted) throw new Error('已暂停');
  if (assetTasks.length) {
    prog.total = plan.tasks.length + assetTasks.length;
    prog.totalBytes = bytesTotal + assetTasks.reduce((a, t) => a + (t.size || 0), 0);
    const assetRes = await downloadBatch(assetTasks, {
      concurrency: Math.max(16, store.settings.maxConcurrentDownloads || 16),
      source: store.settings.downloadSource,
      signal,
      label: '下载游戏资源',
      onProgress: (p) => {
        prog.bytes = p.bytes;
        prog.done = plan.tasks.length + p.done;
        emit(`下载资源文件 ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''}`);
      },
    });
    if (assetRes.failed && assetRes.failed > assetRes.total * 0.5) {
      throw new Error(`资源文件下载失败 ${assetRes.failed}/${assetRes.total}，请检查网络或切换下载源`);
    }
    if (signal && signal.aborted) throw new Error('已暂停');
    await buildVirtualAssets(resolved);
  }

  prog.done = prog.total;
  emit('安装完成', { finished: true, ok: true });
  return { versionId, resolved, total: prog.total };
}

/** Read the on-disk asset index and produce one download task per missing object. */
export async function collectAssetTasks(resolved) {
  if (!resolved.assetIndex?.id) return [];
  const idxFile = path.join(INDEXES_DIR, `${resolved.assetIndex.id}.json`);
  const idx = await readJson(idxFile, null);
  if (!idx?.objects) return [];
  const tasks = [];
  for (const [name, obj] of Object.entries(idx.objects)) {
    const dest = path.join(OBJECTS_DIR, obj.hash.slice(0, 2), obj.hash);
    tasks.push({
      url: `https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`,
      sha1: obj.hash, size: obj.size || 0, dest, kind: 'asset', name,
    });
  }
  return tasks;
}

/** Extract native jars (legacy per-library classifiers) into the shared natives dir. */
export async function extractNatives(resolved) {
  const target = nativesDirFor(resolved.id);
  await ensureDir(target);
  for (const lib of resolved.libraries || []) {
    if (!libraryAllowed(lib)) continue;
    const classifier = arcForNative(lib);
    if (!classifier) continue;
    const dl = lib.downloads?.classifiers?.[classifier];
    const rel = dl?.path || (mavenPathFor(lib.name) || '').replace(/\.jar$/, `-${classifier}.jar`);
    if (!rel) continue;
    const jar = path.join(LIBRARIES_DIR, rel);
    if (!(await exists(jar))) continue;
    await extractJar(jar, target, (name) => {
      if (name.startsWith('META-INF/')) return false;
      return !name.endsWith('/');
    });
  }
  return target;
}

/** Minimal ZIP extraction for native jars (stored + deflate). */
export async function extractJar(jarPath, targetDir, filter = () => true) {
  const buf = await fsp.readFile(jarPath);
  const eocd = findEocd(buf);
  if (!eocd) return 0;
  let count = 0;
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  const total = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < total && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!filter(name)) continue;
    try {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const comp = buf.subarray(start, start + compSize);
      let data;
      if (method === 0) data = comp;
      else if (method === 8) data = await inflateRaw(comp);
      else continue;
      const out = path.join(targetDir, name);
      if (!out.startsWith(targetDir)) continue;
      await ensureDir(path.dirname(out));
      await fsp.writeFile(out, data);
      count++;
    } catch { /* skip broken entry */ }
  }
  return count;
}

async function inflateRaw(buf) {
  const zlib = await import('node:zlib');
  return new Promise((resolve, reject) => {
    zlib.inflateRaw(buf, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Legacy (<1.7) asset layout: build assets/<index>/<name> virtual folder. */
export async function buildVirtualAssets(resolved) {
  const idxFile = path.join(INDEXES_DIR, `${resolved.assetIndex?.id}.json`);
  const idx = await readJson(idxFile, null);
  if (!idx || !(idx.virtual || idx.map_to_resources)) return;
  const base = idx.map_to_resources ? path.join(ASSETS_DIR, 'resources') : path.join(ASSETS_DIR, 'virtual', 'legacy');
  for (const [name, obj] of Object.entries(idx.objects || {})) {
    const src = path.join(OBJECTS_DIR, obj.hash.slice(0, 2), obj.hash);
    const dst = path.join(base, name);
    try {
      if (!(await exists(dst))) {
        await ensureDir(path.dirname(dst));
        await fsp.copyFile(src, dst);
      }
    } catch { /* ignore */ }
  }
}

/** Resolve all library paths (existing jars) for the classpath, in order. */
export async function classpathFor(resolved) {
  const entries = [];
  for (const lib of resolved.libraries || []) {
    if (!libraryAllowed(lib)) continue;
    const rel = lib.downloads?.artifact?.path || mavenPathFor(lib.name);
    if (!rel) continue;
    const p = path.join(LIBRARIES_DIR, rel);
    if (await exists(p)) entries.push(p);
  }
  const chain = resolved.__chain || [resolved.id];
  for (const id of chain) {
    const jar = versionJarFile(id);
    if (await exists(jar)) { entries.push(jar); break; }
  }
  return entries;
}

// ------------------------------------------------------------------ loaders

export async function listLoaderVersions(type, gameVersion) {
  switch (type) {
    case 'fabric': {
      const data = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`, { timeoutMs: 20000 });
      return (data || []).map((x) => ({ version: x.loader.version, stable: x.loader.stable, maven: x.loader.maven }));
    }
    case 'quilt': {
      const data = await fetchJson(`${QUILT_META}/versions/loader/${encodeURIComponent(gameVersion)}`, { timeoutMs: 20000 });
      return (data || []).map((x) => ({ version: x.loader.version, stable: true, maven: x.loader.maven }));
    }
    case 'forge': {
      const meta = await fetchRaw(`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`, { timeoutMs: 20000 });
      const all = [...String(meta).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
      const prefix = `${gameVersion}-`;
      return all.filter((v) => v.startsWith(prefix)).map((v) => ({ version: v.slice(prefix.length), id: v, stable: !/-beta|-alpha/i.test(v) })).reverse();
    }
    case 'neoforge': {
      const data = await fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', { timeoutMs: 20000 });
      const all = data?.versions || [];
      const short = gameVersion.replace(/^1\./, '');
      const matching = all.filter((v) => v.startsWith(short + '.') || v === short);
      return (matching.length ? matching : all.slice(-40)).map((v) => ({ version: v, stable: !/beta/i.test(v) }));
    }
    default:
      return [];
  }
}

async function ensureLauncherProfiles() {
  const f = path.join(ROOT, 'launcher_profiles.json');
  if (!(await exists(f))) {
    await writeJson(f, { profiles: {}, selectedProfile: '', clientToken: '', authenticationDatabase: {}, launcherVersion: { name: 'CraftDeck', format: 21 } });
  }
}

/**
 * Install a mod loader for a base version.
 * Returns the concrete version id that should be launched.
 */
export async function installLoader(type, gameVersion, loaderVersion, job = {}) {
  const taskId = job.taskId || uid('task_');
  const signal = job.signal || null;
  const progress = (label, extra = {}) => bus.progress({ taskId, scope: 'loader', label, versionId: gameVersion, ...extra });
  if (!type || type === 'vanilla') return gameVersion;

  // Ensure the vanilla base is present first.
  await installVersion(gameVersion, { taskId });

  if (type === 'fabric' || type === 'quilt') {
    progress('获取加载器元数据');
    const metaBase = type === 'fabric' ? FABRIC_META : QUILT_META;
    let ver = loaderVersion;
    if (!ver) {
      const list = await listLoaderVersions(type, gameVersion);
      const stable = list.find((v) => v.stable) || list[0];
      if (!stable) throw new Error(`${type} 没有适用于 ${gameVersion} 的加载器版本`);
      ver = stable.version;
    }
    const profile = await fetchJson(`${metaBase}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(ver)}/profile/json`, { timeoutMs: 25000 });
    if (!profile || !profile.id) throw new Error('获取加载器配置失败');
    profile.inheritsFrom = gameVersion;
    profile.__loader = { type, version: ver, installedAt: Date.now() };
    await ensureDir(versionDir(profile.id));
    await writeJson(versionJsonFile(profile.id), profile);
    // Download the loader libraries (maven coordinates, no checksums from meta).
    progress('下载加载器库');
    const tasks = [];
    for (const lib of profile.libraries || []) {
      const rel = mavenPathFor(lib.name);
      if (!rel) continue;
      const dest = path.join(LIBRARIES_DIR, rel);
      if (await exists(dest)) continue;
      const repo = (lib.url || 'https://maven.fabricmc.net/').replace(/\/?$/, '/');
      tasks.push({ url: repo + rel, dest, name: lib.name, size: 0, optional: true });
    }
    const res = await downloadBatch(tasks, { concurrency: 6, signal, label: '下载加载器库', onProgress: (p) => progress(`下载加载器库 ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''}`, { percent: p.percent }) });
    if (signal && signal.aborted) throw new Error('已暂停');
    if (res.failed && res.failed === res.total && res.total > 0) throw new Error('加载器库下载失败，请检查网络');
    progress('加载器安装完成', { finished: true, ok: true });
    return profile.id;
  }

  if (type === 'forge' || type === 'neoforge') {
    return installForgeLike(type, gameVersion, loaderVersion, taskId);
  }
  throw new Error(`暂不支持的加载器类型: ${type}`);
}

async function installForgeLike(type, gameVersion, loaderVersion, taskId) {
  await ensureLauncherProfiles();
  const progress = (label, extra = {}) => bus.progress({ taskId, scope: 'loader', label, versionId: gameVersion, ...extra });
  let fullVersion;
  let installerUrl;
  if (type === 'forge') {
    let ver = loaderVersion;
    if (!ver) {
      const list = await listLoaderVersions('forge', gameVersion);
      const pick = list.find((v) => v.stable) || list[0];
      if (!pick) throw new Error(`Forge 没有适用于 ${gameVersion} 的版本`);
      ver = pick.version;
    }
    fullVersion = `${gameVersion}-${ver}`;
    installerUrl = `${FORGE_MAVEN}/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;
  } else {
    let ver = loaderVersion;
    if (!ver) {
      const list = await listLoaderVersions('neoforge', gameVersion);
      ver = (list.find((v) => v.stable) || list[0])?.version;
      if (!ver) throw new Error(`NeoForge 没有适用于 ${gameVersion} 的版本`);
    }
    fullVersion = `${gameVersion}-${ver}`;
    installerUrl = `${NEOFORGE_MAVEN}/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`;
  }

  const installerDir = path.join(DOWNLOADS_DIR, 'installers');
  await ensureDir(installerDir);
  const installer = path.join(installerDir, `${type}-${fullVersion}-installer.jar`);
  progress('下载安装器');
  await downloadFile(installerUrl, installer, {
    signal,
    source: 'auto',
    retries: 3,
    timeoutMs: 120000,
    onProgress: (p) => progress(`下载安装器 ${p.total ? Math.round((p.received / p.total) * 100) : 0}%`, { percent: p.total ? p.received / p.total : 0 }),
  });

  progress('运行安装器（可能需要几分钟）');
  const javaPath = await pickInstallerJava();
  // Legacy Forge installers (<1.13) require the target directory; modern ones take it optionally.
  const legacyArgs = type === 'forge' && /^\d+\.\d+(\.\d+)?$/.test(loaderVersion || '') &&
    (() => { const minor = Number(String(loaderVersion).split('.')[0]); return minor < 13; })();
  const args = legacyArgs ? ['-jar', installer, '--installClient', ROOT] : ['-jar', installer, '--installClient'];
  await runProcess(javaPath, args, {
    cwd: ROOT,
    onLine: (line) => {
      const clean = line.trim();
      if (clean && /error|exception|failed|installing|extract|download/i.test(clean)) progress(clean.slice(0, 160));
    },
    timeoutMs: 15 * 60 * 1000,
  });

  // Find the generated version folder that inherits the base version.
  const versionIds = [];
  try {
    for (const d of await fsp.readdir(VERSIONS_DIR)) {
      const j = readLocalVersionJson(d);
      if (j && j.inheritsFrom === gameVersion && (j.id.includes('forge') || j.id.includes('neoforge'))) versionIds.push({ id: j.id, mtime: fs.statSync(versionJsonFile(d)).mtimeMs });
    }
  } catch { /* ignore */ }
  versionIds.sort((a, b) => b.mtime - a.mtime);
  if (!versionIds.length) throw new Error('安装器未生成版本 JSON，请查看日志');
  const installedId = versionIds[0].id;
  const json = readLocalVersionJson(installedId);
  json.__loader = { type, version: fullVersion, installedAt: Date.now() };
  await writeJson(versionJsonFile(installedId), json);
  progress('安装器执行完成', { finished: true, ok: true });
  return installedId;
}

async function pickInstallerJava() {
  const { pickJava } = await import('./java.mjs').catch(() => ({ pickJava: async () => 'java' }));
  try { return await pickJava({ major: 8 }); } catch { return 'java'; }
}

/** Run a java process and stream lines. */
export function runProcess(cmd, args, { cwd, onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error('进程超时')); }, timeoutMs);
    const feed = (stream) => (buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine && onLine(line, stream);
    };
    child.stdout.on('data', feed('stdout'));
    child.stderr.on('data', feed('stderr'));
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { if (timer) clearTimeout(timer); resolve(code); });
  });
}

/** Download a vanilla server jar (used by the hosting feature). */
export async function downloadVanillaServer(versionId, dest) {
  const vj = await fetchVersionJson(versionId);
  const server = vj.downloads?.server;
  if (!server?.url) throw new Error(`版本 ${versionId} 没有提供官方服务端下载`);
  await downloadFile(server.url, dest, {
    sha1: server.sha1, size: server.size, source: store.settings.downloadSource, timeoutMs: 300000,
    mirrorUrl: `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(versionId)}/server`,
  });
  return dest;
}

export { MANIFEST_FILE, LIBRARIES_DIR, ASSETS_DIR, OBJECTS_DIR, INDEXES_DIR, VERSIONS_DIR };
