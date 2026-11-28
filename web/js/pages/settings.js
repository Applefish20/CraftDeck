/* ================= 设置页 ================= */
import {
  h, toast, toastOk, toastErr, badge, switchEl, rangeRow, sectionTitle, kvList, promptDialog, confirmDialog, copyText, fmtBytes, modal,
} from '../ui.js';
import { state, api, patchSettings, applyAppearance, loadState, applyHiddenPages } from '../state.js';
import { icon } from '../icons.js';

let view = null;
let ctxRef = null;
let javas = [];
let javaLoading = false;
let media = [];
let toolbox = null;

async function loadToolbox() {
  try {
    toolbox = await api('/api/toolbox/status');
    if (toolbox?.storagePending) {
      api('/api/toolbox/storage').then((r) => {
        if (!r?.disk) return;
        toolbox = { ...toolbox, disk: r.disk, storagePending: false };
        if (toolboxRefresh) toolboxRefresh();
      }).catch(() => {});
    }
  } catch { toolbox = null; }
}

export async function ensureToolboxData() {
  await loadToolbox();
}

const PRESETS = [
  { key: 'default', label: '默认色' },
  { key: 'autumn', label: '秋日斑驳森林' }, { key: 'coral', label: '珊瑚礁' },
  { key: 'village', label: '村庄' }, { key: 'end', label: '末地' },
  { key: 'stronghold', label: '要塞' }, { key: 'night', label: '夜晚平原' },
  { key: 'plains', label: '平原' }, { key: 'monument', label: '海底神殿' },
  { key: 'mottled', label: '斑驳森林' }, { key: 'end-outer', label: '末地外岛' },
  { key: 'desert', label: '沙漠' }, { key: 'cherry', label: '樱花树林' },
  { key: 'aurora', label: '极光' }, { key: 'sunset', label: '暮色' },
  { key: 'ocean', label: '深海' }, { key: 'forest', label: '森林' }, { key: 'void', label: '虚空' },
];

async function loadJava() {
  javaLoading = true;
  try {
    const r = await api('/api/java');
    javas = r.javas || r.java || (Array.isArray(r) ? r : []) || [];
  } catch {
    javas = [];
  }
  javaLoading = false;
}

async function loadMedia() {
  try {
    const r = await api('/api/media/list');
    media = r.files || [];
  } catch { media = []; }
}

function settingRow(label, desc, control) {
  return h('div', { class: 'setting-row' }, [
    h('div', {}, [h('div', { class: 'sr-label' }, label), desc ? h('div', { class: 'sr-desc' }, desc) : null]),
    h('div', { class: 'sr-control' }, control),
  ]);
}

function card(title, children, hint = '', reset = null) {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('div', { class: 'panel-title' }, title),
      reset ? h('button', { class: 'btn btn-sm btn-ghost', title: '还原本页设置', html: `${icon('undo', 13)}<span>还原</span>`, onclick: reset }) : null,
    ]),
    ...children,
    hint ? h('div', { class: 'hint', style: { marginTop: '10px' } }, hint) : null,
  ]);
}

const SECTION_DEFAULTS = {
  general: { windowWidth: 0, windowHeight: 0, showSnapshots: false, showOldVersions: false, translateModNames: true, autoUpdateManifest: true },
  appearance: { theme: 'light', accent: '#1962f5', background: { type: 'preset', value: 'aurora', blur: 0, dim: 0.35, opacity: 1 } },
  java: { javaPath: 'auto', memoryMb: 4096, autoMemory: true, jvmArgs: '' },
  download: { downloadSource: 'auto', maxConcurrentDownloads: 24, downloadThreads: 12, maxUploadMb: 4096 },
  account: { microsoftClientId: 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb', translationEnabled: true },
  update: { updateFeedUrl: '', autoCheckUpdate: false },
};

async function resetSection(key) {
  try {
    await save({ ...SECTION_DEFAULTS[key] }, false);
    ctxRef.refresh();
    toastOk('已还原', '本页设置已恢复默认值');
  } catch (e) { toastErr('还原失败', e.message); }
}

async function save(patch, silent = true) {
  try {
    await patchSettings(patch);
    applyHiddenPages();
    if (!silent) toastOk('设置已保存');
  } catch (e) { toastErr('保存失败', e.message); }
}

async function setHiddenPage(key, on) {
  const set = new Set(Array.isArray(state.settings.hiddenPages) ? state.settings.hiddenPages : []);
  if (on) set.add(key); else set.delete(key);
  await save({ hiddenPages: [...set] });
}

async function setHiddenTab(key, on) {
  const set = new Set(Array.isArray(state.settings.hiddenTabs) ? state.settings.hiddenTabs : []);
  if (on) set.add(key); else set.delete(key);
  await save({ hiddenTabs: [...set] });
}

function appearanceCard() {
  const s = state.settings;
  const bg = s.background || {};
  const patchBg = (patch) => save({ background: { ...(state.settings.background || {}), ...patch } });
  const themeRow = h('div', { class: 'row', style: { gap: '8px' } }, [
    h('button', {
      class: `btn btn-sm ${s.theme !== 'light' ? 'btn-primary' : ''}`,
      onclick: async () => { await save({ theme: 'dark' }, false); ctxRef.refresh(); },
    }, '深色'),
    h('button', {
      class: `btn btn-sm ${s.theme === 'light' ? 'btn-primary' : ''}`,
      onclick: async () => { await save({ theme: 'light' }, false); ctxRef.refresh(); },
    }, '浅色'),
  ]);
  const accentInput = h('input', { type: 'color', class: 'input', style: { width: '64px', padding: '3px', height: '38px' }, value: s.accent || '#1962f5', onchange: (e) => save({ accent: e.target.value }, false) });
  const thumbs = h('div', { class: 'bg-picker' });
  for (const p of PRESETS) {
    thumbs.append(h('div', {
      class: `bg-thumb bg-preset-${p.key} ${bg.type !== 'image' && (bg.value || 'aurora') === p.key ? 'selected' : ''}`,
      onclick: async () => {
        await save({ background: { type: 'preset', value: p.key } });
        ctxRef.refresh();
      },
    }, h('span', {}, p.label)));
  }
  for (const m of media.slice(0, 12)) {
    const label = String(m.name || '').replace(/\.[^.]+$/i, '') || '我的背景';
    thumbs.append(h('div', {
      class: `bg-thumb ${bg.type === 'image' && bg.value === m.url ? 'selected' : ''}`,
      style: { backgroundImage: `url("${m.url}")` },
      title: label,
      onclick: async () => { await save({ background: { type: 'image', value: m.url } }); ctxRef.refresh(); },
    }, h('span', {}, label)));
  }
  const uploadBtn = h('button', { class: 'btn btn-sm', onclick: () => uploadInput.click() }, '上传图片');
  const uploadInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: (e) => uploadBg(e.target.files[0]) });
  const urlBtn = h('button', { class: 'btn btn-sm', onclick: async () => {
    const url = await promptDialog({ title: '网络图片', label: '图片 URL（支持 http/https）', placeholder: 'https://example.com/bg.jpg' });
    if (url) { await save({ background: { type: 'image', value: url } }); ctxRef.refresh(); }
  } }, '网络图片');
  const clearBtn = h('button', { class: 'btn btn-sm', onclick: async () => { await save({ background: { type: 'none', value: '' } }); ctxRef.refresh(); } }, '纯色');
  const dropZone = h('div', {
    class: 'bg-dropzone',
    style: bg.type === 'image' && bg.value ? { backgroundImage: `url("${bg.value}")` } : {},
    onclick: () => uploadInput.click(),
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('drag'); },
    ondragleave: (e) => e.currentTarget.classList.remove('drag'),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('drag');
      uploadBg(e.dataTransfer?.files?.[0]);
    },
  }, [
    h('div', { class: 'bg-drop-text' }, bg.type === 'image' && bg.value ? '点击或拖入图片替换背景' : '点击或拖入图片作为背景'),
    h('div', { class: 'bg-drop-sub' }, 'PNG / JPG / WebP，自动保存到本地 media 目录'),
  ]);

  return card('主题与背景', [
    settingRow('界面主题', '深色 / 浅色，立即生效。', themeRow),
    settingRow('强调色', '按钮、高亮与进度条的主色。', accentInput),
    h('div', { style: { marginTop: '6px' } }, [
      h('div', { class: 'label', style: { marginBottom: '8px' } }, '背景预设'),
      h('div', { class: 'hint', style: { marginBottom: '8px' } }, '点击任意缩略图立即应用；这里只改启动器整体背景，不会改版本卡片封面。'),
      thumbs,
      h('div', { class: 'row', style: { marginTop: '10px', gap: '8px' } }, [uploadBtn, urlBtn, clearBtn, uploadInput]),
      dropZone,
    ]),
    h('div', { style: { marginTop: '10px' } }, [
      settingRow('背景模糊', '对任意背景生效（像素）。', rangeRow({
        min: 0, max: 30, step: 1, value: bg.blur || 0,
        onChange: (v) => patchBg({ blur: v }),
        format: (v) => v + ' px',
      })),
      settingRow('背景变暗', '提高文字可读性。', rangeRow({
        min: 0, max: 0.9, step: 0.05, value: bg.dim ?? 0.35,
        onChange: (v) => patchBg({ dim: v }),
        format: (v) => Math.round(v * 100) + '%',
      })),
    ]),
  ], '背景图片会保存在启动器数据目录的 media 文件夹中。', () => resetSection('appearance'));
}

