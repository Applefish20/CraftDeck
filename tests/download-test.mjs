/**
 * 多线程（分段 Range）下载验证：
 *   node tests/download-test.mjs
 * 下载 1.21.1 客户端 jar（约 25MB），分别用 1 线程和 4 线程下载并校验 SHA1。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

process.env.MCL_ROOT = path.join(os.tmpdir(), 'craftdeck-dl-test-' + process.pid);
const { downloadFile, setDefaultThreads } = await import('../server/core/downloader.mjs');
const { fetchJson } = await import('../server/core/downloader.mjs');

const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
const entry = manifest.versions.find((v) => v.id === '1.21.1');
const version = await fetchJson(entry.url);
const client = version.downloads.client;
const dir = path.resolve('.dl-test');
fs.mkdirSync(dir, { recursive: true });
const single = path.join(dir, 'single.jar');
const multi = path.join(dir, 'multi.jar');
for (const f of [single, multi]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

async function time(label, fn) {
  const t = Date.now();
  const r = await fn();
  const ms = Date.now() - t;
  const sha1 = crypto.createHash('sha1').update(fs.readFileSync(r.path)).digest('hex');
  const ok = sha1 === client.sha1;
  console.log(`${label}: ${(r.bytes / 1048576).toFixed(1)}MB in ${(ms / 1000).toFixed(1)}s = ${(r.bytes / 1048576 / (ms / 1000)).toFixed(2)}MB/s, sha1 ${ok ? 'OK' : 'MISMATCH'}, threaded=${!!r.threaded}`);
  return { ok, ms, r };
}

setDefaultThreads(1);
const a = await time('1 线程', () => downloadFile(client.url, single, { size: client.size, sha1: client.sha1, source: 'official' }));
setDefaultThreads(4);
const b = await time('4 线程', () => downloadFile(client.url, multi, { size: client.size, sha1: client.sha1, source: 'official', threads: 4 }));
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
if (!a.ok || !b.ok) { console.error('校验失败'); process.exit(1); }
console.log(`完成：4 线程相对单线程 ${a.ms > b.ms ? '快' : '慢'} ${(Math.abs(a.ms - b.ms) / 1000).toFixed(1)}s`);
