/**
 * CraftDeck — local dedicated server hosting.
 *
 * Creates a server directory under ROOT/servers/<id>/, downloads the appropriate
 * server software, writes eula.txt / server.properties / start scripts, and manages
 * the java process (start, stop, console, logs, properties).
 *
 * Zero third-party dependencies. All user-facing messages are Chinese.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { ROOT } from '../core/paths.mjs';
import { store } from '../core/store.mjs';
import { bus } from '../core/events.mjs';
import {
  ensureDir, readText, rmrf, uid, safeId, sleep,
} from '../core/util.mjs';
import { downloadFile, fetchJson } from '../core/downloader.mjs';
import { findJavas, pickJava, requiredJavaFor } from '../core/java.mjs';

// ---------------------------------------------------------------------------
// constants / state
// ---------------------------------------------------------------------------

const SERVERS_DIR = path.join(ROOT, 'servers');
const MAX_LOG_LINES = 2000;
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const UA = 'CraftDeck/1.0 (Minecraft Launcher; +https://github.com/craftdeck)';
const SERVER_TYPES = new Set(['vanilla', 'paper', 'purpur', 'fabric', 'quilt', 'forge', 'neoforge']);
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MIN_MEMORY = 512;
const MAX_MEMORY = 16384;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Live host processes. Intentionally module-level: a module reload drops the map,
 * which is fine because store.hosts keeps the persisted (installed/stopped) state.
 * @type {Map<string, object>}
 */
const procs = new Map();

/** Mojang manifest cache (10 min) + java-requirement cache per version. */
const manifestCache = { at: 0, data: null };
const javaMajorCache = new Map();

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function hostDir(id) {
  return path.join(SERVERS_DIR, safeId(id));
}

function jarPathName(name) {
  return path.basename(String(name || 'server.jar'));
}

function requireHost(id) {
  const host = store.hosts.find((h) => h.id === id);
  if (!host) throw httpError('服务器不存在或已被删除', 404);
  return host;
}

function progress(taskId, hostId, patch) {
  try {
    bus.progress({ taskId, scope: 'host', hostId, ...patch });
  } catch { /* progress must never break an install */ }
}

function hostLog(hostId, line) {
  try {
    bus.emitEvent({ type: 'host', hostId, line: String(line), stream: 'launcher' });
  } catch { /* ignore */ }
}

/** Read the last `n` lines without loading a potentially huge console.log into memory. */
async function tailFile(file, n) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const stat = await fh.stat();
    if (!stat.size) return [];
    const maxBytes = 512 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0 && lines.length) lines.shift(); // first line may be partial
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-Math.max(1, n));
  } catch {
    return [];
  } finally {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// server.properties
// ---------------------------------------------------------------------------

function propertiesFile(dir) {
  return path.join(dir, 'server.properties');
}

/** @returns {Promise<Record<string,string>>} */
async function readProperties(dir) {
  const text = await readText(propertiesFile(dir), '');
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    props[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return props;
}

function propValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).replace(/[\r\n]/g, ' ');
}

/**
 * Rewrite server.properties in place: known keys are updated, unknown keys and
 * comments are preserved, new keys are appended.
 */
async function writeProperties(dir, properties) {
  const file = propertiesFile(dir);
  let lines = [];
  try {
    lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
  } catch { /* new file */ }
  const updated = new Set();
  const out = [];
  for (const line of lines) {
    const m = /^([^#!\s][^=]*)=(.*)$/.exec(line);
    if (!m) { out.push(line); continue; }
    const key = m[1].trim();
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      out.push(`${key}=${propValue(properties[key])}`);
      updated.add(key);
    } else {
      out.push(line);
    }
  }
  const missing = Object.keys(properties).filter((k) => !updated.has(k));
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const key of missing) out.push(`${key}=${propValue(properties[key])}`);
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  await fsp.writeFile(file, out.join('\r\n') + '\r\n', 'utf8');
  return properties;
}

function propertiesText(properties) {
  const header = [
    '#Minecraft server properties',
    `#${new Date().toUTCString()}`,
    '#Generated by CraftDeck',
  ];
  return header.join('\r\n') + '\r\n' + Object.entries(properties).map(([k, v]) => `${k}=${propValue(v)}`).join('\r\n') + '\r\n';
}

function defaultProperties(host) {
  const port = Number(host.port) || 25565;
  return {
    'server-port': port,
    'motd': String(host.motd || host.name || 'CraftDeck Server').slice(0, 120),
    'max-players': Math.min(1000, Math.max(1, Number(host.maxPlayers) || 20)),
    'online-mode': host.onlineMode !== false,
    'level-seed': host.seed || '',
    'view-distance': 10,
    'white-list': false,
    'enable-command-block': true,
    'gamemode': 'survival',
    'difficulty': 'easy',
    'pvp': true,
    'spawn-protection': 16,
    'level-name': 'world',
    'allow-flight': false,
    'enable-status': true,
  };
}

