/**
 * Minecraft 中文资讯。
 * 使用「我的世界中文站」的公开 WordPress 接口，避免在启动页展示英文新闻。
 * 只做异步读取与缓存；失败时返回空列表，不阻塞启动器。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR } from '../core/paths.mjs';
import { ensureDir } from '../core/util.mjs';

const FEED = 'https://www.minecraftzw.com/wp-json/wp/v2/posts?categories=305&per_page=6&_embed=1';
const TTL = 15 * 60 * 1000;
let cache = null;

function strip(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchMcmodPacks() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://www.mcmod.cn/modpack/', {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 CraftDeck/3.6.1', 'Accept-Language': 'zh-CN' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    for (const block of html.split('<div class="modlist-block">').slice(1)) {
      if (out.length >= 3) break;
      const id = /href="\/modpack\/(\d+)\.html"/.exec(block)?.[1];
      const name = strip(/class="name">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1]);
      const intro = strip(/class="intro-content">[\s\S]*?<span>([\s\S]*?)<\/span>/.exec(block)?.[1]);
      const img = /<img[^>]+(?:data-original|src)="([^"]+)"/.exec(block)?.[1] || '';
      if (!id || !name) continue;
      out.push({
        id: `mcmod-${id}`,
        title: name,
        text: intro || 'MC百科整合包推荐',
        date: 'MC百科',
        category: '整合包推荐',
        image: img.startsWith('//') ? `https:${img}` : img,
        url: `https://www.mcmod.cn/modpack/${id}.html`,
      });
    }
    return out;
  } catch { return []; } finally { clearTimeout(timer); }
}

async function fetchNews() {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(FEED, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 CraftDeck/3.6.1',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const entries = (Array.isArray(raw) ? raw : []).slice(0, 8).map((e) => {
      const media = e._embedded?.['wp:featuredmedia']?.[0];
      return {
        id: e.id,
        title: strip(e.title?.rendered),
        text: strip(e.excerpt?.rendered).slice(0, 180),
        date: e.date ? String(e.date).slice(0, 10) : '',
        category: '中文资讯',
        image: media?.media_details?.sizes?.medium?.source_url || media?.source_url || '',
        url: e.link || '',
      };
    }).filter((x) => x.title && x.url && !/APP下载|服务器租用|广告/i.test(x.title)).slice(0, 3);
    const packs = await fetchMcmodPacks();
    const data = { entries: [...entries, ...packs], source: '我的世界中文站 · MC百科' };
    cache = { at: Date.now(), data };
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function register(router) {
  router.get('/api/news', async () => {
    try {
      return await fetchNews();
    } catch (e) {
      return { entries: [], error: e.message, source: '我的世界中文站' };
    }
  });

  // 图片代理：部分站点会校验 Referer，直接在 <img> 里加载会被拒绝。
  router.get('/api/news/image', async (req, res, ctx) => {
    const raw = String(ctx.query.url || '');
    let u;
    try { u = new URL(raw); } catch { res.writeHead(400); res.end('bad image url'); return; }
    const host = u.hostname.toLowerCase();
    const allowed = host === 'i.mcmod.cn' || host.endsWith('.mcmod.cn') || host.endsWith('minecraftzw.com') || host === 'launchercontent.mojang.com';
    if (u.protocol !== 'https:' || !allowed) { res.writeHead(403); res.end('image host not allowed'); return; }
    const key = crypto.createHash('sha256').update(raw).digest('hex');
    const dir = path.join(CACHE_DIR, 'news');
    const file = path.join(dir, key);
    try {
      const buf = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
      return;
    } catch { /* fetch */ }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(raw, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 CraftDeck/3.6.1',
          Referer: `${u.origin}/`,
          Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
        },
      });
      clearTimeout(timer);
      if (!r.ok) { res.writeHead(502); res.end('image fetch failed'); return; }
      const type = String(r.headers.get('content-type') || 'image/webp');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) { res.writeHead(413); res.end('image too large'); return; }
      await ensureDir(dir);
      await fs.writeFile(file, buf).catch(() => {});
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch {
      res.writeHead(502);
      res.end('image fetch failed');
    }
  });
}
