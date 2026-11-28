/* 账户页：离线 / 微软正版 / 第三方登录与多账户管理 */
import {
  h, badge, toastOk, toastErr, toastWarn, modal, confirmDialog, promptDialog, copyText,
  loadingBlock, emptyState, sectionTitle, fmtRelative, fmtDate,
} from '../ui.js';
import { state, api, loadState, emit, patchSettings } from '../state.js';

const TYPE = { microsoft: ['正版', 'accent'], offline: ['离线', ''], thirdparty: ['第三方', 'violet'] };

function authPlatform(server) {
  try {
    const host = new URL(String(server || '')).hostname.toLowerCase();
    if (host.includes('littleskin')) return 'LittleSkin';
    if (host === 'localhost' || host === '127.0.0.1') return 'Blessing Skin（本机）';
    return host || '第三方皮肤站';
  } catch { return '第三方皮肤站'; }
}
const typeBadge = (t) => { const [l, k] = TYPE[t] || [t || '未知', '']; return badge(l, k); };
const AUTH_PRESETS = [
  ['LittleSkin', 'https://littleskin.cn/api/yggdrasil'],
  ['Blessing Skin（本机默认）', 'http://localhost:8080/api/yggdrasil'],
  ['自定义', 'custom'],
];
const callout = (kind, text, icon = 'i') =>
  h('div', { class: `callout ${kind}` }, [h('span', { class: 'c-icon' }, icon), h('div', {}, text)]);
let view = null;

let alive = true;
let msPollTimer = null;
let msModal = null;
let thirdPartyModal = null;

function clearMsPoll() { if (msPollTimer) { clearInterval(msPollTimer); msPollTimer = null; } }

function skinAvatar(account, size = '') {
  const el = h('div', { class: `avatar ${size}`.trim() });
  if (!account) { el.textContent = '?'; return el; }
  const letter = String(account.username || '?').slice(0, 1).toUpperCase();
  el.textContent = '';
  // 正版 / 第三方优先从实际皮肤裁头部，离线账户使用默认头像。
  if (account.type === 'microsoft' || account.type === 'thirdparty') {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    canvas.className = 'avatar-skin-head';
    const img = new Image();
    img.onload = () => {
      try {
        const g = canvas.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 8, 8, 8, 8, 0, 0, 64, 64);
        g.drawImage(img, 40, 8, 8, 8, 0, 0, 64, 64);
        el.append(canvas);
      } catch { el.textContent = letter; }
    };
    img.onerror = () => { el.textContent = letter; };
    img.src = `/api/accounts/${encodeURIComponent(account.id)}/skin`;
    return el;
  }
  const img = h('img', {
    src: `/api/accounts/${encodeURIComponent(account.id)}/avatar`, alt: '', loading: 'lazy',
    onerror: () => { img.remove(); el.textContent = letter; },
  });
  el.append(img);
  return el;
}

async function syncAccounts() {
  try {
    await loadState();
    emit({ type: 'settings' }); // 同步顶栏账户徽标
  } catch { /* 后端暂不可用时沿用缓存 */ }
}

/* ---------------- 账户操作 ---------------- */
async function selectAccount(account, ctx, card) {
  if (!account || account.id === state.settings.lastAccountId) return;
  card.style.opacity = '.6';
  card.style.pointerEvents = 'none';
  try {
    await patchSettings({ lastAccountId: account.id });
    toastOk('已切换账户', account.username);
    ctx.refresh();
  } catch (e) {
    card.style.opacity = '';
    card.style.pointerEvents = '';
    toastErr('切换账户失败', e.message);
  }
}