function javaCard() {
  const s = state.settings;
  const javaSelect = h('select', {
    class: 'select',
    onchange: (e) => {
      const v = e.target.value;
      javaPathInput.value = v === 'auto' ? '' : v;
      javaPathInput.disabled = v === 'auto';
      save({ javaPath: v === 'auto' ? 'auto' : v });
    },
  }, [
    h('option', { value: 'auto', selected: !s.javaPath || s.javaPath === 'auto' }, '自动选择（推荐）'),
    ...javas.map((j) => h('option', { value: j.path, selected: j.path === s.javaPath }, `Java ${j.major} · ${j.vendor || ''} · ${j.path}`)),
    h('option', { value: 'custom', selected: s.javaPath && s.javaPath !== 'auto' && !javas.some((j) => j.path === s.javaPath) }, '自定义路径…'),
  ]);
  const javaPathInput = h('input', {
    class: 'input', placeholder: 'java.exe 的完整路径', value: s.javaPath && s.javaPath !== 'auto' ? s.javaPath : '',
    disabled: !s.javaPath || s.javaPath === 'auto',
    onchange: (e) => save({ javaPath: e.target.value.trim() || 'auto' }),
  });
  const memValue = s.memoryMb || 4096;
  const memRange = rangeRow({
    min: 1024, max: 16384, step: 512, value: memValue,
    onChange: async (v) => { document.getElementById('mem-value').textContent = v + ' MB'; },
    format: () => '',
  });
  const memLabel = h('span', { id: 'mem-value', class: 'badge accent' }, memValue + ' MB');
  const saveMemBtn = h('button', { class: 'btn btn-sm', onclick: () => {
    const val = Number(memRange.querySelector('input').value);
    save({ memoryMb: val }, false);
  } }, '应用');

  return card('Java 运行时与内存', [
    h('div', { class: 'field', style: { marginBottom: '10px' } }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
        h('label', { class: 'label' }, javaLoading && !javas.length ? '正在扫描 Java…' : `已检测到 ${javas.length} 个 Java`),
        h('button', {
          class: 'btn btn-sm btn-ghost', onclick: async () => { await loadJava(); ctxRef.refresh(); },
        }, javaLoading ? '检测中…' : '重新检测'),
      ]),
      javaSelect,
      javaPathInput,
    ]),
    settingRow('最大内存', '建议 4-8 GB；模组整合包可适当增加。', h('div', { class: 'row' }, [memLabel, saveMemBtn])),
    h('div', { style: { padding: '0 0 6px' } }, memRange),
    settingRow('自动分配内存', '按物理内存的一半计算，上限 8 GB。', switchEl(s.autoMemory, (v) => save({ autoMemory: v }))),
    settingRow('下载并发数', '同时下载多少个文件；网络较差时调低。', h('select', {
      class: 'select', style: { width: '100px' },
      onchange: (e) => save({ maxConcurrentDownloads: Number(e.target.value) }),
    }, [2, 4, 6, 8, 12, 16, 24, 32].map((n) => h('option', { value: n, selected: n === (s.maxConcurrentDownloads || 24) }, String(n))))),
    settingRow('下载线程数', '大文件（>4MB）使用多连接分段下载，1 为关闭。', h('select', {
      class: 'select', style: { width: '100px' },
      onchange: (e) => save({ downloadThreads: Number(e.target.value) }),
    }, [1, 2, 4, 6, 8, 12, 16].map((n) => h('option', { value: n, selected: n === (s.downloadThreads || 12) }, n === 1 ? '1（关闭）' : String(n))))),
    h('div', { class: 'field', style: { marginTop: '8px' } }, [
      h('label', {}, '全局 JVM 参数'),
      h('textarea', {
        class: 'textarea', rows: 2, placeholder: '例如 -XX:+UseZGC -Dfile.encoding=UTF-8',
        onchange: (e) => save({ jvmArgs: e.target.value }),
      }, s.jvmArgs || ''),
    ]),
  ], '每个实例可在实例设置中单独覆盖 Java 路径、内存与 JVM 参数。', () => resetSection('java'));
}

async function uploadBg(file) {
  if (!file) return;
  if (!String(file.type || '').startsWith('image/')) { toastErr('不是图片', '请选择 PNG / JPG / WebP 图片'); return; }
  try {
    const fd = new FormData();
    fd.append('file', file, file.name || 'background.png');
    const r = await api('/api/media/upload', { method: 'POST', body: fd });
    await save({ background: { type: 'image', value: r.url } });
    applyAppearance();
    toastOk('背景已更新', file.name);
    ctxRef.refresh();
  } catch (e) { toastErr('上传失败', e.message); }
}