function eulaText(accepted) {
  return [
    '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).',
    `#${new Date().toUTCString()}`,
    '#Written by CraftDeck',
    `eula=${accepted ? 'true' : 'false'}`,
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// launch spec (jar / forge @args)
// ---------------------------------------------------------------------------

function findArgsFile(dir) {
  const bases = [
    path.join(dir, 'libraries', 'net', 'minecraftforge', 'forge'),
    path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge'),
  ];
  for (const base of bases) {
    let versions = [];
    try { versions = fs.readdirSync(base).sort().reverse(); } catch { continue; }
    for (const version of versions) {
      for (const name of ['win_args.txt', 'unix_args.txt']) {
        const candidate = path.join(base, version, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Resolve how to start a host: a jar, or an @args file generated by Forge/NeoForge. */
function findRunnableSpec(host) {
  const dir = hostDir(host.id);
  if (host.jar) {
    const candidate = path.isAbsolute(host.jar) ? host.jar : path.join(dir, jarPathName(host.jar));
    if (fs.existsSync(candidate)) return { jar: candidate, args: [] };
  }
  const argsFile = findArgsFile(dir);
  if (argsFile) return { jar: null, args: ['@' + path.relative(dir, argsFile), 'nogui'] };

  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const name of ['server.jar', 'fabric-server-launch.jar', 'quilt-server-launch.jar']) {
    if (entries.includes(name)) return { jar: path.join(dir, name), args: [] };
  }
  const anyJar = entries.sort().find((n) => /\.jar$/i.test(n) && !/installer/i.test(n));
  return anyJar ? { jar: path.join(dir, anyJar), args: [] } : null;
}

function launchArgList(spec, memoryMb) {
  const memory = Math.min(MAX_MEMORY, Math.max(MIN_MEMORY, Number(memoryMb) || 2048));
  const args = [
    `-Xms${Math.min(memory, 1024)}M`,
    `-Xmx${memory}M`,
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
  ];
  if (spec.jar) return [...args, '-jar', spec.jar, 'nogui'];
  const extra = [...(spec.args || [])];
  if (!extra.includes('nogui')) extra.push('nogui');
  return [...args, ...extra];
}

function pickHostJava(host) {
  const required = Number(host.javaMajor) || 21;
  let preferred = 'auto';
  try {
    preferred = store.settings?.javaPath || 'auto';
  } catch { /* ignore */ }
  try {
    return pickJava({ major: required, preferred });
  } catch {
    return 'java';
  }
}

function shellQuote(value) {
  const s = String(value);
  return /\s/.test(s) ? `"${s}"` : s;
}

async function writeStartScripts(host) {
  const dir = hostDir(host.id);
  const spec = findRunnableSpec(host) || { jar: path.join(dir, 'server.jar'), args: [] };
  const java = pickHostJava(host);
  // Keep the script portable: reference a jar inside the server dir by file name.
  let jarForScript = spec.jar;
  try {
    if (jarForScript && path.resolve(path.dirname(jarForScript)) === path.resolve(dir)) {
      jarForScript = path.basename(jarForScript);
    }
  } catch { /* keep absolute */ }
  const args = launchArgList({ ...spec, jar: jarForScript }, host.memoryMb);
  const command = [shellQuote(java), ...args.map(shellQuote)].join(' ');
  const displayName = String(host.name || 'Minecraft Server').replace(/[\r\n"]/g, ' ');

  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    `title ${displayName}`,
    'cd /d "%~dp0"',
    command,
    'echo.',
    'echo 服务器已停止，按任意键关闭窗口。',
    'pause >nul',
    '',
  ].join('\r\n');
  const sh = [
    '#!/bin/sh',
    'cd "$(dirname "$0")" || exit 1',
    `# ${displayName}`,
    `exec ${command}`,
    '',
  ].join('\n');

  try { await fsp.writeFile(path.join(dir, 'start.bat'), bat, 'utf8'); } catch { /* ignore */ }
  try {
    const shFile = path.join(dir, 'start.sh');
    await fsp.writeFile(shFile, sh, 'utf8');
    await fsp.chmod(shFile, 0o755).catch(() => {});
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// download / install helpers
// ---------------------------------------------------------------------------

async function getManifest(force = false) {
  if (!force && manifestCache.data && Date.now() - manifestCache.at < 10 * 60_000) return manifestCache.data;
  const data = await fetchJson(MANIFEST_URL, { timeoutMs: 30000, retries: 2 });
  if (!data || !Array.isArray(data.versions)) throw new Error('无法获取 Minecraft 版本清单');
  manifestCache.at = Date.now();
  manifestCache.data = data;
  return data;
}

/** Minimum Java major for a Minecraft version (fetches that version's JSON once). */
async function javaMajorForVersion(version) {
  if (javaMajorCache.has(version)) return javaMajorCache.get(version);
  let major = 21;
  try {
    const manifest = await getManifest();
    const entry = (manifest.versions || []).find((v) => v.id === version);
    if (entry) {
      const vjson = await fetchJson(entry.url, { timeoutMs: 30000, retries: 1 });
      major = requiredJavaFor(vjson) || 21;
    }
  } catch { /* keep default */ }
  javaMajorCache.set(version, major);
  return major;
}

async function downloadJar({ url, dest, sha1, size, source = 'auto', label, hostId, taskId }) {
  const knownTotal = Number(size) || 0;
  let lastEmit = 0;
  const emit = (received, total) => {
    const tot = total || knownTotal || received || 0;
    const ratio = tot > 0 ? Math.min(1, Math.max(0, received / tot)) : 0;
    progress(taskId, hostId, {
      phase: 'download', label, done: received, total: tot, bytes: received, totalBytes: tot,
      percent: 0.05 + 0.85 * ratio,
    });
  };
  emit(0, knownTotal);
  const result = await downloadFile(url, dest, {
    sha1: sha1 || null,
    size: knownTotal || 0,
    source,
    retries: 3,
    timeoutMs: 180000,
    onProgress: (p) => {
      const now = Date.now();
      if (p.received !== p.total && now - lastEmit < 150) return;
      lastEmit = now;
      emit(p.received || 0, p.total || 0);
    },
  });
  emit(result.bytes || knownTotal, result.bytes || knownTotal);
  return result;
}

function streamInstaller({ hostId, taskId, args, cwd, label, java, timeoutMs = INSTALL_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(java, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`无法启动安装器: ${e.message}`));
      return;
    }
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const tail = [];
    let settled = false;
    let lineCount = 0;

    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code, tail });
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error('安装器执行超时（10 分钟），请检查网络后重试'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const onChunk = (stream) => (chunk) => {
      const text = decoders[stream].write(chunk);
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 60) tail.shift();
        hostLog(hostId, line);
        lineCount++;
        if (lineCount % 20 === 0) {
          progress(taskId, hostId, { phase: 'install', label, note: line.slice(0, 160) });
        }
      }
    };
    child.stdout.on('data', onChunk('stdout'));
    child.stderr.on('data', onChunk('stderr'));
    child.on('error', (e) => finish(new Error(`安装器启动失败: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish(null, code);
      else finish(new Error(`安装器失败（退出码 ${code}）\n${tail.slice(-8).join('\n')}`));
    });
  });
}

function pickInstallerJava(major) {
  let preferred = 'auto';
  try { preferred = store.settings?.javaPath || 'auto'; } catch { /* ignore */ }
  try {
    return pickJava({ major: Math.min(Math.max(Number(major) || 17, 8), 21), preferred });
  } catch {
    return 'java';
  }
}

// ---------------------------------------------------------------------------
// per-type installation
// ---------------------------------------------------------------------------

async function installVanilla(host, { taskId }) {
  const dir = hostDir(host.id);
  const manifest = await getManifest();
  const entry = (manifest.versions || []).find((v) => v.id === host.gameVersion);
  if (!entry) throw new Error(`找不到 Minecraft 版本 ${host.gameVersion}，请检查版本号`);
  progress(taskId, host.id, { phase: 'resolve', label: `解析 ${host.gameVersion}` });
  const vjson = await fetchJson(entry.url, { timeoutMs: 30000, retries: 1 });
  const server = vjson && vjson.downloads && vjson.downloads.server;
  if (!server || !server.url) {
    throw new Error(`版本 ${host.gameVersion} 没有官方服务端下载（可能是非常旧的快照），请改用 Paper / Purpur 等服务端`);
  }
  await downloadJar({
    url: server.url,
    dest: path.join(dir, 'server.jar'),
    sha1: server.sha1,
    size: server.size,
    label: `下载原版服务端 ${host.gameVersion}`,
    hostId: host.id,
    taskId,
  });
  const major = requiredJavaFor(vjson) || (await javaMajorForVersion(host.gameVersion));
  return { jar: 'server.jar', javaMajor: major };
}

async function paperBuild(version) {
  // PaperMC API v2 was sunset (HTTP 410); try it anyway for older mirrors, then v3.
  try {
    const data = await fetchJson(
      `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(version)}/builds`,
      { timeoutMs: 15000, retries: 0, headers: { 'User-Agent': UA } },
    );
    const builds = Array.isArray(data) ? data : (Array.isArray(data && data.builds) ? data.builds : []);
    if (builds.length) {
      const latest = builds.slice().sort((a, b) => (Number(b.build) || 0) - (Number(a.build) || 0))[0];
      const dl = latest && latest.downloads && latest.downloads.application;
      if (dl && dl.name) {
        return {
          url: `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(version)}/builds/${latest.build}/downloads/${dl.name}`,
          size: Number(dl.size) || 0,
          name: dl.name,
          build: latest.build,
        };
      }
    }
  } catch { /* v2 gone → fall through to v3 */ }

  const data = await fetchJson(
    `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`,
    { timeoutMs: 30000, retries: 1, headers: { 'User-Agent': UA } },
  );
  const builds = Array.isArray(data) ? data : [];
  if (!builds.length) throw new Error(`Paper 没有适用于 ${version} 的构建，请换一个版本或使用原版`);
  const latest = builds.slice().sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))[0];
  const downloads = latest.downloads || {};
  const dl = downloads['server:default'] || Object.values(downloads)[0];
  if (!dl || !dl.url) throw new Error('Paper 下载地址缺失，请稍后重试');
  return { url: dl.url, size: Number(dl.size) || 0, name: dl.name || `paper-${version}.jar`, build: latest.id };
}

async function installPaper(host, { taskId }) {
  const dir = hostDir(host.id);
  const build = await paperBuild(host.gameVersion);
  progress(taskId, host.id, { phase: 'resolve', label: `Paper ${host.gameVersion} build ${build.build}` });
  await downloadJar({
    url: build.url,
    dest: path.join(dir, 'server.jar'),
    size: build.size,
    label: `下载 Paper ${host.gameVersion} (build ${build.build})`,
    hostId: host.id,
    taskId,
  });
  return { jar: 'server.jar', javaMajor: await javaMajorForVersion(host.gameVersion) };
}

async function installPurpur(host, { taskId }) {
  const dir = hostDir(host.id);
  let build = null;
  try {
    const meta = await fetchJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(host.gameVersion)}/latest`, {
      timeoutMs: 15000, retries: 1,
    });
    build = (meta && meta.build) || null;
  } catch { /* metadata is optional */ }
  await downloadJar({
    url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(host.gameVersion)}/latest/download`,
    dest: path.join(dir, 'server.jar'),
    label: `下载 Purpur ${host.gameVersion}${build ? ` (build ${build})` : ''}`,
    hostId: host.id,
    taskId,
  });
  return { jar: 'server.jar', javaMajor: await javaMajorForVersion(host.gameVersion) };
}

async function fabricServerJar(version, taskId, hostId) {
  const loaders = await fetchJson(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`,
    { timeoutMs: 20000, retries: 1, source: 'official' },
  );
  if (!Array.isArray(loaders) || !loaders.length) {
    throw new Error(`Fabric 不支持 Minecraft ${version}，请换一个版本`);
  }
  const stable = loaders.find((l) => l && l.loader && l.loader.stable) || loaders[0];
  const loaderVersion = stable && stable.loader && stable.loader.version;
  if (!loaderVersion) throw new Error('无法确定 Fabric Loader 版本');
  const installers = await fetchJson('https://meta.fabricmc.net/v2/versions/installer', {
    timeoutMs: 20000, retries: 1, source: 'official',
  });
  const installer = (Array.isArray(installers) ? installers.find((i) => i.stable) : null) || (Array.isArray(installers) ? installers[0] : null);
  if (!installer || !installer.version) throw new Error('无法确定 Fabric 安装器版本');
  progress(taskId, hostId, { phase: 'resolve', label: `Fabric Loader ${loaderVersion}` });
  return {
    url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installer.version)}/server/jar`,
    loaderVersion,
  };
}

async function installFabric(host, { taskId }) {
  const dir = hostDir(host.id);
  const jar = await fabricServerJar(host.gameVersion, taskId, host.id);
  await downloadJar({
    url: jar.url,
    dest: path.join(dir, 'fabric-server-launch.jar'),
    source: 'official',
    label: `下载 Fabric 服务端 ${host.gameVersion}`,
    hostId: host.id,
    taskId,
  });
  await fsp.writeFile(path.join(dir, 'fabric-server-launcher.properties'), 'serverJar=server.jar\r\n', 'utf8');
  return { jar: 'fabric-server-launch.jar', javaMajor: await javaMajorForVersion(host.gameVersion), loaderVersion: jar.loaderVersion };
}

async function installQuilt(host, { taskId }) {
  const dir = hostDir(host.id);
  const installers = await fetchJson('https://meta.quiltmc.org/v3/versions/installer', { timeoutMs: 20000, retries: 1 });
  const installer = Array.isArray(installers)
    ? installers.slice().sort((a, b) => String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true }))[0]
    : null;
  if (!installer || !installer.url) throw new Error('无法获取 Quilt 安装器');
  const installerPath = path.join(dir, 'quilt-installer.jar');
  await downloadJar({
    url: installer.url,
    dest: installerPath,
    label: '下载 Quilt 安装器',
    hostId: host.id,
    taskId,
  });
  progress(taskId, host.id, { phase: 'install', label: '安装 Quilt 服务端（首次启动会下载依赖）', percent: 0.5 });
  await streamInstaller({
    hostId: host.id,
    taskId,
    java: pickInstallerJava(await javaMajorForVersion(host.gameVersion)),
    args: ['-jar', installerPath, 'install', 'server', host.gameVersion, '--install-dir', dir],
    cwd: dir,
    label: '安装 Quilt 服务端',
  });
  const spec = findRunnableSpec({ ...host, jar: null });
  if (!spec) throw new Error('Quilt 安装完成，但未找到服务端启动文件');
  return { jar: spec.jar ? path.basename(spec.jar) : null, javaMajor: await javaMajorForVersion(host.gameVersion) };
}

async function installForge(host, { taskId }) {
  const dir = hostDir(host.id);
  const promos = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', {
    timeoutMs: 20000, retries: 2,
  });
  const promosMap = (promos && promos.promos) || {};
  const forgeVersion = promosMap[`${host.gameVersion}-latest`] || promosMap[`${host.gameVersion}-recommended`];
  if (!forgeVersion) throw new Error(`Forge 没有适用于 Minecraft ${host.gameVersion} 的版本`);
  const fullId = `${host.gameVersion}-${forgeVersion}`;
  const installerPath = path.join(dir, 'forge-installer.jar');
  progress(taskId, host.id, { phase: 'resolve', label: `Forge ${fullId}` });
  await downloadJar({
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullId}/forge-${fullId}-installer.jar`,
    dest: installerPath,
    label: `下载 Forge 安装器 ${fullId}`,
    hostId: host.id,
    taskId,
  });
  progress(taskId, host.id, { phase: 'install', label: `安装 Forge ${fullId}（可能需要几分钟）`, percent: 0.5 });
  await streamInstaller({
    hostId: host.id,
    taskId,
    java: pickInstallerJava(await javaMajorForVersion(host.gameVersion)),
    args: ['-jar', installerPath, '--installServer', dir],
    cwd: dir,
    label: '安装 Forge 服务端',
  });
  const spec = findRunnableSpec({ ...host, jar: null });
  if (!spec) throw new Error('Forge 安装完成，但未找到服务端启动文件');
  return { jar: spec.jar ? path.basename(spec.jar) : null, javaMajor: await javaMajorForVersion(host.gameVersion) };
}

function neoforgePrefix(version) {
  const parts = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  if (parts[0] === 1) return `${parts[1]}.${parts[2] || 0}.`;
  return `${parts[0]}.${parts[1] || 0}.`;
}

async function installNeoForge(host, { taskId }) {
  const dir = hostDir(host.id);
  const prefix = neoforgePrefix(host.gameVersion);
  let data;
  try {
    data = await fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', {
      timeoutMs: 20000, retries: 1,
    });
  } catch (e) {
    throw new Error(`无法获取 NeoForge 版本列表（网络不可达）: ${e.message}`);
  }
  const versions = (data && Array.isArray(data.versions) ? data.versions : [])
    .filter((v) => String(v).startsWith(prefix))
    .sort((a, b) => String(b).localeCompare(String(a), undefined, { numeric: true }));
  if (!versions.length) throw new Error(`NeoForge 没有适用于 Minecraft ${host.gameVersion} 的版本`);
  const neoforgeVersion = versions[0];
  const installerPath = path.join(dir, 'neoforge-installer.jar');
  progress(taskId, host.id, { phase: 'resolve', label: `NeoForge ${neoforgeVersion}` });
  await downloadJar({
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoforgeVersion}/neoforge-${neoforgeVersion}-installer.jar`,
    dest: installerPath,
    label: `下载 NeoForge 安装器 ${neoforgeVersion}`,
    hostId: host.id,
    taskId,
  });
  progress(taskId, host.id, { phase: 'install', label: `安装 NeoForge ${neoforgeVersion}（可能需要几分钟）`, percent: 0.5 });
  await streamInstaller({
    hostId: host.id,
    taskId,
    java: pickInstallerJava(await javaMajorForVersion(host.gameVersion)),
    args: ['-jar', installerPath, '--installServer', dir],
    cwd: dir,
    label: '安装 NeoForge 服务端',
  });
  const spec = findRunnableSpec({ ...host, jar: null });
  if (!spec) throw new Error('NeoForge 安装完成，但未找到服务端启动文件');
  return { jar: spec.jar ? path.basename(spec.jar) : null, javaMajor: await javaMajorForVersion(host.gameVersion) };
}

async function installServerFiles(host, ctx) {
  switch (host.type) {
    case 'vanilla': return installVanilla(host, ctx);
    case 'paper': return installPaper(host, ctx);
    case 'purpur': return installPurpur(host, ctx);
    case 'fabric': return installFabric(host, ctx);
    case 'quilt': return installQuilt(host, ctx);
    case 'forge': return installForge(host, ctx);
    case 'neoforge': return installNeoForge(host, ctx);
    default: throw new Error(`不支持的服务器类型: ${host.type}`);
  }
}

async function writeConfigFiles(host, taskId) {
  const dir = hostDir(host.id);
  await fsp.writeFile(path.join(dir, 'eula.txt'), eulaText(host.eula !== false), 'utf8');
  const existing = await readProperties(dir);
  if (Object.keys(existing).length) {
    await writeProperties(dir, defaultProperties(host));
  } else {
    await fsp.writeFile(propertiesFile(dir), propertiesText(defaultProperties(host)), 'utf8');
  }
  progress(taskId, host.id, { phase: 'config', label: '写入配置与启动脚本', percent: 0.95 });
  await writeStartScripts(host);
}

// ---------------------------------------------------------------------------
// public API — create
// ---------------------------------------------------------------------------

/**
 * Create and install a local dedicated server. Resolves when the server jar/config
 * files are ready (may take 1-3 minutes for a ~50MB download). Progress is pushed
 * on the event bus as `{type:'progress', scope:'host', hostId, ...}`.
 */
export async function createHost(options = {}) {
  const name = String(options.name || '').trim().slice(0, 60) || '我的服务器';
  const type = String(options.type || 'vanilla').toLowerCase().trim();
  if (!SERVER_TYPES.has(type)) throw httpError(`不支持的服务器类型: ${type}`);

  let gameVersion = String(options.gameVersion || '').trim();
  const port = toInt(options.port, 25565);
  if (port < MIN_PORT || port > MAX_PORT) throw httpError(`端口需在 ${MIN_PORT}-${MAX_PORT} 之间`);
  const memoryMb = toInt(options.memoryMb, 2048);
  if (memoryMb < MIN_MEMORY || memoryMb > MAX_MEMORY) throw httpError(`内存需在 ${MIN_MEMORY}-${MAX_MEMORY} MB 之间`);
  const maxPlayers = Math.min(1000, Math.max(1, toInt(options.maxPlayers, 20)));
  const eula = options.eula !== false;
  const onlineMode = options.onlineMode !== false;
  const seed = options.seed === undefined || options.seed === null ? '' : String(options.seed).slice(0, 120);
  const motd = String(options.motd || name).slice(0, 120) || 'CraftDeck Server';

  const clash = store.hosts.find((h) => Number(h.port) === port);
  if (clash) throw httpError(`端口 ${port} 已被服务器「${clash.name}」占用，请换一个端口`);

  if (!gameVersion || /^latest$/i.test(gameVersion)) {
    const manifest = await getManifest();
    gameVersion = (manifest.latest && manifest.latest.release) || gameVersion;
    if (!gameVersion) throw httpError('无法获取最新游戏版本，请手动指定 gameVersion');
  }

  const taskId = options.taskId || uid('host_');
  const host = store.addHost({
    name,
    type,
    gameVersion,
    port,
    memoryMb,
    maxPlayers,
    motd,
    eula,
    onlineMode,
    seed,
    status: 'installing',
    dir: null,
    jar: null,
    javaMajor: 21,
  });
  const dir = hostDir(host.id);
  host.dir = dir;

  progress(taskId, host.id, { phase: 'prepare', label: `准备创建「${name}」`, done: 0, total: 1, percent: 0.02 });
  bus.emitEvent({ type: 'hosts', action: 'creating', hostId: host.id, name });

  try {
    await ensureDir(dir);
    await ensureDir(path.join(dir, 'logs'));
    const result = await installServerFiles(host, { taskId });
    const updated = store.updateHost(host.id, {
      status: 'installed',
      dir,
      jar: result.jar || null,
      javaMajor: result.javaMajor || 21,
      loaderVersion: result.loaderVersion || null,
      installedAt: Date.now(),
      error: null,
    });
    await writeConfigFiles(updated, taskId);
    progress(taskId, host.id, {
      phase: 'done', label: `「${name}」安装完成`, done: 1, total: 1, percent: 1, finished: true, ok: true,
    });
    bus.notify('success', '服务器已创建', `${name} · ${type} ${gameVersion} · 端口 ${port}`);
    bus.emitEvent({ type: 'hosts', action: 'created', hostId: host.id, name });
    return store.hosts.find((h) => h.id === host.id) || updated;
  } catch (e) {
    const message = (e && e.message) || '服务器创建失败';
    progress(taskId, host.id, { phase: 'error', label: '安装失败', finished: true, ok: false, error: message, percent: 1 });
    bus.notify('error', '服务器创建失败', message);
    bus.emitEvent({ type: 'hosts', action: 'failed', hostId: host.id, error: message });
    try { store.removeHost(host.id); } catch { /* ignore */ }
    try { await rmrf(dir); } catch { /* ignore */ }
    throw e instanceof Error ? e : new Error(message);
  }
}

// ---------------------------------------------------------------------------
// public API — process control
// ---------------------------------------------------------------------------

function runtimeStatus(host) {
  const p = procs.get(host.id);
  if (p && !p.exited) {
    return {
      status: p.status,
      pid: p.child && p.child.pid ? p.child.pid : null,
      uptimeMs: p.startedAt ? Date.now() - p.startedAt : 0,
      players: p.players || null,
      java: p.java,
    };
  }
  // Persisted running/starting state without a live process (e.g. launcher restart).
  const status = ['starting', 'running', 'stopping'].includes(host.status) ? 'stopped' : (host.status || 'installed');
  return { status, pid: null, uptimeMs: 0, players: host.lastPlayers || null, java: host.java || null };
}

export function hostStatus(id) {
  const host = store.hosts.find((h) => h.id === id);
  if (!host) throw httpError('服务器不存在或已被删除', 404);
  const rt = runtimeStatus(host);
  return {
    id: host.id,
    name: host.name,
    status: rt.status,
    pid: rt.pid,
    uptimeMs: rt.uptimeMs,
    port: host.port,
    players: rt.players || null,
    java: rt.java || host.java || null,
    memoryMb: host.memoryMb,
    gameVersion: host.gameVersion,
    type: host.type,
    running: rt.status === 'running' || rt.status === 'starting' || rt.status === 'stopping',
  };
}

/**
 * Start a host. Throws when already running, when the EULA was not accepted, or when
 * the server files are missing/incomplete.
 */
export async function startHost(id) {
  const host = requireHost(id);
  const existing = procs.get(id);
  if (existing && !existing.exited) throw httpError('服务器已在运行中', 409);

  const dir = hostDir(host.id);
  if (!fs.existsSync(dir)) throw httpError('服务器目录不存在，请重新创建', 404);

  const eula = await readText(path.join(dir, 'eula.txt'), '');
  if (!/^\s*eula\s*=\s*true\s*$/mi.test(eula)) {
    throw httpError('尚未同意 Minecraft EULA，请先将 eula.txt 中的 eula 改为 true', 400);
  }

  const spec = findRunnableSpec(host);
  if (!spec) throw httpError('未找到可用的服务端核心，请重新安装该服务器', 400);

  const java = pickHostJava(host);
  const args = launchArgList(spec, host.memoryMb);
  const logFile = path.join(dir, 'logs', 'console.log');
  await ensureDir(path.dirname(logFile));
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.on('error', () => { /* logging must never crash the launcher */ });

  let child;
  try {
    child = spawn(java, args, {
      cwd: dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  } catch (e) {
    logStream.end();
    throw new Error(`无法启动 Java 进程: ${e.message}`);
  }

  let resolveExit = null;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  const entry = {
    child,
    java,
    spec,
    startedAt: Date.now(),
    status: 'starting',
    players: null,
    lines: [],
    logStream,
    exited: false,
    stopping: false,
    killTimer: null,
    finalize: null,
    resolveExit,
    exitPromise,
  };
  procs.set(id, entry);

  store.updateHost(id, {
    status: 'starting',
    pid: child.pid || null,
    java,
    startedAt: entry.startedAt,
    exitCode: null,
    error: null,
    lastStartedAt: entry.startedAt,
  });
  hostLog(id, `[CraftDeck] ${java} ${args.join(' ')}`);
  bus.emitEvent({ type: 'host', hostId: id, status: 'starting', pid: child.pid || null });
  bus.log('info', `正在启动服务器 ${host.name}（${host.gameVersion}，端口 ${host.port}）`);

  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const appendLine = (line, stream) => {
    entry.lines.push(line);
    if (entry.lines.length > MAX_LOG_LINES) entry.lines.splice(0, entry.lines.length - MAX_LOG_LINES);
    try { logStream.write(line + '\n'); } catch { /* ignore */ }
    bus.emitEvent({ type: 'host', hostId: id, line, stream });
    handleServerLine(host, entry, line);
  };

  const onChunk = (stream) => (chunk) => {
    const text = decoders[stream].write(chunk);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      appendLine(line, stream);
    }
  };

  child.stdout.on('data', onChunk('stdout'));
  child.stderr.on('data', onChunk('stderr'));
  child.stdin.on('error', () => { /* server closed stdin; ignore EPIPE */ });

  const finalize = (code, signal) => {
    if (entry.finalized) return;
    entry.finalized = true;
    entry.exited = true;
    if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = null; }
    const wasError = entry.status === 'error';
    const status = wasError ? 'error' : 'stopped';
    entry.status = status;
    entry.exitCode = code;
    try { logStream.end(); } catch { /* ignore */ }
    try {
      store.updateHost(id, { status, exitCode: code, pid: null, stoppedAt: Date.now(), lastPlayers: entry.players || null });
    } catch { /* ignore */ }
    bus.emitEvent({ type: 'host', hostId: id, status, exitCode: code, signal: signal || null });
    bus.log('info', `${host.name} 已停止（退出码 ${code}）`);
    if (entry.resolveExit) entry.resolveExit({ code, signal, status });
    procs.delete(id);
  };

  entry.finalize = finalize;
  child.on('error', (e) => {
    entry.status = 'error';
    entry.error = e.message;
    hostLog(id, `[CraftDeck] 进程错误: ${e.message}`);
    try { store.updateHost(id, { status: 'error', error: e.message }); } catch { /* ignore */ }
    bus.emitEvent({ type: 'host', hostId: id, status: 'error', error: e.message });
    bus.notify('error', `${host.name} 启动失败`, e.message);
    if (entry.finalized) return;
    entry.finalized = true;
    entry.exited = true;
    if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = null; }
    try { logStream.end(); } catch { /* ignore */ }
    if (entry.resolveExit) entry.resolveExit({ code: null, signal: null, status: 'error' });
    procs.delete(id);
  });
  child.on('exit', (code, signal) => finalize(code, signal));
  child.on('close', (code) => { if (!entry.finalized) finalize(code, null); });

  return { ok: true, ...hostStatus(id) };
}

function handleServerLine(host, entry, line) {
  const done = /Done \(([\d.,]+)s\)! For help/.exec(line);
  if (done) {
    entry.status = 'running';
    try {
      store.updateHost(host.id, { status: 'running', pid: entry.child.pid || null, startedAt: entry.startedAt });
    } catch { /* ignore */ }
    bus.emitEvent({ type: 'host', hostId: host.id, status: 'running', uptimeMs: 0 });
    bus.notify('success', '服务器已就绪', `${host.name} · 端口 ${host.port} · 用时 ${done[1]}s`);
    bus.log('info', `服务器 ${host.name} 已就绪（${done[1]}s）`);
    return;
  }
  const players = /There are (\d+) of a max of (\d+) players online/.exec(line);
  if (players) {
    entry.players = { online: Number(players[1]) || 0, max: Number(players[2]) || 0 };
    try { store.updateHost(host.id, { lastPlayers: entry.players }); } catch { /* ignore */ }
    bus.emitEvent({ type: 'host', hostId: host.id, players: entry.players });
    return;
  }
  if (/Stopping (the )?server/.test(line)) {
    entry.status = 'stopping';
    try { store.updateHost(host.id, { status: 'stopping' }); } catch { /* ignore */ }
    bus.emitEvent({ type: 'host', hostId: host.id, status: 'stopping' });
    return;
  }
  if (/You need to agree to the EULA|Failed to load eula|You must agree to the EULA/i.test(line)) {
    entry.status = 'error';
    entry.error = '需要同意 Minecraft EULA';
    try { store.updateHost(host.id, { status: 'error', error: entry.error }); } catch { /* ignore */ }
    bus.notify('error', '服务器需要同意 EULA', '请将 eula.txt 中的 eula 改为 true 后重新启动');
  }
}

/** Graceful stop: `stop` on stdin, then force-kill after 15s. */
export async function stopHost(id) {
  const host = requireHost(id);
  const p = procs.get(id);
  if (!p || p.exited) {
    if (['running', 'starting', 'stopping'].includes(host.status)) {
      try { store.updateHost(id, { status: 'stopped', pid: null, stoppedAt: Date.now() }); } catch { /* ignore */ }
    }
    return { ok: true, alreadyStopped: true, ...hostStatus(id) };
  }
  if (p.stopping) return { ok: true, stopping: true, ...hostStatus(id) };

  p.stopping = true;
  p.status = 'stopping';
  try { store.updateHost(id, { status: 'stopping' }); } catch { /* ignore */ }
  try {
    p.child.stdin.write('stop\n');
    hostLog(id, '[CraftDeck] > stop');
  } catch { /* stdin may already be closed */ }

  p.killTimer = setTimeout(() => {
    try { p.child.kill(); } catch { /* ignore */ }
    hostLog(id, '[CraftDeck] 服务器未在 15 秒内退出，已强制结束进程');
    bus.log('warn', `${host.name} 未在 15 秒内退出，已强制结束`);
  }, 15000);
  if (typeof p.killTimer.unref === 'function') p.killTimer.unref();

  await Promise.race([p.exitPromise, sleep(16000)]);
  return { ok: true, ...hostStatus(id) };
}

/** Stop (if needed) and delete the server directory. */
export async function deleteHost(id) {
  const host = requireHost(id);
  try { await stopHost(id); } catch { /* still delete */ }

  const p = procs.get(id);
  if (p && !p.exited) {
    try { p.child.kill(); } catch { /* ignore */ }
    await sleep(400);
  }

  const dir = path.resolve(SERVERS_DIR, safeId(host.id));
  const root = path.resolve(SERVERS_DIR);
  if (dir === root || !dir.startsWith(root + path.sep)) {
    throw new Error('拒绝删除：目标路径不在服务器目录内');
  }

  procs.delete(id);
  store.removeHost(id);
  await rmrf(dir);
  bus.emitEvent({ type: 'hosts', action: 'removed', hostId: id });
  bus.log('info', `已删除服务器 ${host.name}`);
  return { ok: true, id };
}

/** Write a command to the server console (stdin). */
export function sendHostCommand(id, command) {
  const host = requireHost(id);
  const p = procs.get(id);
  if (!p || p.exited) throw httpError('服务器未在运行', 400);
  const text = String(command || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw httpError('命令不能为空', 400);
  try {
    p.child.stdin.write(text + '\n');
  } catch (e) {
    throw new Error(`写入服务器控制台失败: ${e.message}`);
  }
  bus.emitEvent({ type: 'host', hostId: id, line: `> ${text}`, stream: 'stdin' });
  return { ok: true, host: host.name };
}

/** Read the tail of logs/console.log (falls back to the in-memory ring buffer). */
export async function hostLogs(id, tail = 200) {
  const host = requireHost(id);
  const n = Math.min(Math.max(toInt(tail, 200), 1), 2000);
  const dir = hostDir(host.id);
  let lines = await tailFile(path.join(dir, 'logs', 'console.log'), n);
  const p = procs.get(id);
  if (!lines.length && p) lines = p.lines.slice(-n);
  return {
    id: host.id,
    name: host.name,
    status: runtimeStatus(host).status,
    lines,
    text: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function publicHost(host) {
  const rt = runtimeStatus(host);
  const out = { ...host };
  delete out.pid;
  return {
    ...out,
    status: rt.status,
    pid: rt.pid,
    uptimeMs: rt.uptimeMs,
    players: rt.players,
    running: rt.status === 'running' || rt.status === 'starting' || rt.status === 'stopping',
  };
}

function findHostOr404(id) {
  const host = store.hosts.find((h) => h.id === id);
  if (!host) throw httpError('服务器不存在或已被删除', 404);
  return host;
}

export function register(router, ctx = {}) {
  // Literal routes before parameterised ones.
  router.get('/api/hosts', () => store.hosts.map(publicHost));

  router.post('/api/hosts', async (req, res, c) => {
    const body = await c.body();
    const host = await createHost(body);
    return publicHost(host);
  });

  router.get('/api/java', () => {
    try {
      return findJavas();
    } catch (e) {
      bus.log('warn', '扫描 Java 失败: ' + e.message);
      return [];
    }
  });

  router.delete('/api/hosts/:id', async (req, res, c) => {
    const host = findHostOr404(c.params.id);
    return deleteHost(host.id);
  });

  router.post('/api/hosts/:id/start', async (req, res, c) => {
    const host = findHostOr404(c.params.id);
    const result = await startHost(host.id);
    return { ok: true, ...result, host: publicHost(findHostOr404(host.id)) };
  });

  router.post('/api/hosts/:id/stop', async (req, res, c) => {
    const host = findHostOr404(c.params.id);
    const result = await stopHost(host.id);
    return { ok: true, ...result, host: publicHost(findHostOr404(host.id)) };
  });

  router.get('/api/hosts/:id/logs', async (req, res, c) => {
    const host = findHostOr404(c.params.id);
    return hostLogs(host.id, c.query.tail);
  });

  router.get('/api/hosts/:id/properties', async (req, res, c) => {
    const host = findHostOr404(c.params.id);
    const properties = await readProperties(hostDir(host.id));
    return { id: host.id, properties };
  });

  router.put('/api/hosts/:id/properties', async (req, res, c) => {
    const host = findHostOr404(c.params.id);
    const body = await c.body();
    const source = body && typeof body.properties === 'object' && body.properties !== null ? body.properties : body;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw httpError('请求体需为 { properties: { ... } }', 400);
    }
    const patch = {};
    for (const [key, value] of Object.entries(source)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) throw httpError(`属性名无效: ${key}`, 400);
      if (value !== null && typeof value === 'object') throw httpError(`属性值无效: ${key}`, 400);
      patch[key] = propValue(value);
    }
    if (!Object.keys(patch).length) throw httpError('没有需要保存的属性', 400);

    const dir = hostDir(host.id);
    if (!fs.existsSync(propertiesFile(dir))) {
      await fsp.writeFile(propertiesFile(dir), propertiesText(defaultProperties(host)), 'utf8');
    }
    await writeProperties(dir, patch);
    const properties = await readProperties(dir);
    const rt = runtimeStatus(host);
    bus.emitEvent({ type: 'hosts', action: 'properties', hostId: host.id });
    return {
      ok: true,
      id: host.id,
      properties,
      restartRequired: rt.status === 'running' || rt.status === 'starting',
    };
  });

  router.post('/api/hosts/:id/command', async (req, res, c) => {
    const host = findHostOr404(c.params.id);
    const body = await c.body();
    return sendHostCommand(host.id, body && body.command);
  });
}

export default {
  createHost, startHost, stopHost, deleteHost, hostStatus, hostLogs, sendHostCommand, register,
};
