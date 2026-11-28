/* ================= 皮肤页 ================= */
import {
  h, toast, toastOk, toastErr, badge, emptyState, sectionTitle, loadingBlock, fmtBytes, copyText, confirmDialog, modal,
} from '../ui.js';
import { state, api, loadState, patchSettings } from '../state.js';
import { icon } from '../icons.js';

let view = null;
let ctxRef = null;
let accountId = null;
const autoImportedSkins = new Set();
let libItems = [];
let libPage = 1;
let libSort = 'latest';
let libType = '';
let libLoading = false;
let libError = '';
let libQuery = '';
let libHasMore = false;
let libRequestId = 0;
let busy = false;
let model = 'classic';
let previewMode = '3d';
let instanceId = null;
let mineItems = [];
let mineLoading = false;
let mineError = '';
let libraryTab = 'mine';

function accounts() { return state.accounts || []; }
function current() { return accounts().find((a) => a.id === accountId) || accounts()[0] || null; }
function currentInstance() {
  return state.instances.find((i) => i.id === (instanceId || state.settings.lastInstanceId)) || state.instances[0] || null;
}

async function refreshState() {
  await loadState();
  ctxRef.refresh();
}

async function detectSkinModel(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 64, 64);
    URL.revokeObjectURL(url);
    const alphaAt = (x, y) => g.getImageData(x, y, 1, 1).data[3];
    let empty = 0;
    for (let y = 20; y < 32; y += 1) for (let x = 54; x < 56; x += 1) if (alphaAt(x, y) < 8) empty += 1;
    return empty >= 16 ? 'slim' : 'classic';
  } catch { return model; }
}

async function uploadSkin(file) {
  const acc = current();
  if (!acc) { toastErr('没有账户', '请先在账户页添加账户'); return; }
  try {
    busy = true;
    const detected = await detectSkinModel(file);
    if (detected !== model) {
      model = detected;
      toast({ kind: 'info', title: `已自动识别为${model === 'slim' ? '纤细' : '经典'}模型`, message: '上传时会使用这个模型。' });
    }
    const buf = await file.arrayBuffer();
    const r = await api('/api/skins/upload', {
      method: 'POST', body: buf,
      headers: { 'x-account-id': acc.id, 'x-model': model, 'Content-Type': 'image/png' },
    });
    if (r.mojang && r.mojang !== 'ok') toast({ kind: 'warn', title: '本地已保存，但 Mojang 上传失败', message: r.mojang });
    else if (acc.type === 'thirdparty') {
      toast({ kind: 'warn', title: '已保存到启动器本地', message: '第三方皮肤要显示在游戏里，还需要在 LittleSkin 角色页上传同一张皮肤。', timeout: 7000 });
    } else toastOk('皮肤已保存', acc.type === 'microsoft' ? '已同步到正版账号' : '已应用到本地预览');
    await refreshState();
  } catch (e) { toastErr('上传失败', e.message); }
  finally { busy = false; }
}

async function fromUrl() {
  const acc = current(); if (!acc) return;
  const url = await new Promise((resolve) => {
    import('../ui.js').then(({ promptDialog }) => promptDialog({ title: '从网络下载皮肤', label: '皮肤 PNG 地址（64x64）', placeholder: 'https://example.com/skin.png' }).then(resolve));
  });
  if (!url) return;
  try {
    busy = true;
    const r = await api('/api/skins/from-url', { method: 'POST', body: { accountId: acc.id, url, model } });
    if (r.mojang && r.mojang !== 'ok') toast({ kind: 'warn', title: '本地已保存，Mojang 上传失败', message: r.mojang });
    else toastOk('皮肤已下载');
    await refreshState();
  } catch (e) { toastErr('下载失败', e.message); }
  finally { busy = false; }
}

async function fromMojang() {
  const acc = current(); if (!acc) return;
  const name = await new Promise((resolve) => {
    import('../ui.js').then(({ promptDialog }) => promptDialog({ title: '从正版用户名获取皮肤', label: '正版游戏 ID', placeholder: 'Notch' }).then(resolve));
  });
  if (!name) return;
  try {
    busy = true;
    const r = await api('/api/skins/from-mojang', { method: 'POST', body: { accountId: acc.id, username: name } });
    toastOk('已获取皮肤', r.username);
    await refreshState();
  } catch (e) { toastErr('获取失败', e.message); }
  finally { busy = false; }
}

async function applyToMojang() {
  const acc = current(); if (!acc) { toastErr('请先添加账户'); return; }
  if (acc.type !== 'microsoft') { toastErr('仅微软正版账户支持同步', '离线账户的皮肤只在启动器内预览'); return; }
  try {
    busy = true;
    await api('/api/skins/apply-mojang', { method: 'POST', body: { accountId: acc.id, model } });
    toastOk('已同步到 Mojang', '重新进入游戏或刷新皮肤即可看到');
  } catch (e) { toastErr('同步失败', e.message); }
  finally { busy = false; }
}

