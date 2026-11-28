import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ensureDir, exists, sleep } from './util.mjs';
import { ASSETS_DIR, LIBRARIES_DIR } from './paths.mjs';

const UA = 'CraftDeck/1.0 (Minecraft Launcher; +https://github.com/craftdeck)';

/** Connection count used for multi-range downloads when a caller does not override it. */
let defaultThreads = 1;
export function setDefaultThreads(n) {
  defaultThreads = Math.max(1, Math.min(16, Number(n) || 1));
}

/** Hosts that a mirror may proxy. Anything else (Modrinth CDN, GitHub...) is never rewritten. */
const MIRRORABLE = /^https?:\/\/(piston-meta\.mojang\.com|piston-data\.mojang\.com|launchermeta\.mojang\.com|launcher\.mojang\.com|resources\.download\.minecraft\.net|libraries\.minecraft\.net|files\.minecraftforge\.net|maven\.minecraftforge\.net|meta\.fabricmc\.net|meta\.quiltmc\.org|maven\.neoforged\.net)/i;

const REWRITERS = [
  [/^https?:\/\/piston-meta\.mojang\.com\/v1\/packages\/([0-9a-f]{40})\/([^/]+)\.json$/i, 'https://bmclapi2.bangbang93.com/version/$2/json'],
  [/^https?:\/\/launchermeta\.mojang\.com\/v1\/packages\/([0-9a-f]{40})\/([^/]+)\.json$/i, 'https://bmclapi2.bangbang93.com/version/$2/json'],
  [/^https?:\/\/resources\.download\.minecraft\.net\/(.*)$/, 'https://bmclapi2.bangbang93.com/assets/$1'],
  [/^https?:\/\/libraries\.minecraft\.net\/(.*)$/, 'https://bmclapi2.bangbang93.com/maven/$1'],
  [/^https?:\/\/files\.minecraftforge\.net\/(.*)$/, 'https://bmclapi2.bangbang93.com/forge/$1'],
  [/^https?:\/\/maven\.minecraftforge\.net\/(.*)$/, 'https://bmclapi2.bangbang93.com/maven/$1'],
  [/^https?:\/\/meta\.fabricmc\.net\/(.*)$/, 'https://bmclapi2.bangbang93.com/fabric-meta/$1'],
];

export function mirrorUrl(url, source = 'auto') {
  if (source === 'official' || source === 'offline') return url;
  if (!MIRRORABLE.test(url)) return url;
  for (const [re, rep] of REWRITERS) {
    if (re.test(url)) return url.replace(re, rep);
  }
  return url;
}

export function mavenPathFor(name) {
  // net.fabricmc:fabric-loader:0.16.9 -> net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar
  const [group, artifact, version] = String(name).split(':');
  if (!group || !artifact || !version) return null;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
}

/** Candidate local paths for a Maven library name (used to skip downloads when a mod loader redeclares libs). */
export function libraryLocalPath(name) {
  const p = mavenPathFor(name);
  return p ? path.join(LIBRARIES_DIR, p) : null;
}

export function assetObjectPath(hash) {
  return path.join(ASSETS_DIR, 'objects', hash.slice(0, 2), hash);
}

/** Verify file hash without loading it fully in memory. Returns true if the file exists with that sha1. */
export async function verifySha1(file, sha1) {
  if (!sha1) {
    try {
      const st = await fsp.stat(file);
      return st.isFile() && st.size > 0;
    } catch { return false; }
  }
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size === 0) return false;
    return await new Promise((resolve) => {
      const h = crypto.createHash('sha1');
      const s = fs.createReadStream(file);
      s.on('data', (d) => h.update(d));
      s.on('end', () => resolve(h.digest('hex') === sha1));
      s.on('error', () => resolve(false));
    });
  } catch {
    return false;
  }
}

