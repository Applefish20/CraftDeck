/**
 * 在线皮肤库：LittleSkin 公开皮肤库（Blessing Skin）。
 * 只读取公开皮肤，下载后保存到本地账户；不修改 LittleSkin 上的任何内容。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../core/paths.mjs';
import { ensureDir } from '../core/util.mjs';
import { bus } from '../core/events.mjs';
import { store } from '../core/store.mjs';
import { applySkinBuffer, safeAccount } from './skins.mjs';

const BASE = 'https://littleskin.cn';
const CACHE_DIR = path.join(ROOT, 'cache', 'skinlib');
const MAX = 4 * 1024 * 1024;
const infoCache = new Map(); // tid -> { hash, type, name, at }
const listCache = new Map(); // key -> { data, at }
const TTL = 30 * 60 * 1000;

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CraftDeck/3.6.1 (+https://littleskin.cn)',
    },
  });
  if (!res.ok) throw new Error(`LittleSkin HTTP ${res.status}`);
  return res.json();
}

async function infoOf(tid) {
  const hit = infoCache.get(String(tid));
  if (hit && Date.now() - hit.at < TTL) return hit;
  const data = await getJson(`${BASE}/skinlib/info/${encodeURIComponent(tid)}`);
  if (!data || !data.hash) throw new Error('皮肤信息缺少 hash');
  const row = { tid: data.tid, name: data.name, type: data.type === 'alex' ? 'alex' : 'steve', hash: data.hash, likes: data.likes || 0, at: Date.now() };
  infoCache.set(String(tid), row);
  return row;
}

async function listPage(page, sort, type, keyword = '') {
  const key = `${page}|${sort}|${type}|${keyword}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const q = new URLSearchParams({ page: String(page) });
  if (sort === 'likes') q.set('sort', 'likes');
  if (['steve', 'alex', 'hd'].includes(type)) q.set('filter', type);
  if (keyword) q.set('keyword', keyword);
  const data = await getJson(`${BASE}/skinlib/list?${q.toString()}`);
  const rows = Array.isArray(data.data) ? data.data : [];
  // 并发补齐 hash；失败的单条跳过，不影响整页。
  const out = [];
  for (let i = 0; i < rows.length; i += 6) {
    const batch = rows.slice(i, i + 6);
    const got = await Promise.all(batch.map(async (r) => {
      try { return { ...r, ...(await infoOf(r.tid)) }; } catch { return null; }
    }));
    for (const x of got) if (x && x.hash) out.push(x);
  }
  const payload = {
    page,
    hasMore: rows.length >= 20,
    items: out.map((x) => ({
      tid: x.tid, name: x.name || '未命名皮肤', type: x.type, model: x.type === 'alex' ? 'slim' : 'classic',
      likes: x.likes || 0, nickname: x.nickname || '', hash: x.hash,
      image: `/api/skins/library/image?hash=${x.hash}`,
    })),
  };
  listCache.set(key, { data: payload, at: Date.now() });
  return payload;
}

async function cachedTexture(hash) {
  if (!/^[a-f0-9]{64}$/i.test(String(hash))) throw new Error('皮肤 hash 不合法');
  await ensureDir(CACHE_DIR);
  const file = path.join(CACHE_DIR, `${hash}.png`);
  try {
    const st = await fsp.stat(file);
    if (st.size > 100) return fsp.readFile(file);
  } catch { /* download */ }
  const res = await fetch(`${BASE}/textures/${hash}`, { headers: { 'User-Agent': 'CraftDeck/3.6.1' } });
  if (!res.ok) throw new Error(`下载皮肤失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX) throw new Error('皮肤文件超过 4MB');
  if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('皮肤站返回的不是 PNG');
  await fsp.writeFile(file, buf);
  return buf;
}

export function register(router) {
  router.get('/api/skins/library', async (req, res, ctx) => {
    const page = Math.max(1, Math.min(200, Number(ctx.query.page) || 1));
    const sort = ctx.query.sort === 'likes' ? 'likes' : 'latest';
    const type = ['steve', 'alex', 'hd'].includes(ctx.query.type) ? ctx.query.type : '';
    const keyword = String(ctx.query.q || ctx.query.keyword || '').trim().slice(0, 40);
    const data = await listPage(page, sort, type, keyword);
    return { ...data, source: 'LittleSkin', sourceUrl: 'https://littleskin.cn/skinlib' };
  });

  router.get('/api/skins/library/image', async (req, res, ctx) => {
    const buf = await cachedTexture(ctx.query.hash);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
    return undefined;
  });

  router.post('/api/skins/library/apply', async (req, res, ctx) => {
    const b = await ctx.body();
    const account = store.getAccount(b.accountId);
    if (!account) throw new Error('请先在账户页添加账户');
    const info = await infoOf(b.tid);
    const buf = await cachedTexture(info.hash);
    const updated = await applySkinBuffer(account, buf, info.type === 'alex' ? 'slim' : 'classic', 'littleSkin');
    bus.notify('success', '已应用在线皮肤', `${info.name} · LittleSkin`);
    return { ok: true, account: safeAccount(updated), skin: { tid: info.tid, name: info.name, model: info.type } };
  });
}