async function removeSkin() {
  const acc = current(); if (!acc) return;
  try {
    await api(`/api/skins/${acc.id}`, { method: 'DELETE' });
    toastOk('已移除本地皮肤');
    await refreshState();
  } catch (e) { toastErr('移除失败', e.message); }
}

async function loadLibrary(reset = true) {
  if (libLoading) return;
  libLoading = true;
  libError = '';
  if (reset) { libPage = 1; libItems = []; libHasMore = false; }
  const rid = ++libRequestId;
  renderPage();
  try {
    const q = new URLSearchParams({ page: String(libPage), sort: libSort });
    if (libType) q.set('type', libType);
    if (libQuery) q.set('q', libQuery);
    const r = await api('/api/skins/library?' + q.toString());
    if (rid !== libRequestId) return;
    libItems = reset ? (r.items || []) : [...libItems, ...(r.items || [])];
    libHasMore = !!r.hasMore;
    if (!libItems.length) libError = '没有取到皮肤，换一个分类试试。';
  } catch (e) {
    if (rid === libRequestId) libError = e.message || '无法连接 LittleSkin，请检查网络。';
  } finally {
    libLoading = false;
    renderPage();
  }
}

function setLibrary(sort, type) {
  libSort = sort; libType = type || '';
  loadLibrary(true);
}

async function applyLibrary(item) {
  const acc = current();
  if (!acc) { toastErr('请先添加账户'); return; }
  try {
    busy = true;
    const r = await api('/api/skins/library/apply', { method: 'POST', body: { accountId: acc.id, tid: item.tid } });
    toastOk('已应用皮肤', `${item.name} · LittleSkin`);
    if (r.account?.skinModel) model = r.account.skinModel;
    await refreshState();
  } catch (e) { toastErr('应用失败', e.message); }
  finally { busy = false; }
}

async function installSkinMod() {
  const inst = currentInstance();
  if (!inst) { toastErr('没有实例', '请先创建实例'); return; }
  try {
    busy = true;
    await api('/api/mods/install', {
      method: 'POST',
      body: {
        projectId: 'customskinloader',
        instanceId: inst.id,
        gameVersion: inst.versionId || undefined,
        loader: inst.loader?.type && inst.loader.type !== 'vanilla' ? inst.loader.type : undefined,
        withDependencies: true,
      },
    });
    toastOk('已安装 CustomSkinLoader', '进入游戏后可加载自定义皮肤');
  } catch (e) {
    toastErr('安装失败', e.message + '\n可到「模组」页搜索 CustomSkinLoader 手动安装');
  } finally { busy = false; }
}

function skinCanvas(src, w = 128, height = 256, cls = 'skin-img', model = 'classic') {
  const canvas = h('canvas', { class: cls, width: w, height });
  const img = new Image();
  img.onload = () => {
    try {
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      // 16x32 的正面人形，按宽度等比缩放；兼容 128x128 的 HD 皮肤。
      const S = w / 16;
      const F = img.width >= 128 ? 2 : 1;
      const slim = model === 'slim';
      const aw = slim ? 3 : 4;
      const parts = [
        [8, 8, 8, 8, 4, 0, 8, 8],         // head front
        [40, 8, 8, 8, 4, 0, 8, 8],        // hat overlay
        [20, 20, 8, 12, 4, 8, 8, 12],     // body
        [44, 20, aw, 12, slim ? 1 : 0, 8, aw, 12], // right arm
        [36, 52, aw, 12, 12, 8, aw, 12],  // left arm
        [4, 20, 4, 12, 4, 20, 4, 12],     // right leg
        [20, 52, 4, 12, 8, 20, 4, 12],    // left leg
      ];
      for (const [sx, sy, sw, sh, dx, dy, dw, dh] of parts) {
        ctx.drawImage(img, sx * F, sy * F, sw * F, sh * F, dx * S, dy * S, dw * S, dh * S);
      }
    } catch { /* ignore */ }
  };
  img.onerror = () => { canvas.style.opacity = '.25'; };
  img.src = src;
  return canvas;
}

function faceStyle(src, [sx, sy, sw, sh], fw, fh) {
  const bw = (64 * fw) / sw;
  const bh = (64 * fh) / sh;
  return {
    backgroundImage: `url("${src}")`,
    backgroundSize: `${bw}px ${bh}px`,
    backgroundPosition: `-${(sx * fw) / sw}px -${(sy * fh) / sh}px`,
  };
}

function cuboidPart({ src, w, height, d, x = 0, y = 0, z = 0, faces, cls = '' }) {
  const part = h('div', {
    class: `skin-cuboid ${cls}`,
    style: {
      width: w + 'px', height: height + 'px',
      transform: `translate3d(${x - w / 2}px, ${y - height / 2}px, ${z}px)`,
    },
  });
  const face = (desc, fw, fh, transform) => h('div', {
    class: 'skin-face',
    style: { width: fw + 'px', height: fh + 'px', ...faceStyle(src, desc, fw, fh), transform },
  });
  part.append(
    face(faces.front, w, height, `translate(-50%,-50%) translateZ(${d / 2}px)`),
    face(faces.back, w, height, `translate(-50%,-50%) rotateY(180deg) translateZ(${d / 2}px)`),
    face(faces.right, d, height, `translate(-50%,-50%) rotateY(90deg) translateZ(${w / 2}px)`),
    face(faces.left, d, height, `translate(-50%,-50%) rotateY(-90deg) translateZ(${w / 2}px)`),
    face(faces.top, w, d, `translate(-50%,-50%) rotateX(90deg) translateZ(${height / 2}px)`),
    face(faces.bottom, w, d, `translate(-50%,-50%) rotateX(-90deg) translateZ(${height / 2}px)`),
  );
  return part;
}

