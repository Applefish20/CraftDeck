/**
 * MC百科（mcmod.cn）搜索代理。
 * 只在用户打开模组详情时按需查询，结果短时缓存；不抓取下载地址，不绕过登录。
 */
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

function decodeEntities(s) {
  return String(s || '')
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

function cleanDescription(html) {
  return decodeEntities(html)
    .replace(/\[(?:h\d|ban|b|i|u|color|url|img|quote|code|spoiler|attach)[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

async function searchMcmod(q) {
  const key = String(q || '').trim();
  if (!key) return { found: false, error: '缺少搜索词' };
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const url = `https://search.mcmod.cn/s?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.mcmod.cn/',
      },
    });
    if (!res.ok) return { found: false, error: `MC百科返回 HTTP ${res.status}`, searchUrl: url };
    const html = await res.text();
    const blocks = html.match(/<div class="result-item">[\s\S]*?<div class="foot">/g) || [];
    let best = null;
    for (const block of blocks) {
      const headHtml = block.split('<div class="body">')[0] || '';
      const anchors = [...headHtml.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
      let head = null;
      for (const a of anchors) {
        const title = decodeEntities(a[2]);
        const href = String(a[1] || '').startsWith('//') ? `https:${a[1]}` : String(a[1] || '');
        if (!title || !/^https?:\/\//i.test(href)) continue;
        if (!head || /\/class\//i.test(href)) head = { title, href };
        if (/\/class\//i.test(href)) break;
      }
      const body = /<div class="body">([\s\S]*?)<\/div>/i.exec(block);
      if (!head) continue;
      const { title, href } = head;
      const description = body ? cleanDescription(body[1]) : '';
      // 优先模组详情页（/class/），其次标题与搜索词匹配的结果，避免拿到整合包扩展。
      let score = 0;
      if (/\/class\/\d+\.html/i.test(href)) score += 100;
      const normalized = title.toLowerCase();
      const qLower = key.toLowerCase();
      if (normalized === qLower || normalized.includes(qLower)) score += 60;
      if (description.toLowerCase().includes(qLower)) score += 10;
      if (!best || score > best.score) best = { score, title, description, url: href };
    }
    if (best) {
      const data = { found: true, title: best.title, description: best.description, url: best.url, searchUrl: url, query: key };
      cache.set(key, { at: Date.now(), data });
      return data;
    }
    const data = { found: false, searchUrl: url, query: key };
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    return { found: false, error: e.name === 'AbortError' ? '查询超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

export function register(router) {
  router.get('/api/mcmod/search', async (req, res, ctx) => {
    const q = String(ctx.query.q || ctx.query.query || '').trim();
    if (!q) throw new Error('缺少搜索词');
    return searchMcmod(q);
  });
}
