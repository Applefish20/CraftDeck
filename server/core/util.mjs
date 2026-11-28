import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

export function existsSync(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

export function writeJsonSync(file, data) {
  ensureDirSync(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export async function readText(file, fallback = '') {
  try { return await fsp.readFile(file, 'utf8'); } catch { return fallback; }
}

export function sizeOf(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

export async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

export function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/** UUID v3-style (like Minecraft offline UUID): md5 of "OfflinePlayer:<name>" with version bits set. */
export function offlineUuid(name) {
  const h = md5(Buffer.from('OfflinePlayer:' + name, 'utf8'));
  const b = Buffer.from(h, 'hex');
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function uuidFromHash(hashHex) {
  const b = Buffer.from(hashHex.slice(0, 32), 'hex');
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
}

export function safeId(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function detectJavaHome() {
  const cands = [];
  if (process.env.JAVA_HOME) cands.push(process.env.JAVA_HOME);
  if (isWin) {
    for (const base of [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Amazon Corretto',
    ]) {
      try {
        for (const d of fs.readdirSync(base)) cands.push(path.join(base, d));
      } catch { /* ignore */ }
    }
  } else if (isMac) {
    cands.push('/Library/Java/JavaVirtualMachines');
  } else {
    for (const b of ['/usr/lib/jvm', '/usr/java']) {
      try { for (const d of fs.readdirSync(b)) cands.push(path.join(b, d)); } catch { /* ignore */ }
    }
  }
  return cands;
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function hostOsName() {
  return isWin ? 'windows' : isMac ? 'osx' : 'linux';
}

export function hostArch() {
  return os.arch();
}

/** Convert a Mojang "1.20.1" style version to a protocol-ish numeric for ordering if needed. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function jsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
    });
    req.on('error', reject);
  });
}
