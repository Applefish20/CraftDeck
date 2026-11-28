/**
 * 构建 Windows 桌面版（免安装绿色版）：
 *   node scripts/build-app.mjs [--electron-zip dist/electron.zip] [--out dist/CraftDeck-win32-x64]
 * 需要先准备 Electron 发行包（electron-v38.0.0-win32-x64.zip），脚本会解压并把本项目放入 resources/app。
 * 输出：dist/CraftDeck-win32-x64/CraftDeck.exe
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const electronZip = path.resolve(ROOT, argOf('--electron-zip', 'dist/electron.zip'));
const outDir = path.resolve(ROOT, argOf('--out', 'dist/CraftDeck-win32-x64'));

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function extractZip(buf, target) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let files = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const comp = buf.subarray(start, start + compSize);
    const dest = path.join(target, name);
    if (!dest.startsWith(target + path.sep) && dest !== target) continue;
    if (name.endsWith('/')) { fs.mkdirSync(dest, { recursive: true }); continue; }
    const data = method === 0 ? comp : zlib.inflateRawSync(comp);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    files++;
  }
  return files;
}

async function copyDir(src, dest) {
  await fsp.cp(src, dest, { recursive: true });
}

async function main() {
  if (!(await fsp.stat(electronZip).catch(() => null))) {
    throw new Error(`找不到 Electron 发行包: ${electronZip}`);
  }
  console.log('解压 Electron…');
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
  const files = extractZip(await fsp.readFile(electronZip), outDir);
  console.log('  ' + files + ' 个文件');

  const appDir = path.join(outDir, 'resources', 'app');
  await fsp.mkdir(appDir, { recursive: true });
  console.log('复制启动器文件…');
  await copyDir(path.join(ROOT, 'server'), path.join(appDir, 'server'));
  await copyDir(path.join(ROOT, 'web'), path.join(appDir, 'web'));
  await fsp.copyFile(path.join(ROOT, 'desktop.mjs'), path.join(appDir, 'desktop.mjs'));
  await fsp.copyFile(path.join(ROOT, 'preload.cjs'), path.join(appDir, 'preload.cjs'));
  await fsp.copyFile(path.join(ROOT, 'icon.ico'), path.join(appDir, 'icon.ico')).catch(() => {});
  await fsp.writeFile(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'craftdeck',
    productName: 'CraftDeck',
    version: '3.6.1',
    private: true,
    type: 'module',
    main: 'desktop.mjs',
    description: 'CraftDeck · 我的世界启动器',
  }, null, 2));

  // Drop Electron's default app bundle and rename the executable.
  await fsp.rm(path.join(outDir, 'resources', 'default_app.asar'), { force: true }).catch(() => {});
  const electronExe = path.join(outDir, 'electron.exe');
  const appExe = path.join(outDir, 'CraftDeck.exe');
  if (await fsp.stat(electronExe).catch(() => null)) await fsp.rename(electronExe, appExe);
  else if (!(await fsp.stat(appExe).catch(() => null))) throw new Error('Electron 发行包中找不到 electron.exe');

  await fsp.writeFile(path.join(outDir, '启动 CraftDeck.bat'),
    '@echo off\r\ncd /d "%~dp0"\r\nstart "" "CraftDeck.exe"\r\n', 'utf8');

  console.log('桌面版就绪。');
  const size = (await copyDirSize(outDir));
  console.log(`完成: ${appExe}`);
  console.log(`目录大小: ${(size / 1048576).toFixed(1)} MB`);
}

async function copyDirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await fsp.stat(p)).size;
    }
  };
  await walk(dir);
  return total;
}

main().catch((e) => { console.error('构建失败:', e.message); process.exit(1); });
