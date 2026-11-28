/* ================= CraftDeck 应用外壳 ================= */
import { $, $$, h, toast, toastErr, toastOk, avatarEl, fmtNum, fmtDuration, fmtBytes, modal } from './ui.js';
import { hydrateIcons } from './icons.js';
import {
  state, api, loadState, patchSettings, applyAppearance, connectEvents, subscribe, emit,
  syncActiveAccount, accountById, instanceById, isRunning, currentInstance, applyHiddenPages,
} from './state.js';

const PAGES = {
  instances: () => import('./pages/instances.js'),
  downloads: () => import('./pages/downloads.js'),
  versions: () => import('./pages/versions.js'),
  migrate: () => import('./pages/migrate.js'),
  modpacks: () => import('./pages/modpacks.js'),
  mods: () => import('./pages/mods.js'),
  resources: () => import('./pages/resources.js'),
  translation: () => import('./pages/translation.js'),
  servers: () => import('./pages/servers.js'),
  terracotta: () => import('./pages/terracotta.js'),
  hosts: () => import('./pages/hosts.js'),
  accounts: () => import('./pages/accounts.js'),
  skins: () => import('./pages/skins.js'),
  logs: () => import('./pages/logs.js'),
  toolbox: () => import('./pages/toolbox.js'),
  settings: () => import('./pages/settings.js'),
};

const TITLES = {
  instances: ['启动', '选一个版本，点开始就行'],
  downloads: ['下载中心', '版本、整合包、模组、光影……想要的基本都在这儿'],
  versions: ['版本下载', '原版和加载器，装哪个看你今天想怎么折腾'],
  migrate: ['迁移导入', '从别的启动器搬家，存档和模组尽量一根毛都不少'],
  modpacks: ['整合包', '整包端走，省得你一个个找模组'],
  mods: ['模组', '模组管够，注意别把电脑塞爆'],
  resources: ['材质与光影', '给世界换个滤镜，顺便让显卡加加班'],
  translation: ['汉化', '汉化包，让模组说人话'],
  servers: ['服务器列表', '常去的服务器放这儿，别每次都翻聊天记录'],
  terracotta: ['联机', '陶瓦联机 / 红石联机，选一个顺手的'],
  hosts: ['开服中心', '在自家电脑开服，先确认 Java 没闹脾气'],
  accounts: ['账户', '正版、离线、第三方，能登录就是好账户'],
  skins: ['皮肤', '给方块人换身衣服，别让他一直穿默认皮'],
  logs: ['日志', '出问题先看这里，比反复重启更有用'],
  toolbox: ['百宝箱', '给启动器做个体检，看看谁在偷偷吃内存'],
  settings: ['设置', '把启动器调成你顺手的样子，改完不用重启'],
};

let currentPage = null;
let currentModule = null;
let consoleTabs = new Map(); // id -> {name, lines, running}
let activeConsole = null;
let currentLog = [];
const unsubs = [];

