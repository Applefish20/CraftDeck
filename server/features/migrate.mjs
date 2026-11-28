/**
 * 从 PCL / HMCL / 官方启动器一键迁移版本与实例内容。
 * 只读取其他启动器的 .minecraft 目录，复制到本启动器实例，不修改源目录。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { INSTANCES_DIR, instanceGameDir } from '../core/paths.mjs';
import { ensureDir, exists } from '../core/util.mjs';
import { store } from '../core/store.mjs';

const MAX_VERSIONS = 200;
const CONTENT_ITEMS = ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'saves', 'scripts', 'kubejs', 'options.txt', 'servers.dat', 'CustomSkinLoader', 'xaero', 'XaeroWaypoints', 'journeymap', 'tacz'];

function autoRoots() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const roots = [
    path.join(appdata, '.minecraft'),
    path.join(home, '.minecraft'),
    path.join(home, 'Desktop', '.minecraft'),
    path.join(home, 'Documents', '.minecraft'),
    'D:\\.minecraft', 'E:\\.minecraft', 'F:\\.minecraft',
  ];
  return [...new Set(roots.map((p) => path.resolve(p)))];
}

async function readJson(file) {
  try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

async function readSetupIni(versionDir) {
  const out = {};
  try {
    const text = await fsp.readFile(path.join(versionDir, 'PCL', 'Setup.ini'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* not a PCL version */ }
  return out;
}

function loaderOf(json) {
  const text = `${json.id || ''} ${json.mainClass || ''} ${(json.libraries || []).map((l) => l.name || '').join(' ')}`.toLowerCase();
  if (text.includes('neoforge')) return 'neoforge';
  if (text.includes('fabric')) return 'fabric';
  if (text.includes('quilt')) return 'quilt';
  if (text.includes('forge')) return 'forge';
  return 'vanilla';
}

/** 从 PCL / HMCL 的版本 ID 或 Maven 依赖中提取加载器版本。 */
function loaderVersionOf(json, loader) {
  const text = `${json.id || ''} ${(json.libraries || []).map((l) => l.name || '').join(' ')}`;
  const patterns = {
    fabric: [/fabric-loader[:\s-]+([0-9][\w.+-]*)/i, /fabric[\s_-]+([0-9][\w.+-]*)/i],
    quilt: [/quilt-loader[:\s-]+([0-9][\w.+-]*)/i, /quilt[\s_-]+([0-9][\w.+-]*)/i],
    forge: [/forge[:\s_-]+(?:[0-9.]+[-_])?([0-9][\w.+-]*)/i],
    neoforge: [/neoforge[:\s_-]+([0-9][\w.+-]*)/i],
  };
  for (const re of patterns[loader] || []) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

async function baseVersionOf(json, versionsDir, depth = 0) {
  if (!json || depth > 6) return json?.id || null;
  if (!json.inheritsFrom) return json.id || null;
  const parentFile = path.join(versionsDir, json.inheritsFrom, `${json.inheritsFrom}.json`);
  const parent = await readJson(parentFile);
  return parent ? baseVersionOf(parent, versionsDir, depth + 1) : json.inheritsFrom;
}

async function countMods(dir) {
  try {
    const entries = await fsp.readdir(dir);
    return entries.filter((n) => /\.jar(\.disabled)?$/i.test(n)).length;
  } catch { return 0; }
}

async function scanRoot(root) {
  const versionsDir = path.join(root, 'versions');
  let dirs = [];
  try { dirs = await fsp.readdir(versionsDir, { withFileTypes: true }); } catch { return null; }
  const versions = [];
  for (const d of dirs.slice(0, MAX_VERSIONS)) {
    if (!d.isDirectory()) continue;
    const versionDir = path.join(versionsDir, d.name);
    let jsonFile = path.join(versionDir, `${d.name}.json`);
    let json = await readJson(jsonFile);
    if (!json) {
      try {
        const files = await fsp.readdir(versionDir);
        const candidate = files.find((f) => f.toLowerCase().endsWith('.json'));
        if (candidate) { jsonFile = path.join(versionDir, candidate); json = await readJson(jsonFile); }
      } catch { /* ignore */ }
    }
    if (!json) continue;
    const id = json.id || d.name;
    const setup = await readSetupIni(versionDir);
    const baseVersion = json.clientVersion || setup.VersionVanillaName || await baseVersionOf(json, versionsDir);
    const loader = loaderOf(json);
    const loaderVersion = setup.VersionFabric || setup.VersionForge || setup.VersionNeoForge || setup.VersionQuilt || loaderVersionOf(json, loader);
    // 版本隔离目录优先；否则使用 .minecraft 根目录。
    let sourceDir = root;
    for (const item of CONTENT_ITEMS) {
      if (await exists(path.join(versionDir, item))) { sourceDir = versionDir; break; }
    }
    const mods = await countMods(path.join(sourceDir, 'mods'));
    let mtime = 0;
    try { mtime = (await fsp.stat(versionDir)).mtimeMs; } catch { /* ignore */ }
    versions.push({
      id, name: id, baseVersion: baseVersion || id, loader, loaderVersion,
      versionDir, sourceDir, mods, mtime,
      isolated: sourceDir === versionDir,
      hasFabric: await exists(path.join(sourceDir, 'fabric.mod.json')),
    });
  }
  if (!versions.length) return null;
  versions.sort((a, b) => b.mtime - a.mtime);
  const hmcl = await exists(path.join(root, '.hmcl.json'));
  const pcl = await exists(path.join(root, 'PCL.ini'));
  return {
    root,
    label: hmcl ? 'HMCL / 第三方启动器' : pcl ? 'PCL' : 'Minecraft 目录',
    versions,
  };
}

export function register(router) {
  router.get('/api/migrate/scan', async (req, res, ctx) => {
    const roots = [];
    const manual = String(ctx.query.path || '').trim();
    if (manual) roots.push(path.resolve(manual));
    else roots.push(...autoRoots());
    const seen = new Set();
    const found = [];
    for (const root of roots) {
      if (seen.has(root.toLowerCase())) continue;
      seen.add(root.toLowerCase());
      try {
        const data = await scanRoot(root);
        if (data) found.push(data);
      } catch { /* skip */ }
    }
    return { roots: found, scanned: roots, manual: !!manual };
  });

  router.post('/api/migrate/import', async (req, res, ctx) => {
    const b = await ctx.body();
    const inst = store.instances.find((i) => i.id === b.instanceId);
    if (!inst) throw new Error('实例不存在，请先创建实例');
    const root = path.resolve(String(b.root || ''));
    let sourceDir = path.resolve(String(b.sourceDir || root));
    if (!sourceDir.startsWith(root)) throw new Error('源目录不合法');
    const destRoot = instanceGameDir(inst.id);
    await ensureDir(destRoot);
    const copied = [];
    let files = 0;
    for (const item of CONTENT_ITEMS) {
      const candidates = [path.join(sourceDir, item), path.join(root, item)];
      let src = null;
      for (const c of candidates) { if (await exists(c)) { src = c; break; } }
      if (!src) continue;
      const dest = path.join(destRoot, item);
      const st = await fsp.stat(src);
      if (st.isDirectory()) {
        await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
        try { files += (await fsp.readdir(src, { recursive: true })).length; } catch { /* ignore */ }
      } else {
        await ensureDir(path.dirname(dest));
        if (!(await exists(dest))) await fsp.copyFile(src, dest);
        files += 1;
      }
      copied.push(item);
    }
    return { ok: true, instanceId: inst.id, copied, files, sourceDir };
  });
}