function downloadCard() {
  const s = state.settings;
  return card('下载设置', [
    settingRow('下载源', '官方源更稳定；镜像源在国内网络可能更快。', h('select', {
      class: 'select', style: { width: '150px' },
      onchange: (e) => save({ downloadSource: e.target.value }, false),
    }, [
      h('option', { value: 'auto', selected: s.downloadSource === 'auto' }, '自动（推荐）'),
      h('option', { value: 'mirror', selected: s.downloadSource === 'mirror' }, '国内镜像（BMCLAPI）'),
      h('option', { value: 'official', selected: s.downloadSource === 'official' }, 'Mojang 官方'),
    ])),
    settingRow('整合包上传上限', '本地导入 .mrpack / .zip 的大小上限，单位 MB。修改后立即生效。', h('div', { class: 'row', style: { gap: '6px' } }, [
      h('input', {
        class: 'input', type: 'number', min: 64, max: 16384, step: 64,
        style: { width: '110px' }, value: s.maxUploadMb || 4096,
        onchange: (e) => {
          const v = Math.max(64, Math.min(16384, Number(e.target.value) || 4096));
          e.target.value = v;
          save({ maxUploadMb: v }, false);
        },
      }),
      h('span', { class: 'muted small' }, 'MB'),
      h('span', { class: 'hint' }, '默认 4096 MB（4 GB）'),
    ])),
    h('div', { class: 'field', style: { marginTop: '8px' } }, [
      h('label', {}, 'CurseForge API Key（可选）'),
      h('input', {
        class: 'input', type: 'password', placeholder: '用于下载 CurseForge 整合包', value: s.curseforgeApiKey || '',
        onchange: (e) => save({ curseforgeApiKey: e.target.value.trim() }),
      }),
      h('div', { class: 'hint' }, 'CurseForge 官方下载需要 API Key；不填时只能安装 Modrinth 整合包与本地整合包中可直链的文件。'),
    ]),
  ], '下载的游戏文件会全局缓存在数据目录 launcher/shared 下，供所有实例共享。', () => resetSection('download'));
}

function accountCard() {
  const s = state.settings;
  return card('登录配置', [
    h('div', { class: 'field' }, [
      h('label', {}, '微软 OAuth Client ID'),
      h('input', {
        class: 'input mono', value: s.microsoftClientId || '',
        onchange: (e) => save({ microsoftClientId: e.target.value.trim() }),
      }),
      h('div', { class: 'hint' }, '默认使用开源启动器公共客户端 ID，支持设备码登录。如遇微软限制可填入自己的 Azure 应用 ID。'),
    ]),
    h('div', { class: 'field', style: { marginTop: '10px' } }, [
      h('label', {}, '模组汉化'),
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
        h('span', { class: 'hint' }, '启动前检查并安装简体中文汉化资源包'),
        switchEl(s.translationEnabled !== false, (v) => save({ translationEnabled: v })),
      ]),
    ]),
    h('div', { class: 'hint', style: { marginTop: '8px' } }, '账户令牌仅存储在本机 state.json 中，不会上传到任何服务器。'),
  ], '', () => resetSection('account'));
}

let toolboxRefresh = null;
export function setToolboxRefresh(fn) { toolboxRefresh = typeof fn === 'function' ? fn : null; }
function refreshToolbox() {
  if (toolboxRefresh) toolboxRefresh();
  else if (ctxRef) ctxRef.refresh();
}

