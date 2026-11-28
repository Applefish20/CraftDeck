/**
 * 更新检查：从可配置的 update.json 读取最新版本。
 * update.json 格式：
 * { "version": "2.7.2", "url": "https://.../CraftDeck-2.7.2-win64-full.zip", "notes": "..." }
 */
import { store } from '../core/store.mjs';

const CURRENT = '3.6.1';

function cmp(a, b) {
  const pa = String(a).split('.').map((x) => Number(x) || 0);
  const pb = String(b).split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function register(router) {
  router.get('/api/update/check', async () => {
    const feed = String(store.settings.updateFeedUrl || '').trim();
    if (!feed) return { configured: false, current: CURRENT };
    if (!/^https?:\/\//i.test(feed)) throw new Error('更新地址必须是 http/https 链接');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(feed, { headers: { Accept: 'application/json', 'User-Agent': `CraftDeck/${CURRENT}` }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`更新源 HTTP ${r.status}`);
      const data = await r.json();
      const latest = String(data.version || '').trim();
      if (!latest) throw new Error('更新源缺少 version 字段');
      return {
        configured: true, current: CURRENT, latest,
        hasUpdate: cmp(latest, CURRENT) > 0,
        url: data.url || '', notes: data.notes || '', published: data.published || '',
      };
    } finally { clearTimeout(timer); }
  });

  router.get('/api/update/info', () => ({ current: CURRENT }));
}