function skin3dLegacy(src, modelName) {
  const stage = h('div', { class: 'skin-stage' });
  try {
    const slim = modelName === 'slim';
    const armW = slim ? 3 : 4;
    const armX = slim ? 33 : 36;
    const U = 6;
    const head = {
      front: [8, 8, 8, 8], back: [24, 8, 8, 8], right: [0, 8, 8, 8],
      left: [16, 8, 8, 8], top: [8, 0, 8, 8], bottom: [16, 0, 8, 8],
    };
    const body = {
      front: [20, 20, 8, 12], back: [32, 20, 8, 12], right: [16, 20, 4, 12],
      left: [28, 20, 4, 12], top: [20, 16, 8, 4], bottom: [28, 16, 8, 4],
    };
    const hat = {
      front: [40, 8, 8, 8], back: [56, 8, 8, 8], right: [32, 8, 8, 8],
      left: [48, 8, 8, 8], top: [40, 0, 8, 8], bottom: [48, 0, 8, 8],
    };
    const jacket = {
      front: [20, 36, 8, 12], back: [32, 36, 8, 12], right: [16, 36, 4, 12],
      left: [28, 36, 4, 12], top: [20, 32, 8, 4], bottom: [28, 32, 8, 4],
    };
    const arm = (baseX, baseY) => ({
      front: [baseX, baseY, armW, 12], back: [baseX + 8, baseY, armW, 12],
      right: [baseX - 4, baseY, 4, 12], left: [baseX + 4, baseY, 4, 12],
      top: [baseX, baseY - 4, armW, 4], bottom: [baseX + 4, baseY - 4, armW, 4],
    });
    const leg = (baseX, baseY) => ({
      front: [baseX, baseY, 4, 12], back: [baseX + 8, baseY, 4, 12],
      right: [baseX - 4, baseY, 4, 12], left: [baseX + 4, baseY, 4, 12],
      top: [baseX, baseY - 4, 4, 4], bottom: [baseX + 4, baseY - 4, 4, 4],
    });
    const modelEl = h('div', { class: 'skin-model' });
    modelEl.append(
      cuboidPart({ src, w: 8 * U, height: 8 * U, d: 8 * U, y: -60, faces: head, cls: 'is-head' }),
      cuboidPart({ src, w: 8 * U + 2, height: 8 * U + 2, d: 8 * U + 2, y: -60, faces: hat, cls: 'is-hat' }),
      cuboidPart({ src, w: 8 * U, height: 12 * U, d: 4 * U, y: 0, faces: body, cls: 'is-body' }),
      cuboidPart({ src, w: 8 * U + 2, height: 12 * U + 2, d: 4 * U + 2, y: 0, faces: jacket, cls: 'is-jacket' }),
      cuboidPart({ src, w: armW * U, height: 12 * U, d: 4 * U, x: -armX, y: 0, faces: arm(44, 20), cls: 'is-arm' }),
      cuboidPart({ src, w: armW * U, height: 12 * U, d: 4 * U, x: armX, y: 0, faces: arm(36, 52), cls: 'is-arm' }),
      cuboidPart({ src, w: 4 * U, height: 12 * U, d: 4 * U, x: -12, y: 72, faces: leg(4, 20), cls: 'is-leg' }),
      cuboidPart({ src, w: 4 * U, height: 12 * U, d: 4 * U, x: 12, y: 72, faces: leg(20, 52), cls: 'is-leg' }),
    );
    stage.append(modelEl);
    let rotX = -4, rotY = -24, zoom = 1, drag = null, auto = true, lastMove = Date.now();
    const apply = (smooth = false) => {
      modelEl.style.transition = smooth ? 'transform .24s cubic-bezier(.2,.8,.2,1)' : 'none';
      modelEl.style.transform = `rotateX(${rotX}deg) rotateY(${rotY}deg) scale(${zoom})`;
    };
    apply();
    const controls = h('div', { class: 'skin-view-controls' }, [
      h('button', { type: 'button', onclick: () => { rotX = -2; rotY = 0; apply(true); lastMove = Date.now(); } }, '正面'),
      h('button', { type: 'button', onclick: () => { rotX = -2; rotY = 90; apply(true); lastMove = Date.now(); } }, '侧面'),
      h('button', { type: 'button', onclick: () => { rotX = -2; rotY = 180; apply(true); lastMove = Date.now(); } }, '背面'),
      h('button', {
        type: 'button', class: 'auto-on',
        onclick: (e) => { auto = !auto; e.currentTarget.classList.toggle('auto-on', auto); e.currentTarget.textContent = auto ? '自动旋转' : '已暂停'; lastMove = Date.now(); },
      }, '自动旋转'),
    ]);
    controls.addEventListener('pointerdown', (e) => e.stopPropagation());
    stage.append(controls, h('div', { class: 'skin-stage-hint' }, '拖动旋转 · 滚轮缩放'));
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom = Math.max(0.7, Math.min(1.5, zoom + (e.deltaY > 0 ? -0.06 : 0.06)));
      apply(true);
      lastMove = Date.now();
    }, { passive: false });
    const loop = (t) => {
      if (!stage.isConnected) return;
      if (!drag && auto && t - lastMove > 900) { rotY += 0.12; apply(false); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest?.('.skin-view-controls')) return;
      drag = { x: e.clientX, y: e.clientY, rx: rotX, ry: rotY };
      lastMove = Date.now();
      stage.classList.add('dragging');
      stage.setPointerCapture?.(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      rotY = drag.ry + (e.clientX - drag.x) * 0.45;
      rotX = Math.max(-32, Math.min(32, drag.rx - (e.clientY - drag.y) * 0.3));
      apply();
      lastMove = Date.now();
    });
    const endDrag = () => { drag = null; stage.classList.remove('dragging'); lastMove = Date.now(); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('pointerleave', endDrag);
  } catch (e) {
    console.error('skin3d', e);
    stage.replaceChildren(h('div', { class: 'skin-stage-loading' }, '3D 预览生成失败：' + (e.message || e)));
  }
  return stage;
}

