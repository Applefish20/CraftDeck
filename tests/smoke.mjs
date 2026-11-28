/**
 * 端到端冒烟测试：在进程内启动启动器服务，逐个检查核心 API。
 * 用法：node tests/smoke.mjs        （需要联网：Mojang 清单 / Modrinth / Hypixel）
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const root = path.join(os.tmpdir(), 'craftdeck-smoke-' + process.pid);
process.env.MCL_ROOT = root;
process.env.MCL_NO_AUTH = '1';

const { startServer } = await import('../server/server.mjs');
const { server, url } = await startServer(0);
let pass = 0;
let fail = 0;

async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    pass++;
    console.log(`  ✓ ${name.padEnd(36)} ${String(detail ?? '').slice(0, 90)}  (${Date.now() - t}ms)`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name.padEnd(36)} ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function j(p, opts = {}) {
  const res = await fetch(url + p, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(body?.error || `${res.status} ${text.slice(0, 120)}`);
  return body;
}
const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const patch = (p, body) => j(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

console.log('\nCraftDeck 冒烟测试\n' + '='.repeat(56));

await check('健康检查', async () => {
  const r = await j('/api/health');
  assert(r.ok && r.name === 'CraftDeck', '健康检查失败');
  return r.root;
});

await check('静态首页与前端资源', async () => {
  for (const f of ['/', '/css/base.css', '/css/components.css', '/css/pages.css', '/js/app.js', '/js/state.js', '/js/ui.js',
    '/js/pages/instances.js', '/js/pages/versions.js', '/js/pages/modpacks.js', '/js/pages/mods.js', '/js/pages/resources.js',
    '/js/pages/translation.js', '/js/pages/servers.js', '/js/pages/terracotta.js', '/js/pages/hosts.js',
    '/js/pages/accounts.js', '/js/pages/settings.js', '/assets/icon.png']) {
    const res = await fetch(url + f);
    assert(res.ok, `${f} 返回 ${res.status}`);
  }
  return '18 个静态资源全部 200';
});

await check('默认实例已创建', async () => {
  const s = await j('/api/state');
  assert(s.instances.length >= 1, '没有默认实例');
  assert(s.settings.memoryMb > 0, '默认设置缺失');
  return `${s.instances.length} 个实例`;
});

await check('Java 自动检测', async () => {
  const r = await j('/api/java');
  const list = r.javas || r.java || [];
  assert(Array.isArray(list), '返回格式错误');
  return list.map((x) => `Java ${x.major}`).join(', ') || '未检测到（可手动指定）';
});

let accountId;
await check('离线账户', async () => {
  const r = await post('/api/accounts/offline', { username: 'SmokePlayer' });
  accountId = r.id;
  assert(r.type === 'offline' && r.uuid, '账户字段缺失');
  const state = await j('/api/state');
  const pub = state.accounts.find((a) => a.id === accountId);
  assert(pub && !('accessToken' in pub), '账户泄露令牌');
  return `${r.username} / ${r.uuid}`;
});

let instanceId;
await check('创建实例', async () => {
  const r = await post('/api/instances', { name: '冒烟实例', versionId: '1.21.1', accountId });
  instanceId = r.instance.id;
  assert(instanceId, '实例创建失败');
  return instanceId;
});

await check('版本清单（Mojang）', async () => {
  const r = await j('/api/versions');
  assert(r.versions.length > 10, '版本数量异常');
  return `${r.versions.length} 个版本，最新 ${r.latest.release}`;
});

await check('版本 JSON 解析', async () => {
  const r = await j('/api/versions/1.21.1');
  assert(r.json?.mainClass, '缺少 mainClass');
  return `${r.json.mainClass} · ${r.json.libraries} 个库 · Java ${r.json.javaVersion?.majorVersion}`;
});

await check('加载器列表（Fabric）', async () => {
  const r = await j('/api/versions/loaders?type=fabric&gameVersion=1.21.1');
  assert(r.versions.length > 0, '没有加载器版本');
  return `${r.versions.length} 个 Fabric 版本，最新 ${r.versions[0].version}`;
});

await check('Modrinth 搜索', async () => {
  const r = await j('/api/mods/search?query=sodium&type=mod&gameVersion=1.21.1&loader=fabric&limit=3');
  assert(r.hits.length > 0, '没有搜索结果');
  return `${r.total_hits} 个结果，首项 ${r.hits[0].title}`;
});

await check('模组版本列表', async () => {
  const r = await j('/api/mods/versions/sodium?gameVersion=1.21.1&loader=fabric');
  assert(Array.isArray(r) && r.length, '没有版本');
  return `${r.length} 个版本，最新 ${r[0].version_number}`;
});

await check('汉化包列表', async () => {
  const r = await j('/api/translation/packs');
  const packs = Array.isArray(r) ? r : r.packs;
  assert(packs.length > 0, '没有汉化包');
  return `${packs.length} 个汉化来源，推荐 ${packs.find((p) => p.recommended)?.name || packs[0].name}`;
});

let serverId;
await check('添加服务器 + SLP 检测', async () => {
  const created = await post('/api/servers', { name: 'Hypixel', address: 'mc.hypixel.net' });
  serverId = created.id || created.server?.id;
  const ping = await j(`/api/servers/${serverId}/ping`);
  assert(ping.online === true, '服务器应在线');
  assert(ping.players.online > 0, '在线人数异常');
  return `${ping.players.online}/${ping.players.max} 人 · ${ping.version.name} · ${ping.latencyMs}ms`;
});

await check('开服中心列表', async () => {
  const r = await j('/api/hosts');
  assert(Array.isArray(r), '返回格式错误');
  return `${r.length} 个本地服务器`;
});

await check('百宝箱状态与内存优化', async () => {
  const s = await j('/api/toolbox/status');
  assert(s.memory && s.memory.rssMb >= 0, '缺少内存信息');
  assert(s.disk && typeof s.disk.cache === 'number', '缺少磁盘信息');
  const o = await post('/api/toolbox/optimize', {});
  assert(o.ok && o.after, '内存优化失败');
  return `RSS ${o.before.rssMb}→${o.after.rssMb} MB · GC ${o.gcRan ? '已执行' : '不可用'}`;
});

await check('百宝箱网络与端口检测', async () => {
  const [n, p] = await Promise.all([j('/api/toolbox/network'), j('/api/toolbox/ports')]);
  assert(n.results.length >= 3, '网络诊断结果不足');
  assert(p.ports.length >= 3, '端口检测结果不足');
  return `网络 ${n.results.filter((x) => x.ok).length}/${n.results.length} 通 · 端口 ${p.ports.filter((x) => x.free).length}/${p.ports.length} 空闲`;
});

await check('陶瓦联机状态接口', async () => {
  const s = await j('/api/terracotta/status');
  assert(typeof s.installed === 'boolean' && s.state, '返回格式错误');
  assert(/Terracotta/.test(s.attribution || ''), '缺少版权标识');
  return s.installed ? `已安装 ${s.version}` : '未安装（按需下载）';
});

await check('系统信息', async () => {
  const r = await j('/api/system');
  assert(r.totalMemMb > 0 && r.cpus > 0, '系统信息异常');
  return `${r.cpus} 核 · ${Math.round(r.totalMemMb / 1024)} GB · ${r.platform}/${r.arch}`;
});

await check('设置持久化', async () => {
  const r = await patch('/api/settings', { memoryMb: 6144, background: { type: 'preset', value: 'ocean' } });
  assert(r.settings.memoryMb === 6144, '内存设置未保存');
  assert(r.settings.background.value === 'ocean', '背景未保存');
  return 'memoryMb=6144 · 背景=ocean';
});

await check('启动命令生成（未安装时明确报错）', async () => {
  const res = await fetch(url + `/api/instances/${instanceId}/dryrun`);
  const body = await res.json();
  assert(!res.ok && /缺少游戏核心文件|请先为实例选择/.test(body.error || ''), '应给出明确的中文错误');
  return body.error;
});

await check('SSE 事件流', async () => {
  const ctrl = new AbortController();
  const res = await fetch(url + '/api/events', { signal: ctrl.signal });
  assert(res.ok && (res.headers.get('content-type') || '').includes('text/event-stream'), '不是 SSE');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  ctrl.abort();
  assert(value && value.length > 0, '没有收到数据');
  return new TextDecoder().decode(value).slice(0, 40);
});

await check('删除实例与账户', async () => {
  const del = await fetch(url + `/api/instances/${instanceId}`, { method: 'DELETE' });
  assert(del.ok, '删除实例失败');
  const a = await fetch(url + `/api/accounts/${accountId}`, { method: 'DELETE' });
  assert(a.ok, '删除账户失败');
  const s = await j('/api/state');
  assert(!s.instances.some((i) => i.id === instanceId), '实例仍存在');
  assert(!s.accounts.some((x) => x.id === accountId), '账户仍存在');
  return '已清理';
});

server.close();
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('='.repeat(56));
console.log(`结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
