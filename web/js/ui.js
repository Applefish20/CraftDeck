/* ================= 工具与通用 UI ================= */
import { icon as iconSvg } from './icons.js';
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 轻量元素构造器 */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const frag = (...nodes) => {
  const f = document.createDocumentFragment();
  for (const n of nodes.flat(Infinity)) if (n !== null && n !== undefined && n !== false) f.append(n instanceof Node ? n : document.createTextNode(String(n)));
  return f;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n ?? 0);
}
export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fmtRelative(ts) {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 86400000 * 30) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtDate(ts);
}
export function fmtDuration(ms) {
  if (!ms || ms < 0) return '0 分钟';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
export function fmtAgo(ms) {
  if (ms === null || ms === undefined) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
}

export function hueFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}
export function gradientFor(str) {
  const h = hueFromString(String(str));
  return `linear-gradient(135deg, hsl(${h} 62% 30%), hsl(${(h + 48) % 360} 58% 22%))`;
}
export function cleanMotd(text) {
  if (!text) return '';
  return String(text)
    .replace(/§[0-9a-fk-orx]/gi, '')
    .replace(/\\u00a7[0-9a-fk-orx]/gi, '')
    .replace(/§#?[0-9a-f]{6}/gi, '')
    .trim();
}

/* ---------- Toast ---------- */
const ICONS = { success: 'check', error: 'close', warn: 'alert', info: 'spark' };
export function toast({ kind = 'info', title = '', message = '', timeout = 4200 } = {}) {
  const root = $('#toast-root');
  if (!root) return;
  const el = h('div', { class: `toast ${kind}` }, [
    h('span', { class: 't-ico', html: iconSvg(ICONS[kind] || 'spark', 18) }),
    h('div', { class: 'grow' }, [
      h('div', { class: 't-title' }, title),
      message ? h('div', { class: 't-msg' }, message) : null,
    ]),
    h('button', { class: 't-close', title: '关闭', html: iconSvg('close', 14), onclick: () => el.remove() }),
  ]);
  root.append(el);
  if (timeout > 0) setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(24px)'; el.style.transition = 'all .25s'; setTimeout(() => el.remove(), 260); }, timeout);
  return el;
}
export const toastOk = (title, msg) => toast({ kind: 'success', title, message: msg });
export const toastErr = (title, msg) => toast({ kind: 'error', title, message: msg, timeout: 6500 });
export const toastWarn = (title, msg) => toast({ kind: 'warn', title, message: msg, timeout: 5500 });

/* ---------- Modal ---------- */
export function modal({ title, body, actions = [], wide = false, onClose = null, footer = true }) {
  const root = $('#modal-root');
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const footerEl = footer ? h('div', { class: 'modal-foot' },
    actions.map((a) => h('button', {
      class: `btn ${a.kind ? 'btn-' + a.kind : ''}`,
      onclick: async (ev) => {
        if (a.onClick) {
          try {
            const r = await a.onClick(ev, close);
            if (r === false) return;
          } catch (e) { toastErr('操作失败', e.message); return; }
        }
        if (a.keepOpen) return;
        close();
      },
    }, a.label))
  ) : null;
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, onclick: (e) => e.stopPropagation() }, [
    h('div', { class: 'modal-head' }, [
      h('h3', {}, title || ''),
      h('button', { class: 'icon-btn', html: iconSvg('close', 14), onclick: close }),
    ]),
    h('div', { class: 'modal-body' }, Array.isArray(body) ? body : [body]),
    footerEl,
  ]);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: close }, box);
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  return { close, el: box };
}