function skin3d(src, modelName) {
  const stage = h('div', { class: 'skin-stage skin-stage-webgl' });
  const canvas = h('canvas', { class: 'skin-webgl-canvas' });
  stage.append(canvas);
  try {
    const SV = window.skinview3d;
    if (!SV?.SkinViewer) return skin3dLegacy(src, modelName);
    const viewer = new SV.SkinViewer({
      canvas,
      width: 420,
      height: 320,
      skin: src,
      model: modelName === 'slim' ? 'slim' : 'classic',
    });
    viewer.autoRotate = true;
    viewer.autoRotateSpeed = 0.55;
    viewer.animation = new SV.IdleAnimation();
    viewer.background = null;
    const resize = () => {
      if (!stage.isConnected) return;
      const w = Math.max(260, stage.clientWidth || 420);
      viewer.setSize(w, Math.max(280, stage.clientHeight || 320));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    const controls = h('div', { class: 'skin-view-controls' }, [
      h('button', { type: 'button', onclick: () => { viewer.autoRotate = false; viewer.playerWrapper.rotation.y = 0; } }, '正面'),
      h('button', { type: 'button', onclick: () => { viewer.autoRotate = false; viewer.playerWrapper.rotation.y = Math.PI / 2; } }, '侧面'),
      h('button', { type: 'button', onclick: () => { viewer.autoRotate = false; viewer.playerWrapper.rotation.y = Math.PI; } }, '背面'),
      h('button', {
        type: 'button', class: 'auto-on',
        onclick: (e) => {
          viewer.autoRotate = !viewer.autoRotate;
          e.currentTarget.classList.toggle('auto-on', viewer.autoRotate);
          e.currentTarget.textContent = viewer.autoRotate ? '暂停旋转' : '开始旋转';
        },
      }, '暂停旋转'),
    ]);
    controls.addEventListener('pointerdown', (e) => e.stopPropagation());
    stage.append(controls, h('div', { class: 'skin-stage-hint' }, '拖动旋转 · 滚轮缩放'));
    const timer = setInterval(() => {
      if (!stage.isConnected) {
        clearInterval(timer);
        try { ro.disconnect(); viewer.dispose(); } catch { /* ignore */ }
      }
    }, 1200);
  } catch (e) {
    console.error('skin3d webgl', e);
    return skin3dLegacy(src, modelName);
  }
  return stage;
}

function skin2dRender(src, modelName) {
  const stage = h('div', { class: 'skin-stage skin-stage-webgl skin-2d-webgl' });
  const canvas = h('canvas', { class: 'skin-webgl-canvas' });
  stage.append(canvas);
  try {
    const SV = window.skinview3d;
    if (!SV?.SkinViewer) return h('div', { class: 'skin-2d-stage' }, skinCanvas(src, 128, 256, 'skin-img skin-2d-img', modelName));
    const viewer = new SV.SkinViewer({
      canvas, width: 420, height: 320, skin: src,
      model: modelName === 'slim' ? 'slim' : 'classic',
    });
    viewer.autoRotate = false;
    viewer.controls.enabled = false;
    viewer.animation = null;
    viewer.background = null;
    viewer.playerWrapper.rotation.y = -0.18;
    const resize = () => {
      if (!stage.isConnected) return;
      viewer.setSize(Math.max(260, stage.clientWidth || 420), Math.max(280, stage.clientHeight || 320));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    const timer = setInterval(() => {
      if (!stage.isConnected) { clearInterval(timer); try { ro.disconnect(); viewer.dispose(); } catch { /* ignore */ } }
    }, 1200);
  } catch {
    return h('div', { class: 'skin-2d-stage' }, skinCanvas(src, 128, 256, 'skin-img skin-2d-img', modelName));
  }
  return stage;
}

function preview(acc) {
  const src = `/api/accounts/${acc.id}/skin?t=${Date.now()}`;
  return h('div', { class: 'skin-preview' }, [
    h('div', { class: 'row', style: { justifyContent: 'space-between', width: '100%' } }, [
      h('div', { class: 'panel-title' }, '皮肤预览'),
      h('div', { class: 'tabs', style: { padding: '2px' } }, [
        h('button', { class: `tab ${previewMode === '3d' ? 'active' : ''}`, onclick: () => { previewMode = '3d'; renderPage(); } }, '3D'),
        h('button', { class: `tab ${previewMode === '2d' ? 'active' : ''}`, onclick: () => { previewMode = '2d'; renderPage(); } }, '2D'),
      ]),
    ]),
    previewMode === '3d' ? skin3d(src, model) : skin2dRender(src, model),
    h('div', { class: 'muted small', style: { textAlign: 'center' } }, previewMode === '3d' ? '3D 预览 · 拖动旋转' : '正面预览 · 游戏内为立体模型'),
    h('div', { class: 'field', style: { width: '100%' } }, [
      h('label', {}, '皮肤模型'),
      h('select', { class: 'select', onchange: (e) => { model = e.target.value; renderPage(); } }, [
        h('option', { value: 'classic', selected: model !== 'slim' }, '经典 Classic（Steve 手臂）'),
        h('option', { value: 'slim', selected: model === 'slim' }, '纤细 Slim（Alex 手臂）'),
      ]),
    ]),
  ]);
}

function controls() {
  const acc = current();
  if (!acc) return null;
  const fileInput = h('input', { type: 'file', accept: 'image/png', style: { display: 'none' }, onchange: (e) => e.target.files[0] && uploadSkin(e.target.files[0]) });
  const inst = currentInstance();
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-title', style: { marginBottom: '10px' } }, '皮肤操作'),
    h('div', { class: 'skin-actions' }, [
      h('div', { class: 'skin-action-grid' }, [
        h('button', { class: 'btn btn-sm btn-primary', disabled: busy, onclick: () => fileInput.click() }, '上传皮肤'),
        fileInput,
        h('button', { class: 'btn btn-sm', disabled: busy, onclick: fromUrl }, '网络地址'),
        h('button', { class: 'btn btn-sm', disabled: busy, onclick: fromMojang }, '按用户名'),
        acc.type === 'microsoft' ? h('button', { class: 'btn btn-sm', disabled: busy, onclick: applyToMojang }, '同步正版') : null,
        h('button', { class: 'btn btn-sm btn-danger', disabled: busy, onclick: removeSkin }, '移除皮肤'),
      ]),
      h('div', { class: 'divider' }),
      h('div', { class: 'label' }, '让皮肤在游戏内生效'),
      h('div', { class: 'hint' }, '离线/第三方账户需要 CustomSkinLoader 等皮肤模组；正版账户上传后会由 Mojang 同步。'),
      h('div', { class: 'row' }, [
        h('select', { class: 'select', style: { flex: '1' }, onchange: (e) => { instanceId = e.target.value; } },
          state.instances.map((i) => h('option', { value: i.id, selected: i.id === (inst && inst.id) }, i.name))),
        h('button', { class: 'btn btn-sm', disabled: busy, onclick: installSkinMod }, '安装皮肤补丁'),
      ]),
    ]),
  ]);
}

