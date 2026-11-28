/**
 * 第三方资源站内容聚合。
 * 仅读取站点公开 WordPress REST API 的搜索结果；不绕过登录、验证码或付费墙。
 */
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

const WP_SOURCES = {
  resourcepack: { base: 'https://resourcepack.net', name: 'ResourcePack.net' },
  shadersmods: { base: 'https://shadersmods.com', name: 'ShadersMods' },
  mczw: { base: 'https://www.minecraftzw.com', name: '我的世界中文站' },
};

const EXTERNAL = {
  minecraftmaps: { url: 'https://www.minecraftmaps.com/?s=', name: 'Minecraft Maps' },
  mcimg: { url: 'https://www.mcimg.com/', name: '投影工坊 MCIMG' },
  planet: { url: 'https://www.planetminecraft.com/projects/?keywords=', name: 'Planet Minecraft' },
  curseforge: { url: 'https://www.curseforge.com/minecraft/search?search=', name: 'CurseForge' },
};

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

function extractDownloads(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = String(m[1] || '').replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    const label = strip(m[2]) || '下载';
    const low = url.toLowerCase();
    if (!/\.(zip|mcworld|litematic|schematic|7z|rar)(\?|#|$)/i.test(low) && !/mediafire|mega\.nz|curseforge|modrinth|download/i.test(low)) continue;
    if (/\/(wp-content|feed|comment|category|tag)\//i.test(low)) continue;
    seen.add(url);
    out.push({ url, label: label.slice(0, 60), direct: /\.(zip|mcworld|litematic|schematic|7z|rar)(\?|#|$)/i.test(low) });
    if (out.length >= 5) break;
  }
  return out;
}

async function searchWp(source, q, page) {
  const cfg = WP_SOURCES[source];
  if (!cfg) return null;
  const url = `${cfg.base}/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=12&page=${Math.max(1, page)}&_embed=1&_fields=id,date,link,title,excerpt,content,_embedded`;
  const key = `${source}|${q}|${page}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return { source, name: cfg.name, items: [], total: 0, error: `HTTP ${res.status}`, external: false };
    const arr = await res.json();
    const items = (Array.isArray(arr) ? arr : []).map((p) => {
      const media = p._embedded?.['wp:featuredmedia']?.[0];
      const content = p.content?.rendered || '';
      return {
        id: p.id,
        title: strip(p.title?.rendered),
        url: p.link,
        image: media?.media_details?.sizes?.medium?.source_url || media?.source_url || '',
        excerpt: strip(p.excerpt?.rendered).slice(0, 220),
        date: p.date,
        downloads: extractDownloads(content),
      };
    }).filter((x) => x.title && x.url);
    const data = { source, name: cfg.name, items, total: Number(res.headers.get('x-wp-total')) || items.length, external: false };
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    return { source, name: cfg.name, items: [], total: 0, error: e.name === 'AbortError' ? '请求超时' : e.message, external: false };
  } finally {
    clearTimeout(timer);
  }
}

export function register(router) {
  router.get('/api/webresources/search', async (req, res, ctx) => {
    const source = String(ctx.query.source || '').trim();
    const q = String(ctx.query.q || ctx.query.query || '').trim();
    const page = Number(ctx.query.page) || 1;
    if (WP_SOURCES[source]) {
      if (!q) return { source, name: WP_SOURCES[source].name, items: [], total: 0, external: false };
      return searchWp(source, q, page);
    }
    if (EXTERNAL[source]) {
      return {
        source, name: EXTERNAL[source].name, items: [], total: 0, external: true,
        externalUrl: EXTERNAL[source].url + encodeURIComponent(q), error: '该站点没有公开搜索 API，已提供外部搜索入口。',
      };
    }
    throw new Error('未知资源站');
  });
}
