/**
 * 极简 DOM 桩：用于在没有浏览器的情况下冒烟测试界面页面模块。
 * 只实现页面代码实际用到的那部分 DOM API（树、class、style、选择器、事件）。
 */

class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
  remove() { detach(this); }
}

class Fragment {
  constructor() { this.nodeType = 11; this.children = []; }
  append(...nodes) { for (const n of nodes.flat(Infinity)) this.children.push(n instanceof TextNode ? n : n); }
}

function detach(node) {
  const p = node.parentNode;
  if (!p) return;
  const i = p.children.indexOf(node);
  if (i >= 0) p.children.splice(i, 1);
  node.parentNode = null;
}

function tokenize(sel) {
  return String(sel).trim().split(/\s+/).map((part) => {
    const m = { tag: null, id: null, cls: [], attrs: [] };
    const re = /([.#]?[A-Za-z0-9_-]+|\[[^\]]+\])/g;
    let x;
    while ((x = re.exec(part))) {
      const t = x[1];
      if (t.startsWith('#')) m.id = t.slice(1);
      else if (t.startsWith('.')) m.cls.push(t.slice(1));
      else if (t.startsWith('[')) m.attrs.push(t.slice(1, -1).split('=').map((s) => s.replace(/["']/g, '')));
      else m.tag = t.toUpperCase();
    }
    return m;
  });
}

function matches(el, m) {
  if (el.nodeType !== 1) return false;
  if (m.tag && el.tagName !== m.tag) return false;
  if (m.id && el.id !== m.id) return false;
  for (const c of m.cls) if (!String(el.className || '').split(/\s+/).includes(c)) return false;
  for (const [k, v] of m.attrs) {
    if (!(k in el) && el.getAttribute(k) === null) return false;
    if (v !== undefined && String(el.getAttribute(k)) !== v) return false;
  }
  return true;
}

function descendants(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.nodeType === 1) { out.push(c); walk(c); }
    }
  };
  walk(root);
  return out;
}

function selectAll(root, selector) {
  const parts = tokenize(selector);
  const last = parts[parts.length - 1];
  const cands = descendants(root).filter((el) => matches(el, last));
  if (parts.length === 1) return cands;
  return cands.filter((el) => {
    let idx = parts.length - 2;
    let p = el.parentNode;
    while (p && idx >= 0) {
      if (matches(p, parts[idx])) idx--;
      p = p.parentNode;
    }
    return idx < 0;
  });
}

class ClassList {
  constructor(el) { this.el = el; }
  _list() { return String(this.el.className || '').split(/\s+/).filter(Boolean); }
  _set(list) { this.el.className = [...new Set(list)].join(' '); }
  add(...c) { this._set([...this._list(), ...c]); }
  remove(...c) { this._set(this._list().filter((x) => !c.includes(x))); }
  toggle(c, force) {
    const has = this._list().includes(c);
    const on = force === undefined ? !has : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
  contains(c) { return this._list().includes(c); }
}

class El {
  constructor(tag, doc) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.id = '';
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.style = new Proxy({ setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } }, {
      set(t, k, v) { t[k] = v; return true; },
      get(t, k) { return k in t ? t[k] : ''; },
    });
    this.dataset = {};
    this._text = '';
    this._listeners = {};
  }
  get classList() { return new ClassList(this); }
  set classList(v) { this.className = v; }
  get childrenElements() { return this.children.filter((c) => c.nodeType === 1); }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children.find((c) => c.nodeType === 1) || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent || '').join('');
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  get innerHTML() { return this._text; }
  set innerHTML(v) { this.children = []; this._text = v === '' ? '' : String(v); }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  append(...nodes) {
    for (const n of nodes.flat(Infinity)) {
      if (n === null || n === undefined || n === false) continue;
      const node = n instanceof TextNode ? n : typeof n === 'object' ? n : new TextNode(n);
      if (node.nodeType === 11) { this.append(...node.children); continue; }
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  prepend(...nodes) {
    const tmp = new El('div', this.ownerDocument);
    tmp.append(...nodes);
    for (const c of tmp.children.reverse()) { c.parentNode = this; this.children.unshift(c); }
  }
  before() {}
  after() {}
  remove() { detach(this); }
  removeChild(n) { detach(n); return n; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'hidden') this.hidden = true;
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, evt = {}) { for (const fn of this._listeners[type] || []) fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...evt }); }
  querySelector(sel) { return selectAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return selectAll(this, sel); }
  closest(sel) {
    const parts = tokenize(sel);
    let p = this;
    while (p) {
      if (p.nodeType === 1 && matches(p, parts[parts.length - 1])) return p;
      p = p.parentNode;
    }
    return null;
  }
  focus() {}
  blur() {}
  click() { this.dispatch('click'); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollTo() {}
  get scrollTop() { return 0; }
  set scrollTop(v) {}
  get scrollHeight() { return 0; }
  get clientHeight() { return 0; }
}

export function installDom() {
  const doc = new El('#document', null);
  doc.nodeType = 9;
  const body = new El('body', doc);
  doc.append(body);
  doc.body = body;
  doc.documentElement = new El('html', doc);
  doc.createElement = (tag) => new El(tag, doc);
  doc.createTextNode = (t) => new TextNode(t);
  doc.createDocumentFragment = () => new Fragment();
  doc.getElementById = (id) => descendants(doc).find((e) => e.id === id) || null;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);

  // 页面脚本会直接引用的固定节点
  for (const id of ['bg-layer', 'bg-image', 'bg-dim', 'view', 'nav', 'toast-root', 'modal-root', 'account-menu',
    'console-panel', 'console-tabs', 'console-body', 'task-mini', 'task-mini-label', 'task-mini-pct', 'task-mini-bar',
    'account-chip', 'account-name', 'account-avatar', 'page-title', 'page-sub', 'btn-back', 'btn-console',
    'console-close', 'console-clear', 'boot', 'brand', 'mem-value']) {
    const el = new El('div', doc);
    el.id = id;
    if (id === 'boot') el.append(new El('div', doc));
    body.append(el);
  }
  const bootSub = new El('div', doc);
  bootSub.className = 'boot-sub';
  doc.getElementById('boot').append(bootSub);

  const win = {
    document: doc,
    location: { hash: '#/instances', href: 'http://localhost/', reload() {}, assign() {} },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node-test' },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    open() { return null; },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.location = win.location;
  class NodeBase {}
  Object.setPrototypeOf(El.prototype, NodeBase.prototype);
  Object.setPrototypeOf(TextNode.prototype, NodeBase.prototype);
  Object.setPrototypeOf(Fragment.prototype, NodeBase.prototype);
  globalThis.Node = NodeBase;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });
  } catch { /* Node 内置 navigator 不可覆盖时忽略 */ }
  globalThis.EventSource = undefined;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  return { doc, win, El };
}