async function loadMine() {
  mineLoading = true;
  try {
    const r = await api('/api/skins/mine');
    mineItems = r.items || [];
    mineError = '';
  } catch (e) {
    mineItems = [];
    mineError = e.message;
  }
  mineLoading = false;
}

async function importMine(file) {
  if (!file) return;
  if (!String(file.type || '').includes('png') && !/\.png$/i.test(file.name || '')) {
    toastErr('格式不支持', '请选择 PNG 皮肤文件');
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    await api('/api/skins/mine', {
      method: 'POST', body: buf,
      headers: {
        'x-filename': encodeURIComponent(file.name || '我的皮肤.png'),
        'Content-Type': 'application/octet-stream',
        'x-model': model,
      },
    });
    toastOk('已导入我的皮肤', file.name);
    await loadMine();
    renderPage();
  } catch (e) { toastErr('导入失败', e.message); }
}

async function saveOnlineSkin(g) {
  try {
    const res = await api(g.image, { raw: true });
    const buf = await res.arrayBuffer();
    await api('/api/skins/mine', {
      method: 'POST', body: buf,
      headers: {
        'x-filename': encodeURIComponent(`${g.name || '在线皮肤'}.png`),
        'Content-Type': 'application/octet-stream',
        'x-model': g.type === 'alex' ? 'slim' : 'classic',
      },
    });
    await loadMine();
    toastOk('已收藏到我的', g.name || '在线皮肤');
    libraryTab = 'mine';
    renderPage();
  } catch (e) { toastErr('收藏失败', e.message); }
}

