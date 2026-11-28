/**
 * 已安装模组信息：读取 jar 内的 fabric/quilt/forge/neoforge 元数据和图标。
 * 只读实例 mods 目录，用于实例「Mod 管理」的图标与详情。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { instanceGameDir } from '../core/paths.mjs';
import { ensureDir } from '../core/util.mjs';
import { readZipEntries } from './modrinth.mjs';

const cache = new Map();

function pickIcon(meta) {
  if (!meta) return null;
  if (typeof meta.icon === 'string') return meta.icon;
  if (meta.icon && typeof meta.icon === 'object') {
    return meta.icon['1x'] || meta.icon['2x'] || Object.values(meta.icon)[0] || null;
  }
  if (meta.logoFile) return meta.logoFile;
  return null;
}

function parseToml(text) {
  const get = (k) => {
    const m = new RegExp(`^\\s*${k}\\s*=\\s*["']([^"']*)["']`, 'm').exec(text);
    return m ? m[1] : '';
  };
  const author = get('authors') || get('author');
  return {
    id: get('modId'),
    name: get('displayName') || get('modId'),
    version: get('version'),
    description: get('description'),
    authors: author ? [author] : [],
    logoFile: get('logoFile'),
  };
}

async function readMeta(jar) {
  let st;
  try { st = await fsp.stat(jar); } catch { return null; }
  const key = `${jar}:${st.mtimeMs}:${st.size}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const entries = await readZipEntries(jar, (name) => /^(fabric\.mod\.json|quilt\.mod\.json|META-INF\/(neoforge\.)?mods\.toml|META-INF\/MANIFEST\.MF)$/i.test(name));
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    let meta = null;
    if (byName['fabric.mod.json']) {
      const j = JSON.parse(byName['fabric.mod.json'].data.toString('utf8'));
      meta = { loader: 'fabric', id: j.id, name: j.name || j.id, version: j.version, description: typeof j.description === 'string' ? j.description : '', authors: Array.isArray(j.authors) ? j.authors.map((a) => (typeof a === 'string' ? a : a.name)) : [], icon: j.icon };
    } else if (byName['quilt.mod.json']) {
      const q = JSON.parse(byName['quilt.mod.json'].data.toString('utf8'))?.quilt_loader || {};
      meta = { loader: 'quilt', id: q.id, name: q.metadata?.name || q.id, version: q.version, description: q.metadata?.description || '', authors: [], icon: q.metadata?.icon };
    } else {
      const tomlName = byName['META-INF/neoforge.mods.toml'] ? 'META-INF/neoforge.mods.toml' : byName['META-INF/mods.toml'] ? 'META-INF/mods.toml' : null;
      if (tomlName) meta = { loader: tomlName.includes('neoforge') ? 'neoforge' : 'forge', ...parseToml(byName[tomlName].data.toString('utf8')) };
      else if (byName['META-INF/MANIFEST.MF']) {
        const text = byName['META-INF/MANIFEST.MF'].data.toString('utf8');
        const get = (k) => (new RegExp(`^${k}:\\s*(.+)$`, 'mi').exec(text) || [])[1] || '';
        meta = { loader: 'unknown', id: '', name: get('Implementation-Title') || path.basename(jar, '.jar'), version: get('Implementation-Version'), description: '', authors: [] , icon: null };
      }
    }
    const out = { meta, iconPath: pickIcon(meta) };
    cache.set(key, out);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return out;
  } catch {
    return { meta: null, iconPath: null };
  }
}

function safeName(name) {
  return path.basename(String(name || ''));
}

export function register(router) {
  router.get('/api/instances/:instanceId/installed-mods', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const dir = path.join(instanceGameDir(ctx.instance.id), 'mods');
    await ensureDir(dir);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { names = []; }
    const files = names.filter((n) => /\.jar(\.disabled)?$/i.test(n));
    const out = [];
    for (const name of files) {
      const result = await readMeta(path.join(dir, name));
      const st = await fsp.stat(path.join(dir, name)).catch(() => null);
      out.push({
        name,
        size: st?.size || 0,
        disabled: /\.disabled$/i.test(name),
        meta: result.meta,
        icon: result.iconPath ? `/api/instances/${ctx.instance.id}/modicon?name=${encodeURIComponent(name)}&p=${encodeURIComponent(result.iconPath)}` : null,
      });
    }
    return { files: out };
  });

  router.get('/api/instances/:instanceId/modicon', async (req, res, ctx) => {
    if (!ctx.instance) throw Object.assign(new Error('实例不存在'), { status: 404 });
    const name = safeName(ctx.query?.name);
    const iconPath = String(ctx.query?.p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || !iconPath || iconPath.includes('..')) { res.writeHead(404); res.end(); return undefined; }
    const jar = path.join(instanceGameDir(ctx.instance.id), 'mods', name);
    try {
      const entries = await readZipEntries(jar, (n) => n === iconPath);
      const entry = entries[0];
      if (!entry) { res.writeHead(404); res.end(); return undefined; }
      const ext = path.extname(iconPath).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
      res.end(entry.data);
      return undefined;
    } catch {
      res.writeHead(404); res.end(); return undefined;
    }
  });
}