async function rangedDownload(url, dest, {
  size, sha1, threads, onProgress = null, signal = null, headers = {},
} = {}) {
  if (!size || size < 4 * 1024 * 1024 || threads < 2) return null;
  const chunk = Math.ceil(size / threads);
  const parts = [];
  let received = 0;
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!onProgress) return;
    if (force || now - lastEmit > 150) {
      lastEmit = now;
      onProgress({ received, total: size, threaded: true });
    }
  };
  try {
    await Promise.all(Array.from({ length: threads }, async (_, i) => {
      const start = i * chunk;
      const end = Math.min(size - 1, (i + 1) * chunk - 1);
      if (start > end) return;
      const part = `${dest}.part-${i}-${Date.now()}`;
      parts[i] = part;
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: '*/*', Range: `bytes=${start}-${end}`, ...headers },
          signal: ctrl.signal,
          redirect: 'follow',
        });
        if (res.status !== 206) throw new Error('server does not support byte ranges');
        const out = fs.createWriteStream(part);
        let got = 0;
        try {
          for await (const c of res.body) {
            got += c.length;
            received += c.length;
            if (!out.write(c)) await new Promise((r) => out.once('drain', r));
            emit();
          }
        } finally {
          await new Promise((r) => out.end(r));
        }
        const expected = end - start + 1;
        if (got !== expected) throw new Error(`range ${i} size mismatch: ${got} != ${expected}`);
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }));

    const tmp = `${dest}.merge-${Date.now()}`;
    const out = fs.createWriteStream(tmp);
    try {
      for (const part of parts) {
        if (!part) continue;
        await pipeline(fs.createReadStream(part), out, { end: false });
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (sha1 && !(await verifySha1(tmp, sha1))) {
      await fsp.rm(tmp, { force: true });
      return null;
    }
    await fsp.rename(tmp, dest);
    emit(true);
    return { path: dest, bytes: size, cached: false, sha1, threaded: true };
  } catch {
    return null;
  } finally {
    for (const part of parts) {
      try { await fsp.rm(part, { force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * Download one file atomically.
 * @returns {Promise<{path:string, bytes:number, cached:boolean, sha1:string}>}
 */
export async function downloadFile(url, dest, opts = {}) {
  const {
    sha1 = null, size = 0, source = 'auto', retries = 3, timeoutMs = 60000,
    onProgress = null, signal = null, mirrorUrl: explicitMirror = null, threads = defaultThreads,
  } = opts;

  if (sha1 && (await verifySha1(dest, sha1))) {
    const st = await fsp.stat(dest);
    onProgress && onProgress({ received: st.size, total: st.size, cached: true });
    return { path: dest, bytes: st.size, cached: true, sha1 };
  }
  await ensureDir(path.dirname(dest));

  let lastErr = null;
  const candidates = [];
  if (explicitMirror && source !== 'official') candidates.push(explicitMirror);
  candidates.push(mirrorUrl(url, source));
  if (source === 'auto' && candidates[candidates.length - 1] !== url) candidates.push(url);
  if (source !== 'auto' && source !== 'official' && !candidates.includes(url)) candidates.push(url);
  if (!candidates.length) candidates.push(url);

  const threadCount = Math.max(1, Math.min(16, Number(threads) || 1));
  if (threadCount > 1 && Number(size) >= 4 * 1024 * 1024) {
    for (const candidate of candidates.slice(0, 2)) {
      const r = await rangedDownload(candidate, dest, { size: Number(size), sha1, threads: threadCount, onProgress, signal });
      if (r) return r;
      if (signal && signal.aborted) throw new Error('已取消');
    }
    // Fall through to the single-stream implementation.
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    const target = candidates[Math.min(attempt, candidates.length - 1)];
    const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let res;
      try {
        res = await fetch(target, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctrl.signal, redirect: 'follow' });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        // Some mirrors answer 200 with an HTML error page; verify will catch that.
        throw new Error(`HTTP ${res.status} ${res.statusText} (${target})`);
      }
      const total = Number(res.headers.get('content-length')) || size || 0;
      let received = 0;
      const hash = sha1 ? crypto.createHash('sha1') : null;
      const out = fs.createWriteStream(tmp);
      try {
        for await (const chunk of res.body) {
          if (signal && signal.aborted) throw new Error('已取消');
          received += chunk.length;
          if (hash) hash.update(chunk);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          onProgress && onProgress({ received, total });
        }
      } finally {
        await new Promise((resolve) => out.end(resolve));
      }
      if (size && received !== size) throw new Error(`大小不符: ${received} != ${size}`);
      const got = hash ? hash.digest('hex') : null;
      if (sha1 && got !== sha1) throw new Error(`校验失败: ${got} != ${sha1}`);
      await fsp.rename(tmp, dest);
      if (signal) signal.removeEventListener('abort', onAbort);
      return { path: dest, bytes: received, cached: false, sha1: got };
    } catch (e) {
      lastErr = e;
      try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
      if (signal && signal.aborted) throw new Error('已取消');
      if (attempt < retries - 1) await sleep(600 * (attempt + 1));
    }
  }
  throw new Error(`下载失败 ${path.basename(dest)}: ${lastErr && lastErr.message}`);
}

/**
 * Download many files with bounded concurrency and aggregated byte progress.
 * tasks: [{url, dest, sha1, size}]
 */
export async function downloadBatch(tasks, opts = {}) {
  const { concurrency = 8, onProgress = null, label = '', signal = null, source = 'auto', retries = 3, threads = defaultThreads } = opts;
  const totalBytes = tasks.reduce((a, t) => a + (t.size || 0), 0);
  let doneBytes = 0;
  let done = 0;
  let failed = 0;
  let current = '';
  let lastEmit = 0;
  const errors = [];
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    onProgress && onProgress({
      done, total: tasks.length, bytes: doneBytes, totalBytes, failed,
      percent: tasks.length ? done / tasks.length : 1, current,
    });
  };
  emit(true);

  let idx = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      if (signal && signal.aborted) return;
      const t = tasks[i];
      current = t.name || path.basename(t.dest || '');
      emit(true);
      t.__last = 0;
      try {
        const r = await downloadFile(t.url, t.dest, {
          sha1: t.sha1, size: t.size, source: t.source || source, label, signal, retries,
          mirrorUrl: t.mirrorUrl || null, threads: t.threads || threads,
          onProgress: (p) => {
            const prev = t.__last || 0;
            t.__last = p.received;
            doneBytes += Math.max(0, p.received - prev);
            emit();
          },
        });
        if (r.cached) {
          // 缓存命中时没有 onProgress 回调，这里只补一次进度，不能重复加 size。
          doneBytes += Math.max(0, (t.size || 0) - (t.__last || 0));
        }
        done++;
        current = t.name || path.basename(t.dest || '');
        emit(true);
      } catch (e) {
        failed++;
        errors.push({ url: t.url, error: e.message, kind: t.kind || 'file', optional: !!t.optional });
        done++;
        emit();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, worker));
  emit();
  return { total: tasks.length, done, failed, errors };
}

/** Fetch JSON with retries + timeout. */
export async function fetchJson(url, opts = {}) {
  const { timeoutMs = 30000, retries = 2, headers = {}, method = 'GET', body = undefined, source = 'auto' } = opts;
  const candidates = [mirrorUrl(url, source)];
  if (source === 'auto' && candidates[0] !== url) candidates.push(url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const target = candidates[Math.min(attempt, candidates.length - 1)];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(target, {
          method, body,
          headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
          signal: ctrl.signal, redirect: 'follow',
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)} (${target})`);
        }
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function fetchText(url, opts = {}) {
  const j = await fetchJson(url, opts).catch(() => null);
  return j;
}

/** Stream a remote file into a string (used for XML metadata). */
export async function fetchRaw(url, opts = {}) {
  const { timeoutMs = 30000, source = 'auto' } = opts;
  const target = mirrorUrl(url, source);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${target})`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