async function applyMine(item) {  const acc = current();
  if (!acc) { toastErr('没有账户', '请先选择账户'); return; }
  if (busy) return;
  busy = true;
  try {
    await api(`/api/skins/mine/${encodeURIComponent(item.id)}/apply`, { method: 'POST', body: { accountId: acc.id } });
    await loadState();
    toastOk('已应用皮肤', item.name);
    renderPage();
  } catch (e) { toastErr('应用失败', e.message); }
  finally { busy = false; }
}

async function removeMine(item) {
  if (!(await confirmDialog({ title: '删除我的皮肤', message: `确定删除「${item.name}」吗？`, okText: '删除', danger: true }))) return;
  try {
    await api(`/api/skins/mine/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    await loadMine();
    toastOk('已删除', item.name);
    renderPage();
  } catch (e) { toastErr('删除失败', e.message); }
}

function mySkinsCard() {
  const fileInput = h('input', {
    type: 'file', accept: 'image/png', style: { display: 'none' },
    onchange: (e) => { const f = e.target.files?.[0]; if (f) importMine(f); e.target.value = ''; },
  });
  let grid;
  if (mineLoading && !mineItems.length) {
    grid = h('div', { class: 'skin-gallery' }, Array.from({ length: 4 }, () => h('div', { class: 'skin-card skeleton', style: { height: '150px' } })));
  } else if (mineError) {
    grid = h('div', { class: 'callout warn' }, `读取我的皮肤失败：${mineError}`);
  } else if (!mineItems.length) {
    grid = h('div', { class: 'empty-inline' }, [
      h('div', { class: 'panel-title' }, '还没有导入皮肤'),
      h('div', { class: 'hint' }, '点右上角「导入皮肤」选择 PNG，支持 64x64 / 64x32 / 128x128。'),
    ]);
  } else {
    grid = h('div', { class: 'skin-gallery' }, mineItems.map((item) => h('div', {
      class: 'skin-card', onclick: () => applyMine(item), title: `点击应用 · ${item.name}`,
    }, [
      skinCanvas(item.image, 64, 128, 'skin-thumb', item.model),
      h('div', { class: 'name ellipsis' }, item.name),
      h('div', { class: 'row', style: { justifyContent: 'space-between', width: '100%' } }, [
        h('span', { class: 'muted small' }, item.model === 'slim' ? '纤细' : '经典'),
        h('button', {
          class: 'btn btn-sm btn-ghost', title: '删除', html: icon('close', 13),
          onclick: (e) => { e.stopPropagation(); removeMine(item); },
        }),
      ]),
    ])));
  }
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('div', { class: 'panel-title' }, '我的'),
      badge(`${mineItems.length} 个`, 'accent'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => fileInput.click() }, '导入皮肤'),
      fileInput,
    ]),
    grid,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, '导入后保存在本机，点击皮肤卡片即可应用到当前账户。'),
  ]);
}

function galleryCard() {
  const filters = [
    ['latest', '', '最新'],
    ['likes', '', '热门'],
    ['latest', 'steve', '经典'],
    ['latest', 'alex', '纤细'],
    ['latest', 'hd', '高清'],
  ];
  const tabs = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, filters.map(([sort, type, label]) => h('button', {
    class: `btn btn-sm ${libSort === sort && libType === type ? 'btn-primary' : ''}`,
    onclick: () => setLibrary(sort, type),
  }, label)));
  let grid;
  if (libLoading && !libItems.length) {
    grid = h('div', { class: 'skin-gallery' }, Array.from({ length: 8 }, () => h('div', { class: 'skin-card skeleton', style: { height: '150px' } })));
  } else if (libError && !libItems.length) {
    grid = h('div', { class: 'callout warn' }, [h('div', {}, '在线皮肤库暂时不可用：' + libError), h('button', { class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: () => loadLibrary(true) }, '重试')]);
  } else {
    grid = h('div', { class: 'skin-gallery' }, libItems.map((g) => h('div', {
      class: 'skin-card', onclick: () => !busy && applyLibrary(g), title: `点击应用 · ${g.nickname || 'LittleSkin'}`,
    }, [
      skinCanvas(g.image, 64, 128, 'skin-thumb', g.model),
      h('div', { class: 'name ellipsis' }, g.name),
      h('div', { class: 'muted small' }, `${g.type === 'alex' ? '纤细' : '经典'} · ♥ ${g.likes || 0}`),
      h('button', {
        class: 'btn btn-sm', style: { marginTop: '5px', width: '100%' },
        onclick: (e) => { e.stopPropagation(); saveOnlineSkin(g); },
      }, '收藏到我的'),
    ])));
  }
  const libSearch = h('input', {
    class: 'input', style: { maxWidth: '260px' }, placeholder: '搜索在线皮肤，例如 cat、snow…', value: libQuery,
    oninput: (e) => { libQuery = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') { libQuery = e.currentTarget.value.trim(); loadLibrary(true); } },
  });
  const presets = [
    ['Steve', '/assets/skins/steve.png', 'classic'],
    ['Alex', '/assets/skins/alex.png', 'slim'],
    ['Notch', '/assets/skins/notch.png', 'classic'],
    ['Herobrine', '/assets/skins/herobrine.png', 'classic'],
    ['Jeb', '/assets/skins/jeb.png', 'classic'],
    ['Dinnerbone', '/assets/skins/dinnerbone.png', 'classic'],
    ['Deadmau5', '/assets/skins/deadmau5.png', 'classic'],
    ['Dream', '/assets/skins/dream.png', 'classic'],
    ['Skeppy', '/assets/skins/skeppy.png', 'classic'],
    ['BadBoyHalo', '/assets/skins/badboyhalo.png', 'classic'],
    ['Sapnap', '/assets/skins/sapnap.png', 'classic'],
    ['Philza', '/assets/skins/philza.png', 'classic'],
    ['WilburSoot', '/assets/skins/wilbursoot.png', 'classic'],
    ['CaptainSparklez', '/assets/skins/captainsparklez.png', 'classic'],
  ];
  const applyPreset = async (name, url, modelName) => {
    const acc = current();
    if (!acc) { toastErr('没有账户', '请先添加账户'); return; }
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      await api('/api/skins/upload', {
        method: 'POST', body: buf,
        headers: { 'x-account-id': acc.id, 'x-model': modelName, 'Content-Type': 'image/png' },
      });
      toastOk(`已应用 ${name}`, '经典预设皮肤');
      await refreshState();
    } catch (e) { toastErr('应用失败', e.message); }
  };
  const openClassic = () => {
    modal({
      title: '经典皮肤',
      wide: true,
      body: h('div', { class: 'col', style: { gap: '10px' } }, [
        h('div', { class: 'classic-skin-grid' }, presets.map(([name, url, m]) => h('button', {
          class: 'classic-skin-card', onclick: () => { applyPreset(name, url, m); }, title: `应用 ${name}`,
        }, [
          h('div', { class: 'classic-skin-thumb' }, skinCanvas(url, 64, 128, 'skin-img', m)),
          h('span', {}, name),
        ]))),
        h('a', {
          href: 'https://zh-cn.namemc.com/minecraft-skins/', target: '_blank', rel: 'noreferrer',
          class: 'hint', style: { textAlign: 'center', display: 'block' },
          onclick: (e) => { e.preventDefault(); window.desktopWindow?.openExternal?.('https://zh-cn.namemc.com/minecraft-skins/') || window.open(e.currentTarget.href, '_blank', 'noopener'); },
        }, '在 NameMC 浏览更多皮肤 →'),
      ]),
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  };
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head', style: { flexWrap: 'wrap', gap: '8px' } }, [
      h('div', { class: 'panel-title' }, '在线皮肤库'),
      badge('LittleSkin', 'violet'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onclick: openClassic }, '经典皮肤'),
      tabs,
    ]),
    h('div', { class: 'row', style: { marginTop: '8px', gap: '6px' } }, [
      libSearch,
      h('button', { class: 'btn btn-sm', onclick: () => { libQuery = libSearch.value.trim(); loadLibrary(true); } }, '搜索'),
      libQuery ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { libQuery = ''; libSearch.value = ''; loadLibrary(true); } }, '清空') : null,
    ]),
    grid,
    h('div', { class: 'row', style: { marginTop: '10px', justifyContent: 'space-between' } }, [
      h('div', { class: 'hint' }, '来自 LittleSkin 公开皮肤库 · 点击卡片直接应用到当前账户'),
      libHasMore ? h('button', { class: 'btn btn-sm', disabled: libLoading, onclick: () => { libPage += 1; loadLibrary(false); } }, libLoading ? '加载中…' : '换一批') : null,
    ]),
  ]);
}

function accountPicker(list, active, pick) {
  const label = active.type === 'microsoft' ? '正版' : active.type === 'thirdparty' ? '第三方' : '离线';
  const button = h('button', { class: 'account-picker', type: 'button' }, [
    h('img', { class: 'account-picker-avatar', src: `/api/accounts/${encodeURIComponent(active.id)}/avatar`, alt: '' }),
    h('div', { class: 'account-picker-text' }, [
      h('strong', {}, active.username || '未命名'),
      h('span', {}, `${label}${active.authServer ? ' · ' + active.authServer.replace(/^https?:\/\//, '').split('/')[0] : ''}`),
    ]),
    h('span', { class: 'account-picker-chev', html: icon('chevron', 14) }),
  ]);
  button.addEventListener('click', () => {
    const dlg = modal({
      title: '选择账户',
      body: h('div', { class: 'account-pick-list' }, list.map((a) => h('button', {
        class: `account-pick ${a.id === active.id ? 'active' : ''}`, type: 'button',
        onclick: () => { dlg.close?.(); pick(a); },
      }, [
        h('img', { src: `/api/accounts/${encodeURIComponent(a.id)}/avatar`, alt: '' }),
        h('div', { class: 'grow' }, [
          h('strong', {}, a.username || '未命名'),
          h('span', {}, a.type === 'microsoft' ? '微软正版' : a.type === 'thirdparty' ? `第三方${a.authServer ? ' · ' + a.authServer.replace(/^https?:\/\//, '').split('/')[0] : ''}` : '离线账户'),
        ]),
        a.id === active.id ? badge('使用中', 'ok') : null,
      ]))),
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  });
  return button;
}

async function enableLocalSkin() {
  const inst = state.instances.find((i) => i.id === state.settings.lastInstanceId) || state.instances[0];
  if (!inst?.versionId) { toastErr('没有可安装的实例', '请先创建一个游戏实例'); return; }
  try {
    toast({ kind: 'info', title: '正在安装皮肤补丁', message: '会安装 CustomSkinLoader 并写入本地皮肤配置…', timeout: 5000 });
    await api('/api/mods/install', {
      method: 'POST',
      body: {
        projectId: 'customskinloader',
        instanceId: inst.id,
        gameVersion: inst.versionId,
        loader: inst.loader?.type || 'fabric',
        withDependencies: true,
      },
    });
    await api(`/api/instances/${encodeURIComponent(inst.id)}/skins/patch`, { method: 'POST', body: {} });
    toastOk('本地皮肤已启用', '重启游戏后生效；如果整合包已有皮肤 Mod，请只保留一个。');
  } catch (e) { toastErr('启用失败', e.message); }
}

function skinSupportNotice(acc) {
  if (!acc) return null;
  const third = acc.type === 'thirdparty';
  return h('div', { class: `callout ${third ? 'warn' : 'info'}` }, [
    h('div', {}, third
      ? '第三方皮肤只修改了启动器预览。游戏内皮肤由 LittleSkin 角色材质决定；也可以安装 CustomSkinLoader 让本地皮肤在游戏内显示。'
      : '离线账户原版游戏不会加载启动器里的自定义皮肤。安装 CustomSkinLoader 后，本地皮肤才能在游戏内显示。'),
    h('div', { class: 'row', style: { marginTop: '8px', gap: '6px', flexWrap: 'wrap' } }, [
      third ? h('button', {
        class: 'btn btn-sm',
        onclick: () => window.desktopWindow?.openExternal?.('https://littleskin.cn/user/player') || window.open('https://littleskin.cn/user/player', '_blank', 'noopener'),
      }, '打开 LittleSkin 角色页') : null,
      h('button', { class: 'btn btn-sm btn-primary', onclick: enableLocalSkin }, '安装本地皮肤支持'),
    ]),
  ]);
}

function renderPage() {
  if (!view) return;
  view.innerHTML = '';
  const list = accounts();
  if (!list.length) {
    view.append(emptyState({
      icon: '☺', title: '还没有账户', sub: '皮肤需要绑定一个账户，请先到「账户」页添加离线或正版账户。',
      action: h('button', { class: 'btn btn-primary', onclick: () => { location.hash = '#/accounts'; } }, '去添加账户'),
    }));
    return;
  }
  const acc = current();
  // 第三方账户的皮肤自动收进「我的」，方便之后再次应用。
  if (acc?.type === 'thirdparty' && !autoImportedSkins.has(acc.id)) {
    autoImportedSkins.add(acc.id);
    api('/api/skins/mine/import-account', { method: 'POST', body: { accountId: acc.id } })
      .then(() => loadMine()).catch(() => {});
  }
  const select = accountPicker(list, acc, (a) => {
    accountId = a.id;
    model = a.skinModel || 'classic';
    renderPage();
  });
  const libraryTabs = h('div', { class: 'skin-library-tabs' }, [
    h('button', {
      class: `btn btn-sm ${libraryTab === 'mine' ? 'btn-primary' : ''}`,
      onclick: () => { libraryTab = 'mine'; renderPage(); },
    }, `我的 ${mineItems.length}`),
    h('button', {
      class: `btn btn-sm ${libraryTab === 'online' ? 'btn-primary' : ''}`,
      onclick: () => { libraryTab = 'online'; renderPage(); },
    }, '在线皮肤库'),
  ]);
  view.append(h('div', { class: 'home' }, [
    h('div', { class: 'panel', style: { padding: '14px' } }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, [
        h('div', { class: 'panel-title' }, '选择账户'),
        h('div', { class: 'row' }, [select]),
      ]),
    ]),
    h('div', { class: 'skin-layout' }, [
      preview(acc),
      h('div', { class: 'col' }, [
        acc.type !== 'microsoft' ? skinSupportNotice(acc) : null,
        controls(), libraryTabs, libraryTab === 'mine' ? mySkinsCard() : galleryCard(),
      ]),
    ]),
  ]));
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    view.append(loadingBlock('正在读取皮肤…'));
    if (!state.accounts.length) { try { await loadState(); } catch { /* ignore */ } }
    const list = accounts();
    accountId = accountId || state.settings.lastAccountId || list[0]?.id || null;
    model = list.find((a) => a.id === accountId)?.skinModel || 'classic';
    renderPage();
    loadLibrary(true);
    loadMine().then(() => { if (view) renderPage(); }).catch(() => {});
  },
  destroy() { view = null; ctxRef = null; },
};