export function toolboxCard() {
  const mem = toolbox?.memory || { rssMb: 0, heapUsedMb: 0, heapTotalMb: 0 };
  const disk = toolbox?.disk || {};
  const heapPct = mem.heapTotalMb ? Math.min(1, mem.heapUsedMb / mem.heapTotalMb) : 0;
  const mkResult = (text = '', cls = '') => h('div', { class: `tool-result ${cls}` }, text);

  const optimizeResult = mkResult(`当前进程占用约 ${mem.rssMb} MB，堆 ${mem.heapUsedMb}/${mem.heapTotalMb} MB。`);
  const optimizeBtn = h('button', { class: 'btn btn-primary btn-sm', onclick: async (e) => {
    const btn = e.currentTarget;
    try {
      btn.disabled = true; btn.textContent = '优化中…';
      const r = await api('/api/toolbox/optimize', { method: 'POST', body: {} });
      optimizeResult.className = 'tool-result ok';
      optimizeResult.textContent = `已触发垃圾回收：RSS ${r.before.rssMb} → ${r.after.rssMb} MB，释放约 ${r.freedMb} MB。`;
      await loadToolbox();
      toastOk('内存优化完成', `释放约 ${r.freedMb} MB`);
      refreshToolbox();
    } catch (err) { optimizeResult.className = 'tool-result err'; optimizeResult.textContent = '优化失败：' + err.message; }
    finally { btn.disabled = false; btn.textContent = '立即优化'; }
  } }, '立即优化');

  const targets = { cache: true, logs: true, temp: true, installers: false, modpacks: false };
  const cleanResult = mkResult(`可清理：缓存 ${fmtBytes(disk.cache || 0)} · 日志 ${fmtBytes(disk.logs || 0)} · 下载缓存 ${fmtBytes(disk.downloads || 0)}。`);
  const cleanBtn = h('button', { class: 'btn btn-sm', onclick: async (e) => {
    const btn = e.currentTarget;
    try {
      btn.disabled = true; btn.textContent = '清理中…';
      const r = await api('/api/toolbox/clean', { method: 'POST', body: { targets: Object.entries(targets).filter(([, v]) => v).map(([k]) => k) } });
      cleanResult.className = 'tool-result ok';
      cleanResult.textContent = `清理完成，释放 ${r.freedText}。`;
      await loadToolbox();
      toastOk('清理完成', r.freedText);
      refreshToolbox();
    } catch (err) { cleanResult.className = 'tool-result err'; cleanResult.textContent = '清理失败：' + err.message; }
    finally { btn.disabled = false; btn.textContent = '开始清理'; }
  } }, '开始清理');
  const cleanChecks = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
    [['cache', '缓存'], ['logs', '日志'], ['temp', '临时文件'], ['installers', '安装器'], ['modpacks', '整合包缓存']].map(([k, label]) =>
      h('label', { class: 'check' }, [h('input', {
        type: 'checkbox', checked: targets[k],
        onchange: (e) => { targets[k] = e.target.checked; },
      }), label])));

  const instSelect = h('select', { class: 'select', style: { width: '100%' } }, state.instances.length
    ? state.instances.map((i) => h('option', { value: i.id, selected: i.id === state.settings.lastInstanceId }, i.name))
    : [h('option', { value: '' }, '（暂无实例）')]);
  const verifyResult = mkResult('按 SHA1 重新校验版本文件，缺失或损坏的会自动重新下载。');
  const verifyBtn = h('button', { class: 'btn btn-sm', onclick: async (e) => {
    if (!instSelect.value) { toastErr('没有实例', ''); return; }
    const btn = e.currentTarget;
    try {
      btn.disabled = true; btn.textContent = '校验中…';
      const r = await api('/api/toolbox/verify', { method: 'POST', body: { instanceId: instSelect.value } });
      verifyResult.className = 'tool-result';
      verifyResult.textContent = `已开始校验 ${r.versionId}，进度见左下角任务栏，完成后会弹出结果。`;
    } catch (err) { verifyResult.className = 'tool-result err'; verifyResult.textContent = '校验失败：' + err.message; }
    finally { btn.disabled = false; btn.textContent = '校验并修复'; }
  } }, '校验并修复');

  const networkResult = h('div', { class: 'tool-result' }, '测试 Mojang / Modrinth / GitHub / Gitee / BMCLAPI 的连通性与延迟。');
  const networkBtn = h('button', { class: 'btn btn-sm', onclick: async (e) => {
    const btn = e.currentTarget;
    try {
      btn.disabled = true; btn.textContent = '测试中…';
      const r = await api('/api/toolbox/network');
      networkResult.className = 'tool-result';
      networkResult.innerHTML = '';
      networkResult.append(...r.results.map((x) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } }, [
        h('span', {}, x.name),
        h('span', { style: { color: x.ok ? 'var(--ok)' : 'var(--err)' } }, x.ok ? `${x.ms} ms` : (x.error || '失败')),
      ])));
    } catch (err) { networkResult.className = 'tool-result err'; networkResult.textContent = '测试失败：' + err.message; }
    finally { btn.disabled = false; btn.textContent = '开始测试'; }
  } }, '开始测试');

  const portResult = h('div', { class: 'tool-result' }, '检查常用端口是否被占用（25555 / 25565 等）。');
  const portBtn = h('button', { class: 'btn btn-sm', onclick: async (e) => {
    const btn = e.currentTarget;
    try {
      btn.disabled = true; btn.textContent = '检测中…';
      const r = await api('/api/toolbox/ports');
      portResult.className = 'tool-result';
      portResult.innerHTML = '';
      portResult.append(...r.ports.map((p) => h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, [
        h('span', { class: 'mono' }, ':' + p.port),
        h('span', { style: { color: p.free ? 'var(--ok)' : 'var(--warn)' } }, p.free ? '空闲' : '已占用'),
      ])));
    } catch (err) { portResult.className = 'tool-result err'; portResult.textContent = '检测失败：' + err.message; }
    finally { btn.disabled = false; btn.textContent = '检测端口'; }
  } }, '检测端口');

  const exportResult = mkResult('把设置、实例、日志和系统信息导出为 txt，方便排查问题。');
  const exportBtn = h('button', { class: 'btn btn-sm', onclick: async (e) => {
    const btn = e.currentTarget;
    try {
      btn.disabled = true; btn.textContent = '导出中…';
      const r = await api('/api/toolbox/export-logs', { method: 'POST', body: {} });
      exportResult.className = 'tool-result ok';
      exportResult.textContent = '已导出：' + r.path;
    } catch (err) { exportResult.className = 'tool-result err'; exportResult.textContent = '导出失败：' + err.message; }
    finally { btn.disabled = false; btn.textContent = '导出诊断'; }
  } }, '导出诊断');

  const resetResult = mkResult('恢复默认设置（不会删除实例、账户和存档）。');
  const resetBtn = h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
    const ok = await confirmDialog({ title: '重置设置', message: '确定恢复所有设置为默认值吗？实例、账户与存档不会受影响。', okText: '重置', danger: true });
    if (!ok) return;
    try {
      await api('/api/toolbox/reset-settings', { method: 'POST', body: {} });
      await loadState();
      toastOk('已恢复默认设置');
      refreshToolbox();
    } catch (err) { toastErr('重置失败', err.message); }
  } }, '恢复默认');

  const dlUrl = h('input', { class: 'input', placeholder: 'https://example.com/mod.jar' });
  const dlName = h('input', { class: 'input', placeholder: '保存文件名（留空自动识别）' });
  const dlInst = h('select', { class: 'select' }, state.instances.map((i) => h('option', { value: i.id, selected: i.id === state.settings.lastInstanceId }, i.name)));
  const dlTarget = h('select', { class: 'select' }, [
    h('option', { value: 'downloads' }, '下载目录'),
    h('option', { value: 'mods' }, '实例 mods'),
    h('option', { value: 'resourcepacks' }, '实例材质包'),
    h('option', { value: 'shaderpacks' }, '实例光影包'),
  ]);
  const dlResult = mkResult('支持任意直链文件，大文件自动使用多线程分段下载。');
  const dlBtn = h('button', { class: 'btn btn-sm btn-primary', onclick: async (e) => {
    const btn = e.currentTarget;
    try {
      btn.disabled = true; btn.textContent = '开始下载…';
      const r = await api('/api/toolbox/download', {
        method: 'POST',
        body: { url: dlUrl.value.trim(), filename: dlName.value.trim(), target: dlTarget.value, instanceId: dlInst.value },
      });
      dlResult.className = 'tool-result ok';
      dlResult.textContent = '已开始下载，进度见左下角任务栏\n保存到：' + r.path;
      dlUrl.value = '';
      dlName.value = '';
    } catch (err) { dlResult.className = 'tool-result err'; dlResult.textContent = '下载失败：' + err.message; }
    finally { btn.disabled = false; btn.textContent = '开始下载'; }
  } }, '开始下载');
  const customDownload = h('div', { class: 'col', style: { gap: '8px' } }, [
    dlUrl, dlName,
    h('div', { class: 'row', style: { gap: '8px' } }, [dlTarget, dlInst]),
    dlBtn,
  ]);

  const tool = (title, desc, controls, result) => h('div', { class: 'tool-item' }, [
    h('div', { class: 'tool-head' }, [h('div', { class: 'tool-title' }, title)]),
    h('div', { class: 'tool-desc' }, desc),
    controls,
    result,
  ]);

  return card('工具列表', [
    h('div', { class: 'tool-grid' }, [
      tool('内存优化', '清理启动器缓存并触发垃圾回收，降低后台内存占用。', h('div', { class: 'col', style: { gap: '8px' } }, [
        h('div', { class: 'gauge' }, h('i', { style: { width: Math.round(heapPct * 100) + '%' } })),
        optimizeBtn,
      ]), optimizeResult),
      tool('清理缓存', '删除临时文件、日志和下载缓存，不会删除已安装的游戏文件。', h('div', { class: 'col', style: { gap: '8px' } }, [cleanChecks, cleanBtn]), cleanResult),
      tool('游戏文件校验', '重新校验客户端、依赖库与资源文件，损坏的会自动重下。', h('div', { class: 'col', style: { gap: '8px' } }, [instSelect, verifyBtn]), verifyResult),
      tool('网络诊断', '检测各下载源与 API 的连通性，帮助判断下载慢的原因。', networkBtn, networkResult),
      tool('端口检测', '检查启动器端口与 Minecraft 默认端口是否被其他程序占用。', portBtn, portResult),
      tool('诊断导出', '生成一份包含日志与系统信息的诊断文件。', exportBtn, exportResult),
      tool('重置设置', '把所有设置恢复为默认值，保留账户、实例与存档。', resetBtn, resetResult),
      tool('自定义下载', '输入直链地址，下载到下载目录或实例的 mods / 材质 / 光影目录。', customDownload, dlResult),
    ]),
  ], '百宝箱中的操作都在本机完成，不会上传任何数据。');
}