/* ---------------- 路由 ---------------- */
function parseHash() {
  const raw = (location.hash || '#/instances').replace(/^#\/?/, '');
  const [route, ...rest] = raw.split('/');
  return { route: PAGES[route] ? route : 'instances', param: rest.join('/') || null };
}

async function navigate() {
  const { route, param } = parseHash();
  const hidden = new Set(Array.isArray(state.settings.hiddenPages) ? state.settings.hiddenPages : []);
  if (hidden.has(route) && route !== 'instances') {
    location.hash = '#/instances';
    return;
  }
  if (currentPage === route && !param) { emit({ type: 'same-page' }); return; }
  // destroy previous
  if (currentModule && typeof currentModule.destroy === 'function') {
    try { currentModule.destroy(); } catch (e) { console.warn(e); }
  }
  currentPage = route;
  currentModule = null;
  state.route = route;
  state.routeParam = param;
  const [title, sub] = TITLES[route] || TITLES.instances;
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;
  for (const a of $$('#nav .nav-item')) a.classList.toggle('active', a.dataset.page === route);
  const activeNav = $$('#nav .nav-item').find((a) => a.dataset.page === route);
  if (activeNav && typeof activeNav.scrollIntoView === 'function') activeNav.scrollIntoView({ block: 'nearest' });
  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;
  try {
    const mod = await PAGES[route]();
    currentModule = mod.default || mod;
    const pageEl = h('div', { class: 'page' });
    view.append(pageEl);
    await currentModule.render(pageEl, {
      route, param,
      refresh: () => { if (currentPage === route) renderCurrent(); },
    });
  } catch (e) {
    console.error(e);
    view.append(h('div', { class: 'panel' }, [
      h('h2', {}, '页面加载失败'),
      h('p', { class: 'dim', style: { marginTop: '8px' } }, e.message),
      h('button', { class: 'btn', style: { marginTop: '12px' }, onclick: () => navigate() }, '重试'),
    ]));
  }
  updateBackButton(param);
}

async function renderCurrent() {
  const view = $('#view');
  const route = currentPage;
  if (currentModule && typeof currentModule.destroy === 'function') {
    try { currentModule.destroy(); } catch { /* ignore */ }
  }
  view.innerHTML = '';
  const pageEl = h('div', { class: 'page' });
  view.append(pageEl);
  try {
    await currentModule.render(pageEl, { route, param: state.routeParam, refresh: renderCurrent });
  } catch (e) {
    console.error(e);
    view.append(h('div', { class: 'panel' }, h('p', { class: 'dim' }, e.message)));
  }
}

function updateBackButton(param) {
  const btn = $('#btn-back');
  btn.hidden = !param;
}

/* ---------------- 顶栏账户 ---------------- */
function renderAccountChip() {
  const acc = state.activeAccount || accountById(state.settings.lastAccountId);
  $('#account-name').textContent = acc ? acc.username : '未登录';
  const av = $('#account-avatar');
  av.textContent = acc ? (acc.username || '?').slice(0, 1).toUpperCase() : '?';
  av.innerHTML = '';
  if (acc) {
    const box = avatarEl(acc);
    box.id = 'account-avatar';
    box.className = av.className;
    av.replaceWith(box);
  }
  const chip = $('#account-chip');
  chip.title = acc ? `${acc.username} · ${acc.type === 'microsoft' ? '正版' : acc.type === 'thirdparty' ? '第三方' : '离线'}账户` : '点击登录或添加账户';
}

async function openAccountMenu() {
  const menu = $('#account-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  const chip = $('#account-chip');
  const rect = chip.getBoundingClientRect();
  menu.innerHTML = '';
  menu.style.top = rect.bottom + 8 + 'px';
  menu.style.right = Math.max(12, window.innerWidth - rect.right) + 'px';
  menu.style.left = 'auto';
  const items = state.accounts.map((a) => h('button', {
    class: 'pop-item',
    onclick: async () => {
      menu.hidden = true;
      await patchSettings({ lastAccountId: a.id });
      renderAccountChip();
      toastOk('已切换账户', a.username);
    },
  }, [
    avatarEl(a),
    h('div', { class: 'grow' }, [
      h('div', { style: { fontSize: '12.5px', color: 'var(--text)' } }, a.username),
      h('div', { style: { fontSize: '10.5px', color: 'var(--text-mute)' } }, a.type === 'microsoft' ? '微软正版' : a.type === 'thirdparty' ? '第三方' : '离线账户'),
    ]),
    a.id === state.settings.lastAccountId ? h('span', { class: 'badge accent', style: { fontSize: '10px' } }, '使用中') : null,
  ]));
  if (!items.length) menu.append(h('div', { class: 'pop-label' }, '还没有账户'));
  menu.append(...items);
  menu.append(h('div', { class: 'pop-sep' }));
  menu.append(h('button', { class: 'pop-item', onclick: () => { menu.hidden = true; location.hash = '#/accounts'; } }, '＋ 管理 / 添加账户'));
  menu.hidden = false;
}

/* ---------------- 控制台 ---------------- */
function ensureConsoleTab(id, name) {
  if (!consoleTabs.has(id)) consoleTabs.set(id, { id, name, lines: [], running: false });
  return consoleTabs.get(id);
}

function renderConsoleTabs() {
  const wrap = $('#console-tabs');
  wrap.innerHTML = '';
  if (!consoleTabs.size) ensureConsoleTab('launcher', '启动器日志');
  for (const tab of consoleTabs.values()) {
    wrap.append(h('button', {
      class: `console-tab ${activeConsole === tab.id ? 'active' : ''}`,
      onclick: () => { activeConsole = tab.id; renderConsoleTabs(); renderConsoleBody(); },
    }, [tab.running ? h('span', { class: 'dot on' }) : h('span', { class: 'dot' }), tab.name]));
  }
}

function renderConsoleBody() {
  const body = $('#console-body');
  const tab = consoleTabs.get(activeConsole);
  if (!tab) { body.textContent = ''; return; }
  const wasBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const line of tab.lines.slice(-600)) {
    const cls = /\b(error|exception|failed|致命)\b/i.test(line) ? 'l-err' : /\bwarn/i.test(line) ? 'l-warn' : /^\[启动器\]/.test(line) ? 'l-sys' : '';
    frag.append(h('div', { class: cls }, line));
  }
  body.append(frag);
  if (wasBottom) body.scrollTop = body.scrollHeight;
}

export function consoleLog(text, { tabId = 'launcher', tabName = '启动器日志', running = false } = {}) {
  const tab = ensureConsoleTab(tabId, tabName);
  if (running) tab.running = true;
  for (const line of String(text).split(/\r?\n/)) if (line) tab.lines.push(line);
  if (tab.lines.length > 3000) tab.lines.splice(0, tab.lines.length - 3000);
  if (!activeConsole) activeConsole = tabId;
  if (!$('#console-panel').hidden && (activeConsole === tabId || !consoleTabs.has(activeConsole))) {
    renderConsoleTabs();
    renderConsoleBody();
  }
}

function toggleConsole(show) {
  const panel = $('#console-panel');
  const visible = show !== undefined ? show : panel.hidden;
  panel.hidden = !visible;
  if (visible) { activeConsole = activeConsole || 'launcher'; renderConsoleTabs(); renderConsoleBody(); }
}

function closeConsoleFrom(tabId) {
  consoleTabs.delete(tabId);
  if (activeConsole === tabId) activeConsole = [...consoleTabs.keys()][0] || null;
  renderConsoleTabs();
  renderConsoleBody();
}

let sponsorPrompted = false;
let brandClicks = 0;
let brandLastClick = 0;
let startNavClicks = 0;
let startNavLastClick = 0;
let eggBuffer = '';
let konamiBuffer = [];
const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
const SPONSOR_URL = 'https://afdian.com/a/applefish';

function showSponsor(launches) {
  if (sponsorPrompted) return;
  sponsorPrompted = true;
  modal({
    title: '第 ' + launches + ' 次启动',
    body: [
      h('p', { class: 'dim', style: { lineHeight: '1.8' } }, 'CraftDeck 一直免费、无广告、无捆绑。如果你愿意支持作者继续维护，可以请我喝一杯茶。'),
      h('p', { class: 'hint' }, '不赞助也完全不影响使用，谢谢每一次启动。'),
    ],
    actions: [
      { label: '以后再说' },
      { label: '去爱发电', kind: 'primary', onClick: () => { window.desktopWindow?.openExternal?.(SPONSOR_URL) || window.open(SPONSOR_URL, '_blank'); return false; } },
    ],
  });
}

function showEgg() {
  modal({
    title: '你发现了一个彩蛋',
    body: [
      h('p', { class: 'dim' }, '嘶——是苦力怕。'),
      h('p', { class: 'hint' }, '小提示：连续点击左上角 CraftDeck 图标 5 次、输入 applefish，或试试科乐美秘技。'),
    ],
    actions: [{ label: '收下彩蛋', kind: 'primary' }],
  });
}

function showApplefish() {
  modal({
    title: '彩蛋 · Applefish',
    body: [
      h('p', { class: 'dim' }, '你找到了作者的名字。'),
      h('p', { class: 'hint' }, 'CraftDeck 由 Applefish 维护，感谢每一位玩家的反馈。'),
      h('p', { class: 'mono', style: { color: 'var(--accent)' } }, 'applefish · craftdeck · 3.6.1'),
    ],
    actions: [{ label: '继续游戏', kind: 'primary' }],
  });
}

function showKonami() {
  modal({
    title: '↑↑↓↓←→←→BA',
    body: [
      h('p', { class: 'dim' }, '科乐美秘技生效：你获得了 30 条虚拟命。'),
      h('p', { class: 'hint' }, '可惜 CraftDeck 没有街机模式，只能送你一句：今天也要玩得开心。'),
    ],
    actions: [{ label: '收下 30 条命', kind: 'primary' }],
  });
}

function showDiamond() {
  modal({
    title: '彩蛋 · 钻石！',
    body: [
      h('p', { class: 'dim' }, '你挖到了 64 颗钻石。'),
      h('p', { class: 'hint' }, '别急着跳进岩浆，先把启动器更新到最新版。'),
    ],
    actions: [{ label: '放进背包', kind: 'primary' }],
  });
}

function showHerobrine() {
  toast({ kind: 'info', title: 'Herobrine joined the game', message: '别回头，他只是在看你更新启动器。', timeout: 6000 });
}

function showEggGuide() {
  modal({
    title: '彩蛋指南',
    body: [
      h('p', { class: 'hint' }, '不用输入框：先点一下启动器空白处，让窗口获得焦点，然后直接敲键盘。'),
      h('div', { class: 'detail-list' }, [
        ['连点左上角 CraftDeck 图标 7 次（要快）', '秘密基地'],
        ['输入 creeper', '苦力怕'],
        ['输入 applefish', '作者彩蛋'],
        ['输入 diamond', '64 颗钻石'],
        ['在「下载 → 模组」搜索 him', '？？？'],
        ['输入 eggs', '打开这份指南'],
        ['按 ↑ ↑ ↓ ↓ ← → ← → B A 或输入 konami', '科乐美秘技'],
        ['双击右上角账户头像', 'Steve 的头发'],
        ['连点侧边栏「启动」8 次（要快）', '启动启动器'],
      ].map(([a, b]) => h('div', { class: 'detail-item' }, [h('span', {}, a), h('strong', {}, b)]))),
    ],
    actions: [{ label: '继续探索', kind: 'primary' }],
  });
}

let hbState = null;
let hbBtnHandler = null;

function hbNoise() {
  const chars = '0101adggef';
  let out = '';
  for (let i = 0; i < 11; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function hbClick(e) {
  if (!hbState || hbState.phase !== 'active') return;
  if (!e.target.closest('.hero-launch')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  e.stopPropagation();
  restoreHerobrine();
}

async function startHerobrine() {
  if (hbState) return;
  hbState = { phase: 'starting' };
  location.hash = '#/instances';
  await new Promise((r) => setTimeout(r, 500));
  if (!hbState) return;

  const acc = state.activeAccount || accountById(state.settings.lastAccountId);
  let oldSkin = null;
  let hadOld = Boolean(acc?.skin);
  let oldModel = acc?.skinModel || 'classic';
  if (acc?.skin) {
    try {
      const r = await fetch(acc.skin);
      if (r.ok) oldSkin = await r.arrayBuffer();
    } catch { /* ignore */ }
  }
  if (acc) {
    try {
      const r = await fetch('/assets/eggs/him.png');
      const buf = await r.arrayBuffer();
      await api('/api/skins/upload', {
        method: 'POST', body: buf,
        headers: { 'x-account-id': acc.id, 'x-model': 'classic' },
      });
    } catch { /* 皮肤替换失败也继续整蛊 */ }
  }

  const root = document.documentElement;
  const layer = document.getElementById('bg-layer');
  const dim = document.getElementById('bg-dim');
  const img = document.getElementById('bg-image');
  const nameEl = document.getElementById('account-name');
  const av = document.getElementById('account-avatar');
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.nodeValue.trim()) continue;
    const p = n.parentElement;
    if (!p || p.closest('script,style,noscript,.hero-launch,#account-name')) continue;
    texts.push({ n, text: n.nodeValue });
  }
  const banners = [...document.querySelectorAll('.inst-banner')].map((el) => ({ el, bg: el.style.backgroundImage }));
  const hero = document.querySelector('.hero');
  const heroBtn = document.querySelector('.hero-launch');

  const st = {
    phase: 'active', texts, banners,
    heroStyle: hero?.getAttribute('style') || '',
    heroBtn,
    theme: root.dataset.theme, colorScheme: root.style.colorScheme,
    layerClass: layer.className, layerStyle: layer.getAttribute('style') || '',
    dimStyle: dim.getAttribute('style') || '', imgStyle: img.getAttribute('style') || '',
    name: nameEl?.textContent || '', avatar: av?.innerHTML || '',
    acc, oldSkin, hadOld, oldModel,
  };
  hbState = st;

  for (const { n } of texts) n.nodeValue = hbNoise();
  if (nameEl) nameEl.textContent = '查无此人';
  if (av) {
    av.innerHTML = '';
    av.append(h('img', { src: '/assets/eggs/herobrine.png', alt: '' }));
  }
  for (const { el } of banners) el.style.backgroundImage = 'url("/assets/backgrounds/night.webp")';
  if (hero) hero.style.backgroundImage = 'linear-gradient(100deg, rgba(4,7,11,.9), rgba(4,7,11,.58)), url("/assets/backgrounds/night.webp")';
  root.dataset.theme = 'dark';
  root.style.colorScheme = 'dark';
  layer.className = 'bg-layer bg-preset-stronghold';
  layer.style.background = '';
  img.style.backgroundImage = 'none';
  dim.style.background = 'rgba(4, 7, 11, .55)';
  document.addEventListener('click', hbClick, true);
  if (heroBtn) {
    hbBtnHandler = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      restoreHerobrine();
    };
    heroBtn.addEventListener('click', hbBtnHandler, true);
  }
}

async function restoreHerobrine() {
  const st = hbState;
  if (!st || st.phase !== 'active') return;
  hbState = null;
  document.removeEventListener('click', hbClick, true);
  if (st.heroBtn && hbBtnHandler) {
    st.heroBtn.removeEventListener('click', hbBtnHandler, true);
    hbBtnHandler = null;
  }

  for (const { n, text } of st.texts) n.nodeValue = text;
  for (const { el, bg } of st.banners) el.style.backgroundImage = bg;
  const hero = document.querySelector('.hero');
  if (hero) hero.setAttribute('style', st.heroStyle);
  const root = document.documentElement;
  root.dataset.theme = st.theme;
  root.style.colorScheme = st.colorScheme;
  const layer = document.getElementById('bg-layer');
  const dim = document.getElementById('bg-dim');
  const img = document.getElementById('bg-image');
  const nameEl = document.getElementById('account-name');
  const av = document.getElementById('account-avatar');
  if (layer) { layer.className = st.layerClass; layer.style.cssText = st.layerStyle; }
  if (dim) dim.style.cssText = st.dimStyle;
  if (img) img.style.cssText = st.imgStyle;
  if (nameEl) nameEl.textContent = st.name;
  if (av) av.innerHTML = st.avatar;

  try {
    if (st.acc) {
      if (st.oldSkin) {
        await api('/api/skins/upload', {
          method: 'POST', body: st.oldSkin,
          headers: { 'x-account-id': st.acc.id, 'x-model': st.oldModel },
        });
      } else if (!st.hadOld) {
        await api(`/api/skins/${st.acc.id}`, { method: 'DELETE' });
      }
      await loadState();
      renderAccountChip();
    }
  } catch (e) { toastErr('皮肤恢复失败', e.message); }
  toastOk('一切恢复正常', '刚才看到的都不是真的。');
}

if (typeof window !== 'undefined') {
  window.__craftDeckHerobrine = startHerobrine;
  window.addEventListener('craftdeck:herobrine', startHerobrine);
}

function installEasterEggs() {
  const brand = $('#brand');
  if (brand) {
    brand.addEventListener('click', () => {
      const now = Date.now();
      if (now - brandLastClick > 1200) brandClicks = 0;
      brandLastClick = now;
      brandClicks += 1;
      if (brandClicks === 5) toast({ kind: 'info', title: '还差两下', message: '节奏别停。', timeout: 1500 });
      if (brandClicks >= 7) {
        brandClicks = 0;
        modal({
          title: '彩蛋 · 秘密基地',
          body: [
            h('p', { class: 'dim' }, '你点开了 CraftDeck 的秘密基地。'),
            h('p', { class: 'hint' }, '这里没有钻石，但有一句：谢谢你一直陪我更新。'),
            h('p', { class: 'mono', style: { marginTop: '8px', color: 'var(--accent)' } }, 'applefish was here · 3.6.1'),
          ],
          actions: [{ label: '很高兴认识你', kind: 'primary' }],
        });
      }
    });
  }
  const accountChip = $('#account-chip');
  if (accountChip) {
    accountChip.addEventListener('dblclick', () => {
      modal({
        title: '彩蛋 · Steve 的头发',
        body: [
          h('p', { class: 'dim' }, '你双击了账户头像。'),
          h('p', { class: 'hint' }, 'Steve 的头发不是发型，是一整块立方体。这很 Minecraft。'),
        ],
        actions: [{ label: '摸摸头', kind: 'primary' }],
      });
    });
  }
  const startNav = document.querySelector('#nav .nav-item[data-page="instances"]');
  if (startNav) {
    startNav.addEventListener('click', () => {
      const now = Date.now();
      if (now - startNavLastClick > 1200) startNavClicks = 0;
      startNavLastClick = now;
      startNavClicks += 1;
      if (startNavClicks >= 8) {
        startNavClicks = 0;
        modal({
          title: '彩蛋 · 启动启动器',
          body: [
            h('p', { class: 'dim' }, '你在启动器里连续启动了 5 次启动器。'),
            h('p', { class: 'hint' }, '俄罗斯套娃确认无误。真正的游戏还在等你点「启动游戏」。'),
          ],
          actions: [{ label: '停止套娃', kind: 'primary' }],
        });
      }
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return;
    if (e.key.startsWith('Arrow')) {
      konamiBuffer = [...konamiBuffer, e.key].slice(-KONAMI.length);
      if (konamiBuffer.join('|') === KONAMI.join('|')) { konamiBuffer = []; showKonami(); }
      return;
    }
    if (!e.key || e.key.length !== 1) return;
    konamiBuffer = [...konamiBuffer, e.key.toLowerCase()].slice(-KONAMI.length);
    if (konamiBuffer.join('|') === KONAMI.join('|')) { konamiBuffer = []; showKonami(); }
    eggBuffer = (eggBuffer + e.key.toLowerCase()).slice(-10);
    if (eggBuffer.endsWith('creeper')) { eggBuffer = ''; showEgg(); }
    else if (eggBuffer.endsWith('applefish')) { eggBuffer = ''; showApplefish(); }
    else if (eggBuffer.endsWith('diamond')) { eggBuffer = ''; showDiamond(); }
    else if (eggBuffer.endsWith('konami')) { eggBuffer = ''; showKonami(); }
    else if (eggBuffer.endsWith('eggs')) { eggBuffer = ''; showEggGuide(); }
  });
  setTimeout(() => {
    try {
      if (!localStorage.getItem('craftdeck.eggHint')) {
        localStorage.setItem('craftdeck.eggHint', '1');
        toast({ kind: 'info', title: '悄悄话', message: '启动器里藏着一些彩蛋。试试在空白处输入 Minecraft 单词。', timeout: 5000 });
      }
    } catch { /* ignore */ }
  }, 4500);
}

function installNavTooltips() {
  const tip = h('div', { class: 'nav-tooltip' });
  document.body.append(tip);
  for (const a of $$('#nav .nav-item')) {
    a.addEventListener('mouseenter', () => {
      if (!document.body.classList.contains('nav-text-hidden')) return;
      const label = a.dataset.tip || a.getAttribute('aria-label');
      if (!label) return;
      tip.textContent = label;
      tip.classList.add('show');
      const r = a.getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
      tip.style.left = `${Math.round(Math.max(r.right + 14, (sidebar?.right || r.right) + 18))}px`;
      tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
    });
    a.addEventListener('mouseleave', () => tip.classList.remove('show'));
  }
  window.addEventListener('scroll', () => tip.classList.remove('show'), true);
}

function openSelectPicker(select) {
  const options = Array.from(select.options)
    .filter((o) => !o.disabled)
    .map((o) => ({ value: o.value, label: (o.textContent || o.value || '').trim() }));
  if (!options.length) return;
  let keyword = '';
  const list = h('div', { class: 'loader-picker-list' });
  const draw = () => {
    const arr = keyword ? options.filter((o) => o.label.toLowerCase().includes(keyword) || String(o.value).toLowerCase().includes(keyword)) : options;
    list.replaceChildren(...(arr.length ? arr.map((o) => h('button', {
      class: `loader-pick-item ${o.value === select.value ? 'selected' : ''}`,
      onclick: () => {
        select.value = o.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        picker.close?.();
      },
    }, [h('span', { class: 'ellipsis' }, o.label), o.value === select.value ? h('span', { class: 'chip' }, '当前') : null])) : [h('div', { class: 'hint', style: { padding: '12px' } }, '没有匹配项')]));
  };
  const search = options.length > 8 ? h('input', {
    class: 'input', placeholder: '搜索选项…', style: { marginBottom: '8px' },
    oninput: (e) => { keyword = e.target.value.trim().toLowerCase(); draw(); },
  }) : null;
  const picker = modal({
    title: select.dataset.pickerTitle || '选择',
    body: [search, list].filter(Boolean),
    actions: [{ label: '关闭', kind: 'primary' }],
  });
  draw();
}

function installSelectPicker() {
  document.addEventListener('mousedown', (e) => {
    const select = e.target.closest('select');
    if (!select || select.disabled || select.multiple || select.options.length <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    openSelectPicker(select);
  }, true);
  document.addEventListener('click', (e) => {
    if (e.target.closest('select')) e.preventDefault();
  }, true);
}

function openTaskDetail(taskId) {
  const t = state.tasks.get(taskId);
  if (!t) return;
  const pct = Math.round((t.percent ?? (t.total ? t.done / t.total : 0)) * 100);
  let close = null;
  const m = modal({
    title: '下载详情',
    wide: true,
    body: [
      h('div', { class: 'detail-list' }, [
        h('div', { class: 'detail-item' }, [h('span', {}, '当前任务'), h('strong', {}, t.label || '处理中')]),
        h('div', { class: 'detail-item' }, [h('span', {}, '进度'), h('strong', {}, pct + '%')]),
        h('div', { class: 'detail-item' }, [h('span', {}, '文件'), h('strong', {}, `${t.done || 0} / ${t.total || 0}`)]),
        h('div', { class: 'detail-item' }, [h('span', {}, '速度'), h('strong', {}, t.speedBps ? `${fmtBytes(t.speedBps)}/s` : '—')]),
      ]),
      h('div', { class: 'progress', style: { marginTop: '12px' } }, h('i', { style: { width: pct + '%' } })),
      h('div', { class: 'hint', style: { marginTop: '10px' } }, '取消后已完成的文件会保留，重新安装会从缺失文件继续。'),
    ],
    actions: [
      { label: '关闭' },
      { label: '取消下载', kind: 'danger', onClick: async () => {
        try { await api(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: {} }); state.tasks.delete(taskId); renderTaskMini(); m.close?.(); }
        catch (e) { toastErr('取消失败', e.message); }
      } },
    ],
  });
  close = m.close;
}

/* ---------------- 任务条 ---------------- */
function renderTaskMini() {
  const box = $('#task-mini');
  let best = null;
  for (const t of state.tasks.values()) if (!t.finished && (!best || (t.updatedAt || 0) > (best.updatedAt || 0))) best = t;
  if (!best) { box.hidden = true; return; }
  box.hidden = false;
  const pct = Math.round((best.percent ?? (best.total ? best.done / best.total : 0)) * 100);
  const speed = best.speedBps ? ` · ${fmtBytes(best.speedBps)}/s` : '';
  $('#task-mini-label').textContent = (best.label || '处理中…') + speed;
  $('#task-mini-label').title = best.label || '';
  $('#task-mini-pct').textContent = pct + '%';
  $('#task-mini-bar').style.width = pct + '%';
  box.dataset.taskId = best.taskId || '';
  box.style.cursor = 'pointer';
  box.title = '点击查看下载详情';
  const pause = $('#task-mini-pause');
  if (pause) pause.hidden = !best.taskId;
}

/* ---------------- 全局事件 ---------------- */
function wireEvents() {
  const d = subscribe((evt) => {
    if (evt.type === 'sse') handleSse(evt.evt);
    else if (evt.type === 'task') renderTaskMini();
    else if (evt.type === 'settings') renderAccountChip();
  });
  unsubs.push(d);
  return () => { unsubs.forEach((u) => u && u()); unsubs.length = 0; };
}

function handleSse(evt) {
  if (evt.type === 'log') {
    consoleLog(`[${evt.level || 'info'}] ${evt.message}`);
  } else if (evt.type === 'notify') {
    toast({ kind: evt.kind || 'info', title: evt.title, message: evt.message });
  } else if (evt.type === 'progress') {
    if (evt.scope === 'lnch' || evt.scope === 'launch') consoleLog(`[进度] ${evt.label || ''} ${Math.round((evt.percent || 0) * 100)}%`);
    renderTaskMini();
  } else if (evt.type === 'launch') {
    if (evt.phase === 'running') {
      const inst = instanceById(evt.instanceId);
      const tab = ensureConsoleTab(evt.instanceId, inst ? inst.name : '游戏进程');
      tab.running = true;
      consoleLog(`[启动器] 游戏已启动 · ${inst ? inst.name : evt.instanceId}`, { tabId: evt.instanceId, tabName: tab.name, running: true });
      renderAccountChip();
      loadState().then(() => {
        const launches = Number(state.stats?.launches || 0);
        if (launches > 0 && launches % 50 === 0) showSponsor(launches);
      }).catch(() => {});
    } else if (evt.phase === 'log') {
      const inst = instanceById(evt.instanceId);
      const tab = ensureConsoleTab(evt.instanceId, inst ? inst.name : '游戏进程');
      consoleLog(evt.line, { tabId: evt.instanceId, tabName: tab.name });
    } else if (evt.phase === 'exit') {
      const tab = consoleTabs.get(evt.instanceId);
      if (tab) tab.running = false;
      consoleLog(`[启动器] 游戏已退出 (代码 ${evt.code ?? '?'})`, { tabId: evt.instanceId });
      if (activeConsole === evt.instanceId) renderConsoleTabs();
    } else if (evt.phase === 'error') {
      toastErr('启动失败', evt.error);
    }
  }
}

/* ---------------- 启动 ---------------- */
function showWelcomeIfNeeded() {
  if (state.settings.onboarded) return;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    patchSettings({ onboarded: true }).catch(() => {});
  };
  modal({
    title: '欢迎使用 CraftDeck',
    wide: true,
    body: [
      h('div', { class: 'welcome-hero' }, [
        h('img', { class: 'welcome-logo', src: '/assets/icon.png', alt: 'CraftDeck' }),
        h('div', {}, [
          h('div', { class: 'welcome-title' }, '你好，欢迎使用 CraftDeck！'),
          h('div', { class: 'welcome-sub' }, '一个为《我的世界》Java 版准备的多功能启动器 · 作者 Applefish'),
        ]),
      ]),
      h('div', { class: 'welcome-steps' }, [
        ['1', '下载版本', '左侧「版本下载」→ 选大版本 → 选小版本 → 安装到实例。'],
        ['2', '登录账户', '「账户」页添加离线 / 微软正版 / LittleSkin 第三方账户。'],
        ['3', '启动游戏', '回「实例」页点启动；内存和 Java 在实例「内容 → 设置」里调。'],
      ].map(([n, t, d]) => h('div', { class: 'welcome-step' }, [
        h('div', { class: 'welcome-num' }, n),
        h('div', {}, [h('div', { class: 'welcome-step-title' }, t), h('div', { class: 'welcome-step-text' }, d)]),
      ]))),
      h('div', { class: 'callout info' },
        '完整使用说明在「设置 → 使用说明」；遇到问题可在「设置 → 反馈」直接发到作者邮箱。'),
    ],
    actions: [
      { label: '先看看使用说明', onClick: () => { finish(); location.hash = '#/settings/guide'; } },
      { label: '开始使用', kind: 'primary', onClick: finish },
    ],
    onClose: finish,
  });
}

function setupDropImport() {
  const overlay = h('div', { class: 'drop-overlay', hidden: true }, [
    h('div', { class: 'drop-card' }, [
      h('div', { style: { fontSize: '34px' } }, '⬇'),
      h('div', { style: { fontSize: '16px', fontWeight: '750', marginTop: '8px' } }, '松开即可导入'),
      h('div', { class: 'hint' }, '支持拖入 .mrpack / .zip 整合包，自动创建启动项；版本文件夹请到「迁移导入」选择。'),
    ]),
  ]);
  document.body.append(overlay);
  let depth = 0;
  const show = (v) => { overlay.hidden = !v; };
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); depth += 1; show(true);
  });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); depth = 0; show(false);
    const file = e.dataTransfer.files[0];
    if (!/\.(mrpack|zip)$/i.test(file.name)) {
      toast({ kind: 'error', title: '暂不支持这种文件', message: '请拖入 .mrpack 或 .zip 整合包。', timeout: 6000 });
      return;
    }
    const t = toast({ kind: 'info', title: '正在导入整合包', message: `${file.name} · ${fmtBytes(file.size)}`, timeout: 0 });
    try {
      const buf = await file.arrayBuffer();
      const meta = await api('/api/modpacks/upload', {
        method: 'POST', body: buf,
        headers: { 'x-filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
      });
      const r = await api('/api/modpacks/install', { method: 'POST', body: { path: meta.path, instanceId: null, name: meta.meta?.name || file.name } });
      toastOk('导入完成', r.name || meta.meta?.name || file.name);
      await loadState();
      location.hash = '#/instances';
    } catch (err) {
      toast({ kind: 'error', title: '导入失败', message: err.message, timeout: 8000 });
    }
  });
}

