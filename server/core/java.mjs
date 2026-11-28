/**
 * CraftDeck — Java discovery & selection (core).
 *
 * Zero third-party dependencies. Imported by the launcher engine (launcher.mjs,
 * versions.mjs) and by the HTTP feature layer (hosts.mjs → GET /api/java), so it
 * must stay free of feature imports: only node builtins + core paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, APP_ROOT } from './paths.mjs';

const IS_WIN = process.platform === 'win32';
const JAVA_EXE = IS_WIN ? 'java.exe' : 'java';
const CACHE_TTL_MS = 60_000;
const JAVA_INFO_TIMEOUT_MS = 8_000;
const MAX_CANDIDATES = 16;

/** @type {{ at: number, list: Array<object> }} */
const cache = { at: 0, list: [] };

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function addCandidate(list, p) {
  if (!p) return;
  const norm = path.normalize(p);
  if (!list.includes(norm)) list.push(norm);
}

function addJavaHomeBin(list, home) {
  if (!home) return;
  addCandidate(list, path.join(home, 'bin', JAVA_EXE));
}

/** Every plausible `java` executable, most-likely first (stat-cheap filtering happens later). */
function collectCandidates() {
  const out = [];

  // 0) 完整版随包附带的 Java（resources/app/runtime 或安装目录/runtime）。
  for (const base of [path.join(APP_ROOT, 'runtime'), path.resolve(APP_ROOT, '..', '..', 'runtime')]) {
    for (const name of ['jre25', 'jre21', 'jre17', 'jre8']) addJavaHomeBin(out, path.join(base, name));
  }

  // 1) PATH — entries contain java.exe itself, not a JAVA_HOME.
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const clean = dir.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
    if (clean) addCandidate(out, path.join(clean, JAVA_EXE));
  }

  // 2) JAVA_HOME (and JDK_HOME used by some installers).
  addJavaHomeBin(out, process.env.JAVA_HOME);
  addJavaHomeBin(out, process.env.JDK_HOME);

  // 3) Well-known vendor installation roots.
  if (IS_WIN) {
    const bases = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Semeru',
      'C:\\Program Files\\RedHat',
      'C:\\Program Files\\AdoptOpenJDK',
      'C:\\Program Files\\JetBrains\\Runtime',
      'C:\\Program Files (x86)\\Java',
    ];
    for (const base of bases) {
      for (const d of readdirSafe(base)) {
        addJavaHomeBin(out, path.join(base, d.name));
      }
    }
  } else if (process.platform === 'darwin') {
    const bases = [
      '/Library/Java/JavaVirtualMachines',
      path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'),
    ];
    for (const base of bases) {
      for (const d of readdirSafe(base)) addJavaHomeBin(out, path.join(base, d.name, 'Contents', 'Home'));
    }
  } else {
    for (const base of ['/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk']) {
      for (const d of readdirSafe(base)) addJavaHomeBin(out, path.join(base, d.name));
    }
  }

  // 4) IntelliJ-managed JDKs.
  for (const d of readdirSafe(path.join(os.homedir(), '.jdks'))) {
    addJavaHomeBin(out, path.join(os.homedir(), '.jdks', d.name));
  }

  // 5) Runtimes managed by this launcher (ROOT/runtimes/<name>/bin/java.exe and
  //    ROOT/runtimes/<vendor>/<jdk>/bin/java.exe).
  const runtimes = path.join(ROOT, 'runtimes');
  for (const d of readdirSafe(runtimes)) {
    const home = path.join(runtimes, d.name);
    addJavaHomeBin(out, home);
    for (const sub of readdirSafe(home)) addJavaHomeBin(out, path.join(home, sub.name));
  }

  // Resolve through symlinks/junctions and de-duplicate, keeping the first spelling.
  const seen = new Set();
  const result = [];
  for (const p of out) {
    if (!isExecutableFile(p)) continue;
    let key = p.toLowerCase();
    try {
      key = fs.realpathSync.native(p).toLowerCase();
    } catch { /* keep normalized path */ }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

function readProperty(text, name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^[ \\t]*${safe}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

/**
 * Capture a child's combined output through a temp file instead of anonymous pipes.
 * Used only when the host policy forbids creating pipes (EPERM/EACCES), which
 * otherwise makes every probe fail even though java itself runs fine.
 */
function captureToFile(cmd, args, timeoutMs) {
  let dir = null;
  let fd = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdeck-java-'));
    const file = path.join(dir, 'out.txt');
    fd = fs.openSync(file, 'w+');
    const res = spawnSync(cmd, args, { stdio: ['ignore', fd, fd], timeout: timeoutMs, windowsHide: true });
    fs.closeSync(fd);
    fd = null;
    if (!res || res.error) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * Ask one java executable about itself.
 * Runs `java -XshowSettings:properties -version` (properties are printed on stderr)
 * with a hard 8s timeout. Returns null when the executable is unusable.
 *
 * @param {string} javaPath
 * @returns {{path:string, version:string, major:number, vendor:string, arch:string, bits:number, javaHome:string}|null}
 */
export function javaInfo(javaPath) {
  if (!javaPath) return null;
  const args = ['-XshowSettings:properties', '-version'];
  let text = null;
  let res;
  try {
    res = spawnSync(javaPath, args, {
      encoding: 'utf8',
      timeout: JAVA_INFO_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    res = null;
  }
  if (res && !res.error) {
    text = `${res.stderr || ''}\n${res.stdout || ''}`;
  } else if (res && res.error && /EPERM|EACCES|UNKNOWN/i.test(String(res.error.code))) {
    // Pipe-restricted environment: retry with file-backed stdio.
    text = captureToFile(javaPath, args, JAVA_INFO_TIMEOUT_MS);
  }
  if (!text) return null;
  const version = readProperty(text, 'java.version') || readProperty(text, 'java.runtime.version');
  if (!version) return null;
  const arch = readProperty(text, 'os.arch') || 'unknown';
  return {
    path: javaPath,
    version,
    major: javaMajor(version),
    vendor: readProperty(text, 'java.vendor') || readProperty(text, 'java.vm.vendor') || 'Unknown',
    arch,
    bits: /64/i.test(arch) ? 64 : 32,
    javaHome: readProperty(text, 'java.home') || '',
  };
}

/**
 * "1.8.0_392" → 8, "17.0.2" → 17, "21" → 21, "21-ea" → 21, "25.0.0.1" → 25.
 * Unknown input → 0.
 */
export function javaMajor(versionString) {
  if (versionString === null || versionString === undefined) return 0;
  const s = String(versionString).trim().replace(/^java(\s+version)?\s+/i, '').replace(/^v/i, '');
  const m = /^(\d+)(?:[._](\d+))?/.exec(s);
  if (!m) return 0;
  const first = parseInt(m[1], 10);
  if (!Number.isFinite(first)) return 0;
  if (first === 1) return parseInt(m[2], 10) || 0; // legacy 1.x scheme
  return first;
}

/** Prefer real JDK paths over Oracle `javapath` shims when both point at one install. */
function pathRank(p) {
  const lower = p.toLowerCase();
  let score = 0;
  if (lower.includes('javapath')) score += 10;
  if (lower.includes('common files')) score += 5;
  return score;
}

/**
 * All usable Java installations, newest major first, cached for 60s.
 * De-duplicates by the runtime's own `java.home` so shims and junctions collapse
 * onto one entry.
 *
 * @param {{force?:boolean}} [opts]
 * @returns {Array<{path:string, version:string, major:number, vendor:string, arch:string, bits:number}>}
 */
export function findJavas(opts = {}) {
  const now = Date.now();
  if (!opts.force && cache.list.length && now - cache.at < CACHE_TTL_MS) return cache.list;

  const byHome = new Map();
  for (const candidate of collectCandidates()) {
    const info = javaInfo(candidate);
    if (!info || !info.major) continue;
    const key = (info.javaHome || info.path).toLowerCase();
    const prev = byHome.get(key);
    if (!prev || pathRank(info.path) < pathRank(prev.path)) byHome.set(key, info);
  }

  const list = [...byHome.values()].sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
  cache.at = now;
  cache.list = list;
  return list;
}

/** Drop the discovery cache (e.g. after a runtime finished downloading). */
export function invalidateJavaCache() {
  cache.at = 0;
  cache.list = [];
}

function listAll() {
  try {
    return findJavas();
  } catch {
    return [];
  }
}

function chooseBest(list, major, preferred) {
  if (!list.length) return null;
  const is64 = (j) => j.bits === 64 || /64|arm64|aarch64/i.test(String(j.arch));
  const prefKey = preferred ? preferred.toLowerCase() : null;
  if (prefKey) {
    const hit = list.find((j) => j.path.toLowerCase() === prefKey);
    if (hit && hit.major >= major) return hit;
  }
  const exact = list.filter((j) => j.major === major)
    .sort((a, b) => Number(is64(b)) - Number(is64(a)));
  if (exact.length) return exact[0];
  const higher = list.filter((j) => j.major > major)
    .sort((a, b) => a.major - b.major || Number(is64(b)) - Number(is64(a)));
  if (higher.length) return higher[0];
  const any64 = list.filter(is64);
  if (any64.length) return any64[0];
  return list[0];
}

/**
 * Pick the best Java for a required major version.
 * Order: explicit `preferred` → exact major → smallest major above the requirement
 * → any 64-bit → the highest installed → literal "java" from PATH.
 *
 * @param {{major?:number, preferred?:string}} [opts]
 * @returns {string}
 */
export function pickJava(opts = {}) {
  const major = Number(opts.major) > 0 ? Number(opts.major) : 21;
  const preferred = opts.preferred && opts.preferred !== 'auto' ? String(opts.preferred) : '';

  if (preferred) {
    const direct = isExecutableFile(preferred) ? javaInfo(preferred) : null;
    if (direct && direct.major >= major) return direct.path;
    const better = chooseBest(listAll(), major, null);
    if (better) return better.path;
    if (direct) return direct.path;
  }

  const best = chooseBest(listAll(), major, preferred || null);
  return best ? best.path : 'java';
}

/**
 * Minimum Java major required by a Mojang version JSON.
 * `javaVersion.majorVersion` when present, otherwise 8 (the classic default).
 *
 * @param {object|null|undefined} versionJson
 * @returns {number}
 */
export function requiredJavaFor(versionJson) {
  const major = Number(versionJson && versionJson.javaVersion && versionJson.javaVersion.majorVersion);
  return Number.isFinite(major) && major > 0 ? major : 8;
}