function aboutCard() {
  return card('关于与数据', [
    kvList([
      ['数据目录', state.root],
      ['启动器版本', 'CraftDeck 3.6.1'],
      ['游戏启动', `${state.stats.launches || 0} 次 · ${Math.round((state.stats.playTimeMs || 0) / 60000)} 分钟`],
    ]),
    h('div', { class: 'row', style: { marginTop: '12px', gap: '8px', flexWrap: 'wrap' } }, [
      h('button', { class: 'btn btn-sm', onclick: () => copyText(state.root) }, '复制数据目录'),
      h('button', { class: 'btn btn-sm', onclick: () => showLogs() }, '查看启动器日志'),
      h('button', { class: 'btn btn-sm', onclick: () => showSystem() }, '系统信息'),
    ]),
    h('div', { class: 'hint', style: { marginTop: '10px' } },
      'CraftDeck 使用 Mojang 官方版本清单、Modrinth 开放 API 与 Fabric / Quilt / Forge 官方安装源。本程序仅供学习与个人使用，请支持正版 Minecraft。'),
  ]);
}

async function showLogs() {
  try {
    const r = await api('/api/logs');
    const lines = (r.lines || []).map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.level}: ${l.message}`);
    const { modal } = await import('../ui.js');
    modal({ title: '启动器日志', wide: true, body: h('pre', { class: 'console-body', style: { height: '360px' } }, lines.join('\n') || '暂无日志'), actions: [{ label: '关闭', kind: 'primary' }] });
  } catch (e) { toastErr('读取失败', e.message); }
}

async function showSystem() {
  try {
    const r = await api('/api/system');
    const { modal } = await import('../ui.js');
    modal({
      title: '系统信息', body: kvList([
        ['平台', `${r.platform} / ${r.arch}`],
        ['CPU 核心', String(r.cpus)],
        ['内存', `${r.totalMemMb} MB（可用 ${r.freeMemMb} MB）`],
        ['Node.js', r.node],
        ['主机名', r.hostname],
        ['数据目录', r.root],
        ['运行中的游戏', String(r.running?.length || 0)],
      ]), actions: [{ label: '关闭', kind: 'primary' }],
    });
  } catch (e) { toastErr('读取失败', e.message); }
}

const TABS = [
  { key: 'general', label: '通用', icon: 'settings' },
  { key: 'appearance', label: '外观与背景', icon: 'landscape' },
  { key: 'java', label: 'Java 与内存', icon: 'code' },
  { key: 'download', label: '下载与网络', icon: 'download' },
  { key: 'account', label: '账户与登录', icon: 'account' },
  { key: 'guide', label: '使用说明', icon: 'book' },
  { key: 'feedback', label: '反馈', icon: 'mail' },
  { key: 'update', label: '更新', icon: 'refresh' },
  { key: 'credits', label: '感谢', icon: 'heart' },
  { key: 'about', label: '免责声明', icon: 'shield' },
];
const SPONSOR_URL = 'https://afdian.com/a/applefishsun?utm_source=copylink&utm_medium=link';
const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文', flag: '/assets/flags/cn.webp', enabled: true },
  { code: 'en-US', label: 'English (US)', flag: '/assets/flags/us.webp', enabled: false, note: '暂未提供' },
];
let activeTab = 'general';

function languagePicker() {
  const current = LANGUAGES[0];
  const button = h('button', { class: 'lang-button', type: 'button' }, [
    h('img', { class: 'lang-flag', src: current.flag, alt: '' }),
    h('span', {}, current.label),
    h('span', { class: 'lang-chev', html: icon('chevron', 13) }),
  ]);
  button.addEventListener('click', () => {
    const picker = modal({
      title: '界面语言',
      body: h('div', { class: 'lang-list' }, LANGUAGES.map((lang) => h('button', {
        class: `lang-option ${lang.enabled ? '' : 'disabled'}`,
        disabled: !lang.enabled,
        onclick: () => {
          if (!lang.enabled) return;
          picker.close?.();
          toast({ kind: 'info', title: '语言已是最新', message: '目前只有简体中文，English 还在路上。' });
        },
      }, [
        h('img', { class: 'lang-flag', src: lang.flag, alt: '' }),
        h('div', { class: 'grow' }, [
          h('div', { class: 'lang-name' }, lang.label),
          h('div', { class: 'lang-note' }, lang.note || (lang.enabled ? '当前语言' : '')),
        ]),
        lang.enabled ? badge('使用中', 'ok') : badge('Coming soon', 'violet'),
      ]))),
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  });
  return button;
}

function generalCard() {
  const s = state.settings;
  return card('基础设置', [
    settingRow('界面语言', '目前提供简体中文；English (US) 已预留，暂未开放。', languagePicker()),
    settingRow('游戏窗口大小', '留空则使用游戏默认 1280×720；填写后启动时传入 --width / --height。', h('div', { class: 'row', style: { gap: '6px' } }, [
      h('input', {
        class: 'input', type: 'number', min: 320, max: 7680, placeholder: '宽 1280',
        style: { width: '105px' }, value: s.windowWidth || '',
        onchange: (e) => save({ windowWidth: Number(e.target.value) || 0 }),
      }),
      h('span', { class: 'muted' }, '×'),
      h('input', {
        class: 'input', type: 'number', min: 240, max: 4320, placeholder: '高 720',
        style: { width: '105px' }, value: s.windowHeight || '',
        onchange: (e) => save({ windowHeight: Number(e.target.value) || 0 }),
      }),
    ])),
    settingRow('显示快照版本', '版本下载页显示「快照」分类。', switchEl(s.showSnapshots, (v) => save({ showSnapshots: v }))),
    settingRow('显示统计概览', '启动页的「可启动版本 / 累计启动 / 游戏时长 / 账户」四张卡片。', switchEl(s.showStats !== false, (v) => save({ showStats: v }))),
    settingRow('显示可启动版本', '启动页下方的实例卡片列表。', switchEl(s.showInstances !== false, (v) => save({ showInstances: v }))),
    settingRow('显示 MC 新闻', '在启动页右侧显示 Minecraft 中文资讯，不想看可以关掉。', switchEl(s.showNews !== false, (v) => save({ showNews: v }))),
    settingRow('显示远古版本', '显示 Beta 与 Alpha 分类。', switchEl(s.showOldVersions, (v) => save({ showOldVersions: v }))),
    settingRow('模组名称汉化', '在模组/整合包列表优先显示常用模组的中文名。', switchEl(s.translateModNames !== false, (v) => save({ translateModNames: v }))),
    settingRow('启动时刷新版本清单', '每 30 分钟自动更新一次。', switchEl(s.autoUpdateManifest !== false, (v) => save({ autoUpdateManifest: v }))),
    settingRow('下载缓存', '已安装的游戏文件会全局共享，不会重复下载。', h('span', { class: 'muted small' }, 'launcher/shared')),
    h('div', { class: 'settings-group compact' }, [
      h('div', { class: 'settings-group-head', style: { alignItems: 'flex-start' } }, [
        h('div', {}, [
          h('div', { class: 'settings-group-title' }, '隐藏与精简'),
          h('div', { class: 'hint' }, '不想看的页面、下载栏目和菜单文字，点一下直接关掉。'),
        ]),
        h('label', { class: 'row', style: { gap: '7px', flex: '0 0 auto', alignItems: 'center', cursor: 'pointer' } }, [
          h('span', { class: 'small' }, '隐藏菜单文字'),
          switchEl(state.settings.hideNavText === true, (v) => save({ hideNavText: v })),
        ]),
      ]),
      h('div', { class: 'hide-grid compact' }, [
        ...[['logs', '日志'], ['servers', '服务器'], ['terracotta', '联机'], ['hosts', '开服'], ['migrate', '迁移']]
          .map(([key, label]) => h('div', { class: `hide-chip ${(state.settings.hiddenPages || []).includes(key) ? 'on' : ''}` }, [
            h('span', {}, label), switchEl((state.settings.hiddenPages || []).includes(key), (v) => setHiddenPage(key, v)),
          ])),
        ...[['maps', '地图'], ['schematics', '投影'], ['sources', '资源站']]
          .map(([key, label]) => h('div', { class: `hide-chip ${(state.settings.hiddenTabs || []).includes(key) ? 'on' : ''}` }, [
            h('span', {}, label), switchEl((state.settings.hiddenTabs || []).includes(key), (v) => setHiddenTab(key, v)),
          ])),
      ]),
    ]),
    settingRow('数据目录', '实例、账户、存档与日志都在这里。', h('div', { class: 'row' }, [
      h('span', { class: 'mono small', style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, state.root || '—'),
      h('button', { class: 'btn btn-sm', onclick: () => copyText(state.root || '') }, '复制'),
    ])),
  ], '改完立即生效并自动保存，不用重启，也不用拍打机箱。', () => resetSection('general'));
}

function creditsCard() {
  const items = [
    ['A', 'Applefish', 'CraftDeck 作者 · 负责写代码、修 bug，以及偶尔假装一切都在计划之中。', ''],
    ['M', 'Mojang Studios', 'Minecraft 游戏本体和官方 API；没有它，我们只能启动一个空文件夹。', 'https://www.minecraft.net/'],
    ['科', 'MC百科', '中文模组资料救星。看不懂英文描述时，来这里就对了。', 'https://www.mcmod.cn/'],
    ['H', '红河 MC', '感谢提供图标与资源支持，让启动器看起来不像 2008 年的作业。', 'https://honghemc.cn/app/index.html'],
    ['R', 'Modrinth', '模组、整合包、材质与光影的搜索下载主力，API 也还算说人话。', 'https://modrinth.com/'],
    ['F', 'FabricMC / QuiltMC', '轻量加载器，让老电脑也能体面地跑起来。', 'https://fabricmc.net/'],
    ['N', 'MinecraftForge / NeoForged', '模组生态老大哥，启动慢一点，但东西是真的多。', 'https://minecraftforge.net/'],
    ['A', 'authlib-injector', '第三方皮肤站登录支持，终于不用顶着一张默认脸。', 'https://authlib-injector.yushi.moe/'],
    ['T', 'Terracotta 陶瓦联机', '没公网 IP 也能联机，魔法程度大概相当于红石电路。', 'https://github.com/burningtnt/Terracotta'],
    ['C', 'CFPA 汉化组', '汉化组，让模组不再用英文考验你的四级。', 'https://github.com/CFPAOrg/Minecraft-Mod-Language-Package'],
    ['P', 'PaperMC / PurpurMC', '高性能服务端核心，开服玩家的老朋友。', 'https://papermc.io/'],
    ['E', 'Electron / Node.js', '让我们用网页技术写桌面软件，并为此付出一点内存代价。', 'https://www.electronjs.org/'],
    ['H', 'HMCL / Prism Launcher / PCL2', '参考了交互和视觉；如果看起来顺手，那是站在他们肩膀上。', ''],
  ];
  return card('开源项目与致谢', [
    h('div', { class: 'sponsor-banner' }, [
      h('div', {}, [
        h('div', { class: 'sponsor-title' }, '如果 CraftDeck 帮你省下了找模组的时间'),
        h('div', { class: 'sponsor-sub' }, '赞助一点，让作者少接两个广告，多写两行代码。'),
      ]),
      h('a', {
        class: 'btn btn-primary', href: SPONSOR_URL, target: '_blank', rel: 'noreferrer',
        style: { padding: '10px 22px', fontSize: '13.5px', flex: '0 0 auto' },
      }, '❤ 请作者喝杯茶'),
    ]),
    h('div', { class: 'social-row' }, [
      h('a', {
        class: 'social-btn bili', href: 'https://b23.tv/KjzsMYe', target: '_blank', rel: 'noreferrer', title: '哔哩哔哩 · Applefish20',
        html: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6.7 3.3 9 5.5h6l2.3-2.2c.4-.4 1-.4 1.4 0s.4 1 0 1.4L17.2 6H19a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h1.8L5.3 4.7c-.4-.4-.4-1 0-1.4s1-.4 1.4 0ZM5 8a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H5Zm3.2 4.2c.5-.5 1.3-.5 1.8 0s.5 1.3 0 1.8-1.3.5-1.8 0-.5-1.3 0-1.8Zm5.8 0c.5-.5 1.3-.5 1.8 0s.5 1.3 0 1.8-1.3.5-1.8 0-.5-1.3 0-1.8Z"/></svg>',
      }),
      h('a', {
        class: 'social-btn douyin', href: 'https://v.douyin.com/ytZut3zfv60/', target: '_blank', rel: 'noreferrer', title: '抖音 · Applefish',
        html: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M14.5 3c.3 2 1.6 3.4 3.8 3.7v3.1a7 7 0 0 1-3.8-1.2v5.9a5.7 5.7 0 1 1-5-5.6v3.2a2.5 2.5 0 1 0 1.8 2.4V3h3.2Z"/></svg>',
      }),
      h('a', {
        class: 'social-btn kuaishou', href: 'https://www.kuaishou.com/profile/3x9gd99rj3qe85u?source=NewReco', target: '_blank', rel: 'noreferrer', title: '快手 · Applefish',
        html: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 3a8.5 8.5 0 1 1-8.4 9.9h3.1A5.6 5.6 0 1 0 12 6.6V3Zm0 5.2a3.3 3.3 0 1 1-3.3 3.3H5.5A6.5 6.5 0 1 0 12 5V8.2Z"/></svg>',
      }),
    ]),
    h('div', { class: 'label', style: { margin: '4px 0 2px' } }, '我的社交账号'),
    h('div', { class: 'social-link-list' }, [
      h('a', { href: 'https://b23.tv/KjzsMYe', target: '_blank', rel: 'noreferrer' }, [
        h('strong', {}, '哔哩哔哩'), h('span', {}, 'Applefish20 · b23.tv/KjzsMYe'),
      ]),
      h('a', { href: 'https://v.douyin.com/ytZut3zfv60/', target: '_blank', rel: 'noreferrer' }, [
        h('strong', {}, '抖音'), h('span', {}, 'Applefish · v.douyin.com/ytZut3zfv60'),
      ]),
      h('a', { href: 'https://www.kuaishou.com/profile/3x9gd99rj3qe85u?source=NewReco', target: '_blank', rel: 'noreferrer' }, [
        h('strong', {}, '快手'), h('span', {}, 'Applefish · 点这里打开主页'),
      ]),
    ]),
    h('p', { class: 'hint', style: { marginBottom: '12px', lineHeight: '1.7' } },
      'CraftDeck 站在这些优秀开源项目和公开服务的肩膀上。没有它们，这玩意大概率只能启动一个记事本。'),
    h('div', { class: 'credit-list' }, items.map(([icon, name, desc, url]) => h('div', { class: 'credit-item' }, [
      h('div', { class: 'ci-icon' }, icon),
      h('div', { class: 'ci-main' }, [
        h('div', { class: 'ci-name' }, url ? h('a', { href: url, target: '_blank', rel: 'noreferrer' }, name) : name),
        h('div', { class: 'ci-desc' }, desc),
      ]),
    ]))),
  ], '以上项目版权归各自作者所有；CraftDeck 仅调用其公开接口。顺便说一句，开源真好。');
}

function guideCard() {
  const step = (n, title, text) => h('div', { class: 'guide-step' }, [
    h('div', { class: 'guide-num' }, String(n)),
    h('div', {}, [h('div', { class: 'guide-title' }, title), h('div', { class: 'guide-text' }, text)]),
  ]);
  return card('新手教程', [
    h('div', { class: 'guide-list' }, [
      step(1, '下载游戏版本', '左侧「版本下载」→ 点一个大版本（如 1.21）→ 选小版本 →「安装到实例」。首次会下载客户端、依赖库和资源文件。'),
      step(2, '启动游戏', '回「实例」页，选中实例 → 点「启动」。实例「内容 → 设置」可以单独分配内存、Java 和 JVM 参数。'),
      step(3, '账户与皮肤', '「账户」页添加离线 / 微软正版 / LittleSkin 第三方账户；「皮肤」页上传或从 LittleSkin 在线皮肤库下载，正版账户可同步到 Mojang。'),
      step(4, '模组与整合包', '「模组」搜索 Modrinth，「整合包」安装 mrpack；安装时选择目标实例。实例「内容 → Mod 管理」可启用/禁用/删除。'),
      step(5, '光影与材质', '「材质与光影」下载资源包/光影包；光影需要 Iris 或 OptiFine。实例「内容 → 光影与材质」管理已安装文件。'),
      step(6, '联机与开服', '「陶瓦联机」创建/加入房间；「服务器列表」收藏服务器；「开服中心」一键下载并启动服务端。'),
      step(7, '从其他启动器迁移', '左侧「迁移导入」自动扫描 PCL / HMCL / 官方启动器的 .minecraft，选择版本点「一键迁移」，会复制 mods、config、存档、光影等。'),
      step(8, '出问题怎么办', '「日志」页查看启动器/游戏日志；「反馈」页可直接把问题发到作者邮箱，并选择附带最近日志。'),
    ]),
    h('div', { class: 'callout info', style: { marginTop: '12px' } }, '小提示：所有数据都在设置 →「通用」显示的数据目录；重装启动器不会删除实例与存档。'),
  ], '第一次使用建议按顺序看一遍，遇到问题先看「日志」和「反馈」。');
}

function updateCard() {
  const s = state.settings;
  const feed = h('input', { class: 'input', value: s.updateFeedUrl || '', placeholder: 'https://你的更新源/update.json' });
  const status = h('div', { class: 'tool-result' }, '填写 update.json 地址后即可检查新版本；留空则不检查。');
  const check = h('button', { class: 'btn btn-primary', onclick: async () => {
    try {
      await save({ updateFeedUrl: feed.value.trim() });
      status.className = 'tool-result'; status.textContent = '正在检查更新…';
      const r = await api('/api/update/check');
      if (!r.configured) { status.className = 'tool-result warn'; status.textContent = '还没有配置更新地址。'; return; }
      if (!r.hasUpdate) { status.className = 'tool-result ok'; status.textContent = `已是最新版本（${r.current}）。`; return; }
      status.className = 'tool-result ok';
      status.replaceChildren(
        h('div', {}, `发现新版本 ${r.latest}（当前 ${r.current}）`),
        r.notes ? h('div', { style: { marginTop: '6px' } }, r.notes) : null,
        r.url ? h('a', { class: 'btn btn-sm btn-primary', href: r.url, target: '_blank', rel: 'noreferrer', style: { marginTop: '8px', display: 'inline-block' } }, '下载更新包') : null,
      );
    } catch (e) { status.className = 'tool-result err'; status.textContent = '检查失败：' + e.message; }
  } }, '检查更新');
  return card('自动更新', [
    h('div', { class: 'callout info' }, '更新检查读取一个 JSON 文件；发现新版本会给出下载按钮。更新包需要你放到可访问的网址上。'),
    h('div', { class: 'field' }, [h('label', {}, '更新源 update.json'), feed]),
    h('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
      h('label', { class: 'row', style: { gap: '8px' } }, [
        switchEl(s.autoCheckUpdate, (v) => save({ autoCheckUpdate: v })),
        h('span', { class: 'small' }, '启动时自动检查更新'),
      ]),
      check,
    ]),
    status,
    h('div', { class: 'hint' }, 'update.json 示例：{"version":"2.7.2","url":"https://.../CraftDeck-2.7.2-win64-full.zip","notes":"更新内容"}'),
  ], '配置更新源后，启动器会在设置中检查新版本。', () => resetSection('update'));
}

function feedbackCard() {
  const categories = ['使用问题', '启动/崩溃', '下载/安装', '联机/开服', '皮肤/账户', '功能建议', '其他'];
  const category = h('select', { class: 'select' }, categories.map((c) => h('option', { value: c }, c)));
  const contact = h('input', { class: 'input', placeholder: '你的 QQ / 邮箱（可选，方便回复）' });
  const message = h('textarea', { class: 'textarea', rows: 6, placeholder: '请描述你遇到的问题：版本号、操作步骤、报错文字。' });
  const withLogs = switchEl(false);
  const status = h('div', { class: 'tool-result' }, '可以直接用邮件发送，或尝试启动器自动发送；邮箱地址不会显示在界面中。');

  const bodyText = () => [
    `反馈类型：${category.value}`,
    `联系方式：${contact.value.trim() || '未填写'}`,
    '启动器版本：3.6.1',
    '',
    message.value.trim(),
    withLogs.querySelector('input')?.checked ? '\n（附：启动器最近日志可在设置 → 日志中导出）' : '',
  ].join('\n');

  const mailUrl = () => `mailto:${'pakagchong@qq.com'}?subject=${encodeURIComponent('[CraftDeck 反馈] ' + category.value)}&body=${encodeURIComponent(bodyText())}`;

  const mailBtn = h('button', { class: 'btn btn-primary', onclick: () => {
    if (message.value.trim().length < 5) { status.className = 'tool-result err'; status.textContent = '请至少写 5 个字。'; return; }
    const url = mailUrl();
    if (window.desktopWindow?.openExternal) window.desktopWindow.openExternal(url);
    else window.location.href = url;
    status.className = 'tool-result ok';
    status.textContent = '已打开邮件客户端，确认内容后发送即可。';
  } }, '用邮件发送');

  const sendBtn = h('button', { class: 'btn', onclick: async () => {
    if (message.value.trim().length < 5) { status.className = 'tool-result err'; status.textContent = '请至少写 5 个字。'; return; }
    sendBtn.disabled = true; sendBtn.textContent = '发送中…'; status.className = 'tool-result'; status.textContent = '正在尝试自动发送…';
    try {
      const r = await api('/api/feedback', {
        method: 'POST',
        body: { category: category.value, contact: contact.value.trim(), message: message.value.trim(), withLogs: !!withLogs.querySelector('input')?.checked, version: '3.6.1' },
      });
      if (r.ok) {
        status.className = 'tool-result ok';
        status.textContent = `已发送（编号 ${r.id}）。感谢你的反馈！`;
        message.value = '';
        toastOk('反馈已发送', '作者会尽快查看');
      } else {
        status.className = 'tool-result warn';
        status.textContent = r.activation
          ? '自动发送通道首次使用需要激活，暂时不可用。请点「用邮件发送」，内容已经填好。'
          : '自动发送没有成功，请点「用邮件发送」作为备用方式。';
      }
    } catch (e) {
      status.className = 'tool-result err';
      status.textContent = '自动发送失败，请点「用邮件发送」。';
    } finally { sendBtn.disabled = false; sendBtn.textContent = '尝试自动发送'; }
  } }, '尝试自动发送');

  return card('反馈建议', [
    h('div', { class: 'callout info' }, '反馈会发送到作者邮箱（地址已隐藏）。请勿填写账号密码或令牌。'),
    h('div', { class: 'field' }, [h('label', {}, '问题类型'), category]),
    h('div', { class: 'field' }, [h('label', {}, '联系方式'), contact]),
    h('div', { class: 'field' }, [h('label', {}, '问题描述'), message]),
    h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' } }, [
      h('label', { class: 'row', style: { gap: '8px' } }, [withLogs, h('span', { class: 'small' }, '附带最近日志（帮助定位）')]),
      h('div', { class: 'row' }, [sendBtn, mailBtn]),
    ]),
    status,
  ], '推荐直接点「用邮件发送」，兼容性最好；自动发送通道可能需要作者先激活。');
}

function disclaimerCard() {
  return card('使用条款', [
    h('div', { class: 'col', style: { gap: '10px', fontSize: '12.5px', color: 'var(--text-dim)', lineHeight: '1.8' } }, [
      h('p', {}, '1. CraftDeck 是第三方《我的世界》启动器，与 Mojang Studios、Microsoft 没有任何隶属关系。'),
      h('p', {}, '2. 《Minecraft》版权归 Mojang Studios 所有。请通过官方渠道购买正版，本程序不提供游戏本体。'),
      h('p', {}, '3. 离线账户、第三方皮肤站与镜像源均由第三方提供，其可用性与合规性不受本程序控制；使用离线模式可能违反部分服务器规则，请自行判断。'),
      h('p', {}, '4. 陶瓦联机（Terracotta）以 AGPL-3.0-or-later 许可发布，本程序仅通过其公开 HTTP API 调用，未修改其二进制，并在界面中注明版权。'),
      h('p', {}, '5. 本程序按「现状」提供，作者不对数据丢失、账号风险或服务器封禁承担责任；请定期备份存档。'),
      h('p', {}, '6. 本程序不收集、不上传任何账号令牌或个人数据；所有配置与令牌仅保存在本机数据目录。'),
      h('p', {}, '7. 地图、投影、材质、光影、模组与整合包可能来自 CurseForge、Modrinth、Planet Minecraft、我的世界中文站、ResourcePack.net、Minecraft Maps、ShadersMods、MCIMG 等第三方站点。这些内容由第三方提供，本程序不存储、不代理、不审核，也不保证其安全性、完整性或版权合规；下载后请自行查毒并遵守对应站点条款。'),
      h('p', {}, '8. 本程序不收集姓名、手机号、身份证、位置、通讯录等个人信息，也不包含行为统计或遥测上报。日志、账户、皮肤与存档仅保存在本机，除你主动发起的网络请求外不会外传。'),
      h('p', {}, '9. 请通过 Mojang / Microsoft 官方渠道购买并游玩《Minecraft》。第三方下载资源的版权归原作者所有，请勿将资源用于商业用途或二次分发。'),
      h('p', {}, '10. 继续使用本程序即表示你理解并同意：因使用第三方资源、离线账户、第三方登录或镜像源产生的风险由你自行承担。'),
    ]),
  ], '使用本程序即表示你已阅读并同意以上说明。');
}

function sectionCards(tab) {
  switch (tab) {
    case 'appearance': return [appearanceCard()];
    case 'java': return [javaCard()];
    case 'download': return [downloadCard()];
    case 'account': return [accountCard()];
    case 'guide': return [guideCard()];
    case 'feedback': return [feedbackCard()];
    case 'update': return [updateCard()];
    case 'credits': return [creditsCard()];
    case 'about': return [aboutCard(), disclaimerCard()];
    default: return [generalCard()];
  }
}

export default {
  async render(el, ctx) {
    view = el; ctxRef = ctx;
    const requested = ctx.route === 'toolbox' ? 'toolbox' : (ctx.param || '');
    if (requested && TABS.some((t) => t.key === requested)) activeTab = requested;
    else if (!TABS.some((t) => t.key === activeTab)) activeTab = 'general';
    view.innerHTML = '';

    const menu = h('div', { class: 'settings-menu' }, TABS.map((t) => h('button', {
      class: `settings-tab ${t.key === activeTab ? 'active' : ''}`,
      dataset: { key: t.key },
      onclick: () => {
        activeTab = t.key;
        for (const b of menu.querySelectorAll('button')) b.classList.toggle('active', b.dataset.key === activeTab);
        renderContent();
      },
    }, [h('span', { class: 'settings-icon', html: icon(t.icon, 17) }), h('span', {}, t.label)])));

    const content = h('div', { class: 'settings-content' });
    const renderContent = () => {
      const tab = TABS.find((t) => t.key === activeTab) || TABS[0];
      content.replaceChildren(
        h('div', { class: 'settings-content-title' }, [h('h2', {}, tab.label)]),
        ...sectionCards(activeTab),
      );
      content.scrollTop = 0;
    };

    view.append(h('div', { class: 'settings-layout' }, [menu, content]));
    renderContent();
    // Java 扫描和媒体列表可能较慢，不阻塞设置页首屏；完成后只在对应页刷新。
    Promise.all([loadJava(), loadMedia()]).then(() => {
      if (activeTab === 'java' || activeTab === 'appearance') renderContent();
    }).catch(() => { /* 页面已渲染，错误由各卡片展示空状态 */ });
  },
  destroy() { view = null; ctxRef = null; },
};