async function boot() {
  try {
    await loadState();
  } catch (e) {
    const bootEl = $('#boot');
    bootEl.querySelector('.boot-sub').textContent = '无法连接本地启动核心：' + e.message;
    return;
  }
  applyAppearance();
  applyHiddenPages();
  hydrateIcons();
  installNavTooltips();
  renderAccountChip();
  connectEvents();
  installSelectPicker();
  installEasterEggs();

  // nav
  for (const a of $$('#nav .nav-item')) {
    a.addEventListener('click', (e) => { e.preventDefault(); if (location.hash === a.getAttribute('href')) navigate(); else location.hash = a.getAttribute('href'); });
  }
  $('#btn-console').addEventListener('click', () => toggleConsole());
  $('#console-close').addEventListener('click', () => toggleConsole(false));
  $('#console-clear').addEventListener('click', () => { const t = consoleTabs.get(activeConsole); if (t) { t.lines = []; renderConsoleBody(); } });
  $('#account-chip').addEventListener('click', (e) => { e.stopPropagation(); openAccountMenu(); });
  document.addEventListener('click', (e) => {
    const menu = $('#account-menu');
    if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'account-chip') menu.hidden = true;
  });
  $('#btn-back').addEventListener('click', () => { location.hash = '#/instances'; });

  // 桌面版无边框窗口控制
  if (window.desktopWindow) {
    const wc = $('#window-controls');
    if (wc) {
      wc.hidden = false;
      $('#win-min').addEventListener('click', () => window.desktopWindow.minimize());
      $('#win-max').addEventListener('click', () => window.desktopWindow.toggleMaximize());
      $('#win-close').addEventListener('click', () => window.desktopWindow.close());
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleConsole(); }
    if (e.key === 'F5') { e.preventDefault(); loadState().then(() => renderAccountChip()); }
  });
  // 内部链接/按钮/图片不允许原生拖拽，避免把本地 URL 拖到浏览器打开。
  document.addEventListener('dragstart', (e) => {
    if (e.target.closest('a, button, img, .nav-item')) e.preventDefault();
  });
  window.addEventListener('hashchange', () => navigate());
  const pauseBtn = $('#task-mini-pause');
  const taskBox = $('#task-mini');
  if (taskBox) {
    taskBox.addEventListener('click', (e) => {
      if (e.target.closest('#task-mini-pause')) return;
      const id = taskBox.dataset.taskId;
      if (id) openTaskDetail(id);
    });
  }
  if (pauseBtn) {
    pauseBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = $('#task-mini')?.dataset.taskId;
      if (!id) return;
      pauseBtn.disabled = true;
      try {
        await api(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
        state.tasks.delete(id);
        renderTaskMini();
        toast({ kind: 'info', title: '已取消下载', message: '已下载的文件会保留，重新安装会继续。', timeout: 5000 });
      } catch (err) {
        toast({ kind: 'error', title: '取消失败', message: err.message, timeout: 5000 });
      } finally { pauseBtn.disabled = false; }
    });
  }
  wireEvents();
  setupDropImport();
  await navigate();
  $('#boot').classList.add('hide');
  setTimeout(() => { $('#boot').style.display = 'none'; }, 400);
  setTimeout(showWelcomeIfNeeded, 700);
  setTimeout(() => {
    if (!state.settings.autoCheckUpdate || !state.settings.updateFeedUrl) return;
    api('/api/update/check').then((r) => {
      if (r.hasUpdate) toast({ kind: 'info', title: `发现新版本 ${r.latest}`, message: '可在「设置 → 更新」查看并下载。', timeout: 9000 });
    }).catch(() => {});
  }, 3000);
  // 空闲时预加载页面模块，切换页面更跟手。
  setTimeout(() => { for (const load of Object.values(PAGES)) load().catch(() => {}); }, 1500);
}

document.addEventListener('DOMContentLoaded', boot);

export { navigate };