export function confirmDialog({ title = '确认操作', message = '', okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: h('div', { class: 'dim', style: { lineHeight: '1.7', fontSize: '13px' } }, message),
      actions: [
        { label: '取消', onClick: () => { done = true; resolve(false); } },
        { label: okText, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function promptDialog({ title = '请输入', label = '', value = '', placeholder = '', okText = '确定', multiline = false } = {}) {
  return new Promise((resolve) => {
    let input;
    let done = false;
    input = multiline
      ? h('textarea', { class: 'textarea', placeholder, rows: 4 }, value)
      : h('input', { class: 'input', placeholder, value });
    const finish = (v) => { done = true; resolve(v); };
    modal({
      title,
      body: h('div', { class: 'field' }, [label ? h('label', {}, label) : null, input]),
      actions: [
        { label: '取消', onClick: () => finish(null) },
        { label: okText, kind: 'primary', onClick: () => finish(input.value) },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => input && input.focus(), 60);
  });
}

/* ---------- 状态组件 ---------- */
export function emptyState({ icon = '▢', title = '暂无内容', sub = '', action = null } = {}) {
  const EMPTY_ICONS = {
    '☺': 'account', '▦': 'cube', '▤': 'logs', '▧': 'palette', '✦': 'puzzle',
    '☀': 'spark', '◈': 'package', '⌂': 'hosts', '!': 'alert', '▢': 'spark',
  };
  const iconName = EMPTY_ICONS[icon];
  return h('div', { class: 'empty' }, [
    h('div', { class: 'e-icon' }, iconName ? h('span', { html: iconSvg(iconName, 30, 'empty-svg') }) : icon),
    h('div', { class: 'e-title' }, title),
    sub ? h('div', { class: 'e-sub' }, sub) : null,
    action || null,
  ]);
}

export function loadingBlock(text = '加载中…') {
  return h('div', { class: 'loading-inline' }, [h('div', { class: 'spinner' }), text]);
}

export function skeletonCards(n = 6, height = 96) {
  return h('div', { class: 'mod-grid' }, Array.from({ length: n }, () => h('div', { class: 'skeleton', style: { height: height + 'px' } })));
}

export function iconImg(url, fallback = '▢', cls = 'mod-icon') {
  const box = h('div', { class: cls });
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', onerror: () => { img.remove(); box.textContent = fallback; } });
    box.append(img);
  } else box.textContent = fallback;
  return box;
}

export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }

export function switchEl(checked, onChange, label = '') {
  const input = h('input', { type: 'checkbox', checked: !!checked, onchange: () => onChange && onChange(input.checked) });
  const el = h('label', { class: 'switch' }, [input, h('span', { class: 'track' }), label ? h('span', { class: 'switch-label' }, label) : null]);
  el.querySelector('input').checked = !!checked;
  return el;
}

export function rangeRow({ min = 0, max = 100, step = 1, value = 0, suffix = '', onChange, format }) {
  const val = h('span', { class: 'val' }, (format ? format(value) : value) + suffix);
  const input = h('input', { type: 'range', min, max, step, value, oninput: () => {
    const v = Number(input.value);
    val.textContent = (format ? format(v) : v) + suffix;
    input.style.setProperty('--range-pct', `${Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100))}%`);
    onChange && onChange(v);
  } });
  input.style.setProperty('--range-pct', `${Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))}%`);
  return h('div', { class: 'range-row' }, [input, val]);
}

export function tabs(items, active, onPick) {
  const el = h('div', { class: 'tabs' });
  for (const it of items) {
    const b = h('button', { class: `tab ${it.key === active ? 'active' : ''}`, onclick: () => onPick(it.key) }, it.label);
    el.append(b);
  }
  el.__setActive = (key) => { for (const b of el.children) b.classList.toggle('active', b.dataset.k === key); };
  for (let i = 0; i < items.length; i++) el.children[i].dataset.k = items[i].key;
  return el;
}

export function sectionTitle(title, right = null) {
  return h('div', { class: 'section-title' }, [h('h2', {}, title), right || h('span')]);
}

export function kvList(pairs) {
  return h('div', { class: 'detail-list' }, pairs.filter(Boolean).map(([k, v]) => h('div', { class: 'detail-item' }, [
    h('span', { class: 'dk' }, k), h('span', { class: 'dv' }, v ?? '—'),
  ])));
}

export function progressBar(percent = 0, cls = '') {
  return h('div', { class: `progress ${cls}` }, h('i', { style: { width: Math.max(0, Math.min(100, percent * 100)) + '%' } }));
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toastOk('已复制', String(text).slice(0, 120))).catch(() => toastErr('复制失败', '浏览器拒绝访问剪贴板'));
}

export function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function timeGreeting() {
  const hnow = new Date().getHours();
  if (hnow < 5) return '夜深了';
  if (hnow < 11) return '早上好';
  if (hnow < 14) return '中午好';
  if (hnow < 18) return '下午好';
  return '晚上好';
}

export function loaderLabel(loader) {
  if (!loader || loader.type === 'vanilla') return '原版';
  const map = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
  return `${map[loader.type] || loader.type}${loader.version ? ' ' + loader.version : ''}`;
}

export function avatarEl(account, size = '') {
  const el = h('div', { class: `avatar ${size}` });
  if (!account) { el.textContent = '?'; return el; }
  const letter = (account.username || '?').slice(0, 1).toUpperCase();
  el.textContent = letter;
  if (account.id && (account.type === 'microsoft' || account.type === 'thirdparty')) {
    // 与账户页保持一致：从真实皮肤裁头部，不显示默认 Steve/Alex。
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
        el.textContent = '';
        el.append(canvas);
      } catch { /* keep letter */ }
    };
    img.onerror = () => { /* keep letter */ };
    img.src = `/api/accounts/${encodeURIComponent(account.id)}/skin`;
    return el;
  }
  if (account.id) {
    const img = h('img', { src: `/api/accounts/${account.id}/avatar`, alt: '', onerror: () => { img.remove(); el.textContent = letter; } });
    el.textContent = '';
    el.append(img);
  } else if (account.skinUrl) {
    const img = h('img', { src: account.skinUrl, alt: '', onerror: () => { img.remove(); el.textContent = letter; } });
    el.textContent = '';
    el.append(img);
  }
  return el;
}