async function refreshAccount(account, btn, ctx) {
  if (!btn || btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(account.id)}/refresh`, { method: 'POST' });
    toastOk('账户已刷新', (r && r.username) || account.username);
    ctx.refresh();
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    toastErr('刷新令牌失败', e.message);
  }
}

async function deleteAccount(account, btn, ctx) {
  if (!btn || btn.disabled) return;
  const ok = await confirmDialog({
    title: '删除账户',
    message: `确定要删除账户「${account.username}」吗？保存在本机的登录令牌会一并移除，此操作无法撤销。`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '删除中…';
  try {
    await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
    toastOk('已删除账户', account.username);
    ctx.refresh();
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    toastErr('删除账户失败', e.message);
  }
}

async function addOffline(ctx, btn) {
  if (btn) btn.disabled = true;
  try {
    const input = await promptDialog({
      title: '添加离线账户', label: '游戏用户名（3-16 位字母、数字或下划线）',
      placeholder: 'Steve', okText: '添加',
    });
    if (input === null) return;
    const username = String(input).trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) { toastErr('用户名不合法', '需要 3-16 位字母、数字或下划线'); return; }
    await api('/api/accounts/offline', { method: 'POST', body: { username } });
    toastOk('已添加离线账户', username);
    ctx.refresh();
  } catch (e) {
    toastErr('添加离线账户失败', e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------- 微软设备码登录 ---------------- */
function openMicrosoftModal(info, ctx) {
  clearMsPoll();
  let closed = false;
  let inFlight = false;
  const status = h('div', { class: 'hint', style: { textAlign: 'center' } }, '正在等待你在浏览器中完成登录…');
  const code = h('div', {
    class: 'mono',
    style: {
      fontSize: '30px', fontWeight: '800', letterSpacing: '5px', textAlign: 'center', padding: '16px 8px',
      background: 'rgba(0,0,0,.3)', border: '1px solid var(--line-strong)', borderRadius: '12px',
      userSelect: 'all', wordBreak: 'break-all',
    },
  }, info.userCode || '—');

  const poll = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const r = await api('/api/accounts/microsoft/poll', { method: 'POST', body: { deviceCode: info.deviceCode } });
      if (closed) return;
      if (r && r.status === 'ok') {
        clearMsPoll();
        toastOk('微软登录成功', (r.account && r.account.username) || '已添加账户');
        if (msModal) msModal.close();
        if (alive) ctx.refresh();
        return;
      }
      if (r && r.status === 'error') {
        clearMsPoll();
        status.className = 'callout err';
        status.textContent = r.error || '登录失败，请关闭后重新开始';
        toastErr('微软登录失败', r.error || '请重新开始微软登录');
        return;
      }
      status.textContent = (r && r.message) || '等待你在浏览器中完成登录（每 5 秒自动检查）…';
    } catch (e) {
      if (closed) return;
      clearMsPoll();
      status.className = 'callout err';
      status.textContent = '轮询失败：' + e.message;
      toastErr('微软登录失败', e.message);
    } finally {
      inFlight = false;
    }
  };

  msModal = modal({
    title: '微软正版登录',
    body: [
      h('div', { class: 'hint' }, '在浏览器中打开登录页面，输入下面的一次性代码完成登录：'),
      code,
      h('div', { class: 'row', style: { justifyContent: 'center', gap: '8px' } }, [
        h('button', {
          class: 'btn btn-primary',
          onclick: () => {
            const uri = info.verificationUri || 'https://microsoft.com/devicelogin';
            if (!window.open(uri, '_blank')) toastWarn('弹窗被拦截', '请手动打开 ' + uri);
          },
        }, '打开登录页面'),
        h('button', { class: 'btn', onclick: () => copyText(info.userCode || '') }, '复制代码'),
      ]),
      status,
      h('div', { class: 'hint', style: { textAlign: 'center' } },
        `代码有效期约 ${Math.max(1, Math.round((Number(info.expiresIn) || 900) / 60))} 分钟 · 每 5 秒自动检查一次，完成后会自动关闭此窗口`),
    ],
    actions: [{ label: '取消', onClick: () => { closed = true; clearMsPoll(); } }],
    onClose: () => { closed = true; clearMsPoll(); msModal = null; },
  });
  msPollTimer = setInterval(poll, 5000);
}

async function startMicrosoft(ctx, btn) {
  if (!btn || btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '正在请求设备码…';
  try {
    const info = await api('/api/accounts/microsoft/start', { method: 'POST' });
    if (!alive) return;
    if (!info || !info.deviceCode) throw new Error('服务端未返回设备码，请确认已配置微软客户端 ID');
    openMicrosoftModal(info, ctx);
  } catch (e) {
    toastErr('微软登录启动失败', e.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/* ---------------- 第三方（authlib-injector）登录 ---------------- */
function openThirdPartyModal(ctx, initialUrl = '') {
  const field = (label, control, hint) => h('div', { class: 'field' }, [
    h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null,
  ]);
  const server = h('input', { class: 'input mono', value: AUTH_PRESETS[0][1], placeholder: 'https://example.com/api/yggdrasil' });
  const preset = h('select', {
    class: 'select',
    onchange: () => { if (preset.value === 'custom') { server.value = ''; server.focus(); } else server.value = preset.value; },
  }, AUTH_PRESETS.map(([label, value]) => h('option', { value }, label)));
  const username = h('input', { class: 'input', placeholder: '邮箱或用户名', autocomplete: 'username' });
  const password = h('input', { class: 'input', type: 'password', placeholder: '密码', autocomplete: 'current-password' });
  const model = h('select', { class: 'select' }, [
    h('option', { value: 'classic' }, 'Classic（经典）'), h('option', { value: 'slim' }, 'Slim（纤细）'),
  ]);

  const urlInput = h('input', { class: 'input mono', placeholder: 'https://皮肤站/api/yggdrasil?accessToken=…&username=…' });
  const urlDrop = h('div', { class: 'url-drop-zone' }, [
    h('div', { class: 'url-drop-title' }, '把第三方启动器给的登录网址拖到这里'),
    h('div', { class: 'hint' }, '支持 authlib-injector / Yggdrasil 的完整回调网址，拖入或粘贴后按回车。'),
    urlInput,
  ]);
  const handleUrl = async (raw) => {
    const value = String(raw || '').trim();
    if (!value) return;
    // authlib-injector 的 ALI 拖拽格式：只包含服务器地址，不包含密码。
    if (/^authlib-injector:yggdrasil-server:/i.test(value)) {
      try {
        const target = decodeURIComponent(value.replace(/^authlib-injector:yggdrasil-server:/i, ''));
        server.value = target;
        preset.value = 'custom';
        urlDrop.classList.remove('drag');
        toast({ kind: 'info', title: '已导入外置登录服务器', message: `${target}\n这是服务器地址，还需要补一次账号密码。`, timeout: 6500 });
        username.focus();
      } catch {
        toastErr('网址格式不正确', '无法解析 authlib-injector 地址');
      }
      return;
    }
    // LittleSkin 个人主页本身不携带登录令牌，只能识别平台并预填服务器。
    if (/^https?:\/\/([^/]+\.)?littleskin\.cn\//i.test(value) && !/[?&#](accessToken|access_token|token)=/i.test(value)) {
      server.value = 'https://littleskin.cn/api/yggdrasil';
      preset.value = 'https://littleskin.cn/api/yggdrasil';
      urlDrop.classList.remove('drag');
      toast({ kind: 'info', title: '已识别 LittleSkin', message: '这个页面地址没有令牌，请补一下邮箱和密码；如果是从授权回调页拖入的带 token 网址，可以直接登录。', timeout: 6500 });
      username.focus();
      return;
    }
    try {
      urlDrop.classList.add('busy');
      const acc = await api('/api/accounts/thirdparty/url', { method: 'POST', body: { url: value } });
      toastOk('网址登录成功', (acc && acc.username) || '已添加账户');
      if (thirdPartyModal) thirdPartyModal.close();
      if (alive) ctx.refresh();
    } catch (e) {
      toastErr('网址登录失败', e.message);
    } finally { urlDrop.classList.remove('busy'); }
  };
  for (const ev of ['dragenter', 'dragover']) {
    urlDrop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); urlDrop.classList.add('drag'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    urlDrop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); urlDrop.classList.remove('drag'); });
  }
  urlDrop.addEventListener('drop', (e) => {
    const raw = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
    handleUrl(raw.split(/\r?\n/).find((x) => /^https?:\/\//i.test(x)) || raw);
  });
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleUrl(urlInput.value); } });

  const submit = async (ev, close) => {
    const btn = ev.currentTarget;
    if (btn.disabled) return false;
    const authServer = String(server.value || '').trim();
    const user = String(username.value || '').trim();
    const pass = String(password.value || '');
    if (!authServer) { toastErr('请填写认证服务器地址'); return false; }
    if (!/^https?:\/\//i.test(authServer)) { toastErr('地址格式不正确', '认证服务器地址需以 http:// 或 https:// 开头'); return false; }
    if (!user) { toastErr('请填写邮箱或用户名'); return false; }
    if (!pass) { toastErr('请填写密码'); return false; }
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const acc = await api('/api/accounts/thirdparty', {
        method: 'POST', body: { authServer, username: user, password: pass, skinModel: model.value },
      });
      toastOk('第三方登录成功', (acc && acc.username) || user);
      close();
      if (alive) ctx.refresh();
    } catch (e) {
      btn.disabled = false; btn.textContent = '登录';
      toastErr('第三方登录失败', e.message);
    }
    return false;
  };

  if (thirdPartyModal) thirdPartyModal.close();
  thirdPartyModal = modal({
    title: '第三方账户登录',
    body: [
      h('div', { class: 'hint' }, '支持 LittleSkin、Blessing Skin 等兼容 authlib-injector / Yggdrasil 协议的皮肤站。'),
      urlDrop,
      h('div', { class: 'hint', style: { margin: '10px 0 2px' } }, '或者使用账号密码登录：'),
      field('认证服务器地址', server), field('常用预设', preset), field('邮箱 / 用户名', username),
      field('密码', password), field('皮肤模型', model),
      h('div', { class: 'hint' }, '密码仅用于向认证服务器换取令牌，不会保存在启动器配置中。'),
    ],
    actions: [{ label: '取消' }, { label: '登录', kind: 'primary', onClick: submit }],
    onClose: () => { thirdPartyModal = null; },
  });
  if (initialUrl) setTimeout(() => handleUrl(initialUrl), 80);
}

async function changeAvatar(account, ctx) {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } });
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) { input.remove(); return; }
    try {
      const buf = await file.arrayBuffer();
      await api(`/api/accounts/${account.id}/avatar`, {
        method: 'POST', body: buf,
        headers: { 'Content-Type': file.type || 'image/png' },
      });
      toastOk('头像已更新', account.username);
      await loadState();
      ctx.refresh();
    } catch (e) { toastErr('头像更新失败', e.message); }
    finally { input.remove(); }
  };
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 20000);
}

/* ---------------- 渲染 ---------------- */
function accountCard(account, activeId, ctx) {
  const card = h('div', { class: `acct-card ${account.id === activeId ? 'selected' : ''}` }, [
    skinAvatar(account),
    h('div', { class: 'grow' }, [
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [
        h('span', { style: { fontWeight: '700', fontSize: '13.5px' } }, account.username || '未命名'),
        typeBadge(account.type),
        account.id === activeId ? badge('使用中', 'accent') : null,
      ]),
      h('div', { class: 'hint mono ellipsis', style: { marginTop: '3px' } }, account.uuid || '无 UUID'),
      account.authServer ? h('div', { class: 'hint ellipsis' }, account.type === 'thirdparty' ? `平台：${authPlatform(account.authServer)}` : account.authServer) : null,
    ]),
    h('div', { class: 'col', style: { gap: '5px' } }, [
      h('button', { class: 'btn btn-sm', onclick: (ev) => { ev.stopPropagation(); changeAvatar(account, ctx); } }, '头像'),
      h('button', { class: 'btn btn-sm', onclick: (ev) => { ev.stopPropagation(); refreshAccount(account, ev.currentTarget, ctx); } }, '刷新'),
      h('button', { class: 'btn btn-sm btn-danger', onclick: (ev) => { ev.stopPropagation(); deleteAccount(account, ev.currentTarget, ctx); } }, '删除'),
    ]),
  ]);
  card.addEventListener('click', () => selectAccount(account, ctx, card));
  return card;
}

function heroCard(account, ctx) {
  if (!account) {
    return h('div', { class: 'account-hero card' }, [
      h('div', { class: 'avatar xl' }, '?'),
      h('div', { class: 'ah-info' }, [
        h('div', { class: 'ah-name' }, '尚未登录'),
        h('div', { class: 'ah-sub' }, '添加一个账户后即可启动游戏。离线账户同样可以游玩。'),
      ]),
      h('div', { class: 'hero-actions', style: { flexWrap: 'wrap' } }, [
        h('button', { class: 'btn btn-primary', onclick: (ev) => addOffline(ctx, ev.currentTarget) }, '离线账户'),
        h('button', { class: 'btn', onclick: (ev) => startMicrosoft(ctx, ev.currentTarget) }, '微软正版'),
        h('button', { class: 'btn', onclick: () => openThirdPartyModal(ctx) }, '第三方登录'),
      ]),
    ]);
  }
  return h('div', { class: 'account-hero card' }, [
    skinAvatar(account, 'xl'),
    h('div', { class: 'ah-info' }, [
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
        h('div', { class: 'ah-name' }, account.username || '未命名'),
        typeBadge(account.type),
        account.id === state.settings.lastAccountId ? badge('使用中', 'accent') : null,
      ]),
      h('div', { class: 'ah-sub mono' }, `UUID: ${account.uuid || '—'}`),
      h('div', { class: 'ah-sub' },
        `添加于 ${fmtRelative(account.createdAt)}` + (account.authServer ? ` · 平台：${authPlatform(account.authServer)}` : '') +
        (account.expiresAt ? ` · 令牌到期 ${fmtDate(account.expiresAt)}` : '')),
    ]),
    h('div', { class: 'hero-actions' }, [
      h('button', { class: 'btn btn-sm', onclick: (ev) => changeAvatar(account, ctx) }, '更换头像'),
      account.type !== 'offline'
        ? h('button', { class: 'btn btn-sm', onclick: (ev) => refreshAccount(account, ev.currentTarget, ctx) }, '刷新令牌') : null,
      h('button', { class: 'btn btn-sm btn-danger', onclick: (ev) => deleteAccount(account, ev.currentTarget, ctx) }, '删除账户'),
    ]),
  ]);
}

function loginCard(icon, title, desc, action) {
  return h('div', { class: 'card pad hover col', style: { gap: '9px' } }, [
    h('div', { class: 'row', style: { gap: '9px' } }, [
      h('div', { class: 'inst-icon', style: { marginTop: '0', width: '38px', height: '38px', fontSize: '18px' } }, icon),
      h('div', { class: 'panel-title' }, title),
    ]),
    h('div', { class: 'hint', style: { lineHeight: '1.6', flex: '1', minHeight: '44px' } }, desc),
    action,
  ]);
}

async function render(el, ctx) {
  view = el;
  alive = true;
  view.replaceChildren(loadingBlock('正在读取账户信息…'));
  await syncAccounts();
  if (!alive) return;

  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const active = accounts.find((a) => a.id === state.settings.lastAccountId) || accounts[0] || null;
  state.activeAccount = active;

  const list = accounts.length
    ? h('div', { class: 'acct-grid' }, accounts.map((a) => accountCard(a, active && active.id, ctx)))
    : h('div', { class: 'panel' }, emptyState({ icon: '☺', title: '还没有账户', sub: '挑一种登录方式，把第一位玩家请进来。' }));

  const loginGrid = h('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '14px' },
  }, [
    loginCard('⌨', '离线账户', '只需一个用户名，适合单人游戏或离线服务器。UUID 由用户名派生。',
      h('button', { class: 'btn btn-primary btn-block', onclick: (ev) => addOffline(ctx, ev.currentTarget) }, '添加离线账户')),
    loginCard('☁', '微软正版', '使用微软账户 OAuth 设备码登录，可访问正版服务器与皮肤。',
      h('button', { class: 'btn btn-primary btn-block', onclick: (ev) => startMicrosoft(ctx, ev.currentTarget) }, '微软正版登录')),
    loginCard('☷', '第三方账户', '支持 LittleSkin、Blessing Skin 等基于 authlib-injector 的皮肤站。',
      h('button', { class: 'btn btn-primary btn-block', onclick: () => openThirdPartyModal(ctx) }, '第三方登录')),
  ]);

  view.replaceChildren(h('div', { class: 'home' }, [
    heroCard(active, ctx),
    sectionTitle('登录 / 添加账户', badge('3 种方式')),
    loginGrid,
    sectionTitle('全部账户', badge(`${accounts.length} 个`)),
    list,
    callout('info', '微软正版登录使用 OAuth 设备码流程：在浏览器中打开登录页面并输入一次性代码即可。所有登录令牌仅保存在本机数据目录，不会上传到任何服务器。'),
  ]));

  // 支持把第三方登录网址直接拖到账户页任意位置。
  view.ondragover = (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('text/uri-list') || [...(e.dataTransfer?.types || [])].includes('text/plain')) {
      e.preventDefault();
    }
  };
  view.ondrop = (e) => {
    const raw = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
    const url = raw.split(/\r?\n/).find((x) => /^(https?:\/\/|authlib-injector:)/i.test(x)) || raw.trim();
    if (!url) return;
    e.preventDefault();
    openThirdPartyModal(ctx, url);
  };
}

function destroy() {
  alive = false;
  clearMsPoll();
  if (view) { view.ondragover = null; view.ondrop = null; }
  if (msModal) { try { msModal.close(); } catch { /* ignore */ } msModal = null; }
  if (thirdPartyModal) { try { thirdPartyModal.close(); } catch { /* ignore */ } thirdPartyModal = null; }
}

export default { render, destroy };
