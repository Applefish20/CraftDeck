/**
 * 皮肤：本地上传 / 网络导入 / 按正版用户名下载 / 应用到微软正版账号。
 * 本地皮肤保存在 ROOT/skins/<uuid>.png，通过 /api/accounts/:id/skin 提供给界面。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../core/paths.mjs';
import { ensureDir, safeId, uid, readJsonSync, writeJsonSync } from '../core/util.mjs';
import { bus } from '../core/events.mjs';
import { store } from '../core/store.mjs';
import { ensureValid, fetchProfile } from './accounts.mjs';
import { instanceGameDir } from '../core/paths.mjs';

const SKIN_DIR = path.join(ROOT, 'skins');
const LIBRARY_DIR = path.join(SKIN_DIR, 'library');
const LIBRARY_FILE = path.join(SKIN_DIR, 'library.json');
const MAX = 4 * 1024 * 1024;

const PRESETS = [
  { id: 'steve', name: 'Steve', model: 'classic', url: '/assets/skins/steve.png' },
  { id: 'alex', name: 'Alex', model: 'slim', url: '/assets/skins/alex.png' },
  { id: 'ninja', name: '忍者', model: 'classic', url: '/assets/skins/ninja.png' },
  { id: 'robot', name: '机器人', model: 'classic', url: '/assets/skins/robot.png' },
  { id: 'pink', name: '粉色少女', model: 'slim', url: '/assets/skins/pink.png' },
  { id: 'green', name: '绿色冒险者', model: 'classic', url: '/assets/skins/green.png' },
];

function pngInfo(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function validateSkin(buf) {
  const info = pngInfo(buf);
  if (!info) throw new Error('不是有效的 PNG 图片');
  if (buf.length > MAX) throw new Error('皮肤文件不能超过 4MB');
  if (info.width !== 64 || ![64, 32].includes(info.height)) {
    const okHd = info.width === 128 && [128, 64].includes(info.height);
    if (!okHd) throw new Error(`皮肤尺寸应为 64x64、64x32 或 128x128，当前为 ${info.width}x${info.height}`);
  }
  return info;
}

/** 对外返回时绝不含账号令牌。 */
export function safeAccount(a) {
  if (!a) return null;
  return {
    id: a.id, type: a.type, username: a.username, uuid: a.uuid,
    skinModel: a.skinModel, skinSource: a.skinSource || null, hasSkin: !!a.skin,
  };
}

async function saveLocal(account, buf, source = 'upload') {
  validateSkin(buf);
  await ensureDir(SKIN_DIR);
  const file = path.join(SKIN_DIR, `${safeId(account.uuid || account.id)}.png`);
  await fsp.writeFile(file, buf);
  const updated = store.updateAccount(account.id, {
    skin: `/api/accounts/${account.id}/skin?t=${Date.now()}`,
    skinSource: source,
    skinUpdatedAt: Date.now(),
  });
  bus.emitEvent({ type: 'skin', accountId: account.id, source });
  return updated;
}

export function skinFileFor(account) {
  return path.join(SKIN_DIR, `${safeId(account.uuid || account.id)}.png`);
}

async function uploadToMojang(account, buf, model) {
  const acc = await ensureValid(account);
  if (acc.type !== 'microsoft') throw new Error('只有正版（微软）账户可以上传到 Mojang');
  const form = new FormData();
  form.append('variant', model === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + acc.accessToken },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mojang 拒绝上传（HTTP ${res.status}）${text.slice(0, 160)}`);
  }
}

async function fetchUrlBuffer(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 图片地址');
  const res = await fetch(url, { headers: { 'User-Agent': 'CraftDeck/1.0' } });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX) throw new Error('图片超过 4MB');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX) throw new Error('图片超过 4MB');
  return buf;
}

async function fetchMojangSkin(username) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('正版用户名格式不正确');
  const u = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (!u.ok) throw new Error('找不到这个正版用户名（或该玩家从未购买 Java 版）');
  const profile = await u.json();
  const p = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`);
  if (!p.ok) throw new Error('无法读取该玩家的皮肤信息');
  const data = await p.json();
  const prop = (data.properties || []).find((x) => x.name === 'textures');
  if (!prop) throw new Error('该玩家没有公开皮肤');
  const textures = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
  const skin = textures.textures?.SKIN;
  if (!skin?.url) throw new Error('该玩家没有公开皮肤');
  return { buf: await fetchUrlBuffer(skin.url), model: skin.metadata?.model === 'slim' ? 'slim' : 'classic', name: data.name || name };
}

/** 给在线皮肤库复用：保存并设置模型。 */
export async function applySkinBuffer(account, buf, model = 'classic', source = 'library') {
  const updated = await saveLocal(account, buf, source);
  store.updateAccount(account.id, { skinModel: model === 'slim' ? 'slim' : 'classic' });
  return updated;
}

function readLibrary() {
  const list = readJsonSync(LIBRARY_FILE, []);
  return Array.isArray(list) ? list.filter((x) => x && x.id && x.file) : [];
}

function writeLibrary(list) {
  ensureDir(LIBRARY_DIR);
  writeJsonSync(LIBRARY_FILE, list);
}

export function register(router) {
  router.get('/api/skins/gallery', async () => ({ presets: PRESETS, note: '内置示例皮肤，可直接点击应用' }));

  router.get('/api/skins/mine', async () => ({
    items: readLibrary().map((x) => ({ ...x, image: `/api/skins/mine/${x.id}/image?t=${x.createdAt || 0}` })),
  }));

  router.get('/api/skins/mine/:id/image', async (req, res, ctx) => {
    const item = readLibrary().find((x) => x.id === ctx.params.id);
    if (!item) { res.writeHead(404); res.end(); return undefined; }
    try {
      const buf = await fsp.readFile(path.join(LIBRARY_DIR, item.file));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
      return undefined;
    } catch {
      res.writeHead(404); res.end(); return undefined;
    }
  });

  /** 把当前第三方 / 正版账户的皮肤加入「我的」。 */
  router.post('/api/skins/mine/import-account', async (req, res, ctx) => {
    const body = await ctx.body();
    const acc = store.getAccount(String(body.accountId || ''));
    if (!acc) throw new Error('账户不存在');
    let buf = null;
    try { buf = await fsp.readFile(skinFileFor(acc)); } catch { /* remote */ }
    if (!buf) {
      const profile = await fetchProfile(acc);
      if (!profile?.skinUrl) throw new Error('该账户没有可用皮肤');
      const r = await fetch(profile.skinUrl, { headers: { 'User-Agent': 'CraftDeck/3.6.1' } });
      if (!r.ok) throw new Error(`下载皮肤失败：HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    }
    validateSkin(buf);
    await ensureDir(LIBRARY_DIR);
    const id = uid('skin_');
    const file = `${id}.png`;
    await fsp.writeFile(path.join(LIBRARY_DIR, file), buf);
    const item = { id, name: `${acc.username || '账户'} 的皮肤`, model: acc.skinModel === 'slim' ? 'slim' : 'classic', file, createdAt: Date.now() };
    const list = readLibrary();
    list.unshift(item);
    writeLibrary(list.slice(0, 200));
    return { ok: true, item: { ...item, image: `/api/skins/mine/${id}/image?t=${item.createdAt}` } };
  });

  router.post('/api/skins/mine', async (req, res, ctx) => {
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > MAX) throw new Error('皮肤文件不能超过 4MB');
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    validateSkin(buf);
    await ensureDir(LIBRARY_DIR);
    const id = uid('skin_');
    const rawName = decodeURIComponent(String(req.headers['x-filename'] || '我的皮肤.png'));
    const name = rawName.replace(/\.png$/i, '').slice(0, 40) || '我的皮肤';
    const model = String(req.headers['x-model'] || 'classic') === 'slim' ? 'slim' : 'classic';
    const file = `${id}.png`;
    await fsp.writeFile(path.join(LIBRARY_DIR, file), buf);
    const item = { id, name, model, file, createdAt: Date.now() };
    const list = readLibrary();
    list.unshift(item);
    writeLibrary(list.slice(0, 200));
    return { ok: true, item: { ...item, image: `/api/skins/mine/${id}/image?t=${item.createdAt}` } };
  });

  router.post('/api/skins/mine/:id/apply', async (req, res, ctx) => {
    const b = await ctx.body();
    const item = readLibrary().find((x) => x.id === ctx.params.id);
    if (!item) throw new Error('皮肤不存在');
    const account = store.getAccount(b.accountId);
    if (!account) throw new Error('请先选择账户');
    const buf = await fsp.readFile(path.join(LIBRARY_DIR, item.file));
    const updated = await applySkinBuffer(account, buf, item.model, 'mine');
    return { ok: true, account: safeAccount(updated) };
  });

  router.delete('/api/skins/mine/:id', async (req, res, ctx) => {
    const list = readLibrary();
    const item = list.find((x) => x.id === ctx.params.id);
    if (!item) throw new Error('皮肤不存在');
    await fsp.rm(path.join(LIBRARY_DIR, item.file), { force: true });
    writeLibrary(list.filter((x) => x.id !== item.id));
    return { ok: true };
  });

  // 离线 / 第三方本地皮肤：供 CustomSkinLoader 的本地 CustomSkinAPI 使用。
  router.get('/api/csl/:username', async (req, res, ctx) => {
    const name = decodeURIComponent(String(ctx.params.username || '')).replace(/\.json$/i, '');
    const acc = [...store.state.accounts].reverse().find((a) => String(a.username).toLowerCase() === name.toLowerCase());
    if (!acc) { res.writeHead(404); res.end(); return; }
    let has = false;
    try { await fsp.access(skinFileFor(acc)); has = true; } catch { /* none */ }
    if (!has) { res.writeHead(404); res.end(); return; }
    const port = Number(global.__CRAFTDECK_PORT__ || process.env.MCL_PORT || 0);
    const origin = `http://127.0.0.1:${port}`;
    return {
      username: acc.username,
      textures: {
        SKIN: {
          url: `${origin}/api/skins/local/${encodeURIComponent(acc.id)}.png`,
          metadata: { model: acc.skinModel === 'slim' ? 'slim' : 'classic' },
        },
      },
    };
  });

  router.get('/api/skins/local/:id', async (req, res, ctx) => {
    const id = decodeURIComponent(String(ctx.params.id || '')).replace(/\.png$/i, '');
    const acc = store.getAccount(id);
    if (!acc) { res.writeHead(404); res.end(); return; }
    try {
      const buf = await fsp.readFile(skinFileFor(acc));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch { res.writeHead(404); res.end(); }
  });

  /** 为实例写入 CustomSkinLoader 本地皮肤配置。 */
  router.post('/api/instances/:instanceId/skins/patch', async (req, res, ctx) => {
    if (!ctx.instance) throw new Error('实例不存在');
    const port = Number(global.__CRAFTDECK_PORT__ || process.env.MCL_PORT || 0);
    if (!port) throw new Error('本地服务端口尚未就绪');
    const dir = path.join(instanceGameDir(ctx.instance.id), 'CustomSkinLoader');
    await ensureDir(dir);
    const cfg = {
      enable: true,
      loadlist: [
        { name: 'CraftDeckLocal', type: 'CustomSkinAPI', root: `http://127.0.0.1:${port}/api/csl/` },
        { name: 'LittleSkin', type: 'CustomSkinAPI', root: 'https://littleskin.cn/csl/' },
      ],
    };
    await fsp.writeFile(path.join(dir, 'CustomSkinLoader.json'), JSON.stringify(cfg, null, 2), 'utf8');
    return { ok: true, dir, port };
  });

  router.post('/api/skins/upload', async (req, res, ctx) => {
    const accountId = String(req.headers['x-account-id'] || '');
    const model = String(req.headers['x-model'] || 'classic');
    const account = store.getAccount(accountId);
    if (!account) throw new Error('账户不存在');
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > MAX) throw new Error('皮肤文件不能超过 4MB');
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    validateSkin(buf);
    const updated = await saveLocal(account, buf, 'upload');
    store.updateAccount(account.id, { skinModel: model === 'slim' ? 'slim' : 'classic' });
    let mojang = null;
    if (account.type === 'microsoft') {
      try { await uploadToMojang(account, buf, model); mojang = 'ok'; }
      catch (e) { mojang = e.message; }
    }
    return { ok: true, account: safeAccount(updated), mojang };
  });

  router.post('/api/skins/from-url', async (req, res, ctx) => {
    const b = await ctx.body();
    const account = store.getAccount(b.accountId);
    if (!account) throw new Error('账户不存在');
    const buf = await fetchUrlBuffer(b.url);
    validateSkin(buf);
    const updated = await saveLocal(account, buf, 'url');
    store.updateAccount(account.id, { skinModel: b.model === 'slim' ? 'slim' : 'classic' });
    let mojang = null;
    if (account.type === 'microsoft' && b.applyToMojang) {
      try { await uploadToMojang(account, buf, b.model); mojang = 'ok'; }
      catch (e) { mojang = e.message; }
    }
    return { ok: true, account: safeAccount(updated), mojang };
  });

  router.post('/api/skins/from-mojang', async (req, res, ctx) => {
    const b = await ctx.body();
    const account = store.getAccount(b.accountId);
    if (!account) throw new Error('账户不存在');
    const got = await fetchMojangSkin(b.username);
    const updated = await saveLocal(account, got.buf, 'mojang');
    store.updateAccount(account.id, { skinModel: got.model });
    return { ok: true, account: safeAccount(updated), username: got.name };
  });

  router.post('/api/skins/apply-mojang', async (req, res, ctx) => {
    const b = await ctx.body();
    const account = store.getAccount(b.accountId);
    if (!account) throw new Error('账户不存在');
    const buf = await fsp.readFile(skinFileFor(account)).catch(() => null);
    if (!buf) throw new Error('请先上传或下载一个皮肤');
    await uploadToMojang(account, buf, b.model || account.skinModel);
    return { ok: true };
  });

  router.delete('/api/skins/:accountId', async (req, res, ctx) => {
    const account = store.getAccount(ctx.params.accountId);
    if (!account) throw new Error('账户不存在');
    await fsp.rm(skinFileFor(account), { force: true });
    store.updateAccount(account.id, { skin: null, skinSource: null });
    return { ok: true };
  });
}
