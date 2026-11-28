/* 开服中心：本地服务器创建 / 启停 / 日志 / 属性 */
import {
  h, badge, toastOk, toastErr, modal, confirmDialog, loadingBlock, emptyState, sectionTitle,
  progressBar, rangeRow, switchEl, kvList, fmtBytes,
} from '../ui.js';
import { state, api, subscribe } from '../state.js';
import { icon } from '../icons.js';

const HOST_TYPES = [
  ['vanilla', '原版 Vanilla'], ['fabric', 'Fabric'], ['paper', 'Paper'],
  ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['purpur', 'Purpur'],
];
const STATUS = {
  running: ['运行中', 'ok'], starting: ['启动中', 'accent'], stopping: ['停止中', 'warn'],
  stopped: ['已停止', ''], installing: ['安装中', 'warn'], error: ['异常', 'err'],
};
const typeLabel = (t) => (HOST_TYPES.find((x) => x[0] === t) || [t, t || '未知'])[1];
const isRunningHost = (host) => String(host.status || '') === 'running' || host.running === true;
const callout = (kind, text, icon = 'i') =>
  h('div', { class: `callout ${kind}` }, [h('span', { class: 'c-icon' }, icon), h('div', {}, text)]);

let alive = true;
let unsub = null;
let logTimer = null;
let logModal = null;
let logLive = null;
let createDialog = null;
let propsModal = null;
let createUI = null;

function clearLogPoll() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }

function pickArray(data, keys) {
  if (Array.isArray(data)) return data;
  for (const k of keys) if (Array.isArray(data && data[k])) return data[k];
  return [];
}

function pickHosts(data) { return pickArray(data, ['hosts', 'servers', 'list']).filter((x) => x && typeof x === 'object'); }

/** 日志接口可能是 {lines:[]} / {log:'...'} / 纯字符串，尽量兼容 */
function logLinesOf(data) {
  if (Array.isArray(data)) return data.map((x) => (typeof x === 'string' ? x : String((x && (x.line || x.message)) || '')));
  const v = data && (data.lines ?? data.log ?? data.logs ?? data.tail ?? data.content);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x && (x.line || x.message)) || '')));
  return typeof v === 'string' ? v.split(/\r?\n/) : [];
}

/* ---------------- 顶部信息卡片 ---------------- */
function topCard(title, icon, extra, body) {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('div', { class: 'panel-title' }, `${icon} ${title}`),
      h('div', { class: 'row', style: { gap: '6px' } }, extra || []),
    ]),
    body,
  ]);
}

function javaCard(data, error, ctx) {
  const list = pickArray(data, ['javas', 'java', 'list', 'items']);
  const rescan = h('button', {
    class: 'btn btn-sm',
    onclick: async (ev) => {
      const btn = ev.currentTarget;
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = '检测中…';
      try {
        await api('/api/java');
        toastOk('Java 检测完成', '正在刷新运行时信息');
        if (alive) ctx.refresh();
      } catch (e) {
        toastErr('检测 Java 失败', e.message);
        btn.disabled = false; btn.textContent = label;
      }
    },
  }, '重新检测');

  let body;
  if (error) body = callout('err', '无法读取 Java 运行时：' + error);
  else if (!list.length) body = callout('warn', '未检测到可用的 Java。请安装 Java 21 或更高版本，然后点击「重新检测」。');
  else {
    body = h('div', { class: 'col', style: { gap: '7px', maxHeight: '196px', overflow: 'auto', paddingRight: '4px' } },
      list.map((item) => {
        const j = typeof item === 'string' ? { path: item } : (item || {});
        return h('div', { class: 'list-item', style: { padding: '8px 11px' } }, [
          h('div', { class: 'li-main' }, [
            h('div', { class: 'row', style: { gap: '7px', flexWrap: 'wrap' } }, [
              badge(`Java ${j.major || '?'}`, 'accent'),
              h('span', { style: { fontWeight: '600', fontSize: '12px' } }, j.version || '未知版本'),
              j.vendor ? h('span', { class: 'hint' }, j.vendor) : null,
            ]),
            h('div', { class: 'li-sub mono ellipsis' }, j.path || '—'),
          ]),
        ]);
      }));
  }
  return topCard('Java 运行时', '☕', [list.length ? badge(`${list.length} 个`, 'ok') : null, rescan], body);
}

function systemCard(data, error) {
  let body;
  if (error) body = callout('err', '无法读取本机信息：' + error);
  else {
    const d = data || {};
    const total = Number(d.totalMemMb) || 0;
    const free = Number(d.freeMemMb) || 0;
    body = kvList([
      ['CPU', d.cpus ? `${d.cpus} 核` : '—'],
      ['内存', total ? `${fmtBytes(total * 1024 * 1024)}（可用 ${fmtBytes(free * 1024 * 1024)}）` : '—'],
      ['平台', [d.platform, d.arch].filter(Boolean).join(' / ') || '—'],
      ['主机名', d.hostname || '—'],
      ['Node', d.node || '—'],
      ['数据目录', d.root || '—'],
    ]);
  }
  return topCard('本机信息', '▣', [badge('自动检测', 'violet')], body);
}

/* ---------------- 服务器卡片 ---------------- */
function hostCard(host, live, ctx) {
  const running = isRunningHost(host);
  const status = String(host.status || (running ? 'running' : 'stopped'));
  const [statusText, statusKind] = STATUS[status] || [status || '未知', ''];
  const id = String(host.id);
  let rec = live.get(id);
  const logEl = h('div', { class: 'host-log', style: { height: '74px', fontSize: '10.5px' } },
    rec && rec.lines.length ? rec.lines.slice(-40).join('\n') : '等待日志输出…');
  if (!rec) { rec = { lines: [], el: logEl }; live.set(id, rec); } else rec.el = logEl;

  const startStop = h('button', {
    class: `btn btn-sm ${running ? 'btn-danger' : 'btn-ok'}`,
    onclick: async (ev) => {
      const btn = ev.currentTarget;
      if (btn.disabled) return;
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = running ? '停止中…' : '启动中…';
      try {
        await api(`/api/hosts/${encodeURIComponent(host.id)}/${running ? 'stop' : 'start'}`, { method: 'POST' });
        toastOk(running ? '正在停止服务器' : '正在启动服务器', host.name || '');
        if (alive) ctx.refresh();
      } catch (e) {
        toastErr(running ? '停止服务器失败' : '启动服务器失败', e.message);
        btn.disabled = false; btn.textContent = label;
      }
    },
  }, running ? '停止' : '启动');

  return h('div', { class: 'host-card' }, [
    h('div', { class: 'host-head' }, [
      h('div', { class: 'row', style: { gap: '8px', minWidth: '0' } }, [
        h('span', { class: `dot ${running ? 'on' : ''}` }),
        h('div', { class: 'srv-name ellipsis' }, host.name || '未命名服务器'),
        badge(statusText, statusKind),
      ]),
      startStop,
    ]),
    h('div', { class: 'hint' },
      `${typeLabel(host.type)} · ${host.gameVersion || host.version || host.versionId || '—'} · 端口 ${host.port || 25565} · 内存 ${host.memoryMb || 2048} MB`),
    h('div', { class: 'hint mono' }, `localhost:${host.port || 25565}`),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [
      h('button', { class: 'btn btn-sm', onclick: () => openLog(host) }, '控制台'),
      h('button', { class: 'btn btn-sm', onclick: (ev) => openProperties(host, ev.currentTarget, ctx) }, '属性'),
      h('button', {
        class: 'btn btn-sm btn-danger',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          if (btn.disabled) return;
          const ok = await confirmDialog({
            title: '删除服务器',
            message: `确定要删除「${host.name || '该服务器'}」吗？服务器目录（地图、配置、日志）会被一并删除，无法恢复。`,
            okText: '删除', danger: true,
          });
          if (!ok) return;
          const label = btn.textContent;
          btn.disabled = true; btn.textContent = '删除中…';
          try {
            await api(`/api/hosts/${encodeURIComponent(host.id)}`, { method: 'DELETE' });
            toastOk('服务器已删除', host.name || '');
            if (alive) ctx.refresh();
          } catch (e) {
            toastErr('删除服务器失败', e.message);
            btn.disabled = false; btn.textContent = label;
          }
        },
      }, '删除'),
    ]),
    logEl,
  ]);
}

/* ---------------- 日志弹窗 ---------------- */
async function openLog(host) {
  if (logModal) logModal.close();
  const pre = h('pre', { class: 'host-log', style: { height: '360px', fontSize: '11.5px' } }, '正在读取日志…');
  let closed = false;
  let warned = false;
  logLive = { id: String(host.id), el: pre, lines: [] };

  const refresh = async () => {
    if (closed) return;
    try {
      const r = await api(`/api/hosts/${encodeURIComponent(host.id)}/logs?tail=300`);
      if (closed) return;
      const lines = logLinesOf(r).slice(-300);
      logLive.lines = lines;
      pre.textContent = lines.length ? lines.join('\n') : '（暂无日志，启动服务器后这里会显示输出）';
      pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      if (closed) return;
      if (!pre.textContent || pre.textContent === '正在读取日志…') pre.textContent = '读取日志失败：' + e.message;
      if (!warned) { warned = true; toastErr('读取服务器日志失败', e.message); }
    }
  };

  logModal = modal({
    title: `控制台 · ${host.name || '服务器'}`,
    wide: true,
    body: [
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
        h('span', { class: `dot ${isRunningHost(host) ? 'on' : ''}` }),
        h('span', { class: 'hint' }, `${typeLabel(host.type)} · ${host.gameVersion || host.version || '—'} · localhost:${host.port || 25565}`),
        h('span', { class: 'spacer' }),
        h('span', { class: 'hint' }, '每 5 秒自动刷新'),
      ]),
      pre,
      h('div', { class: 'hint' }, '窗口打开期间会通过 SSE 追加实时输出；关闭窗口即停止轮询。'),
    ],
    actions: [{ label: '关闭' }],
    onClose: () => { closed = true; clearLogPoll(); logModal = null; logLive = null; },
  });

  await refresh();
  if (!closed) logTimer = setInterval(refresh, 5000);
}

/* ---------------- 属性编辑弹窗 ---------------- */
async function openProperties(host, btn, ctx) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '读取中…';
  let props = null;
  let error = null;
  try {
    const r = await api(`/api/hosts/${encodeURIComponent(host.id)}/properties`);
    props = (r && (r.properties || r.props)) || {};
  } catch (e) { error = e; }
  btn.disabled = false; btn.textContent = label;
  if (error) { toastErr('读取服务器属性失败', error.message); return; }
  if (!alive) return;

  const text = Object.entries(props).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${String(v)}`).join('\n');
  const area = h('textarea', { class: 'textarea', rows: 18, spellcheck: 'false', style: { minHeight: '300px' } }, text);
  propsModal = modal({
    title: `服务器属性 · ${host.name || '服务器'}`,
    wide: true,
    body: [
      h('div', { class: 'hint' }, '每行一条 key=value，以 # 开头的行会被忽略。保存后需要重启服务器才能生效。'),
      area,
      callout('warn', 'server.properties 属于高级配置，请确认键名与取值正确后再保存。', '!'),
    ],
    actions: [
      { label: '取消' },
      {
        label: '保存', kind: 'primary',
        onClick: async (ev, close) => {
          const saveBtn = ev.currentTarget;
          if (saveBtn.disabled) return false;
          const properties = {};
          for (const raw of area.value.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const i = line.indexOf('=');
            if (i > 0) properties[line.slice(0, i).trim()] = line.slice(i + 1).trim();
          }
          if (!Object.keys(properties).length) { toastErr('没有可保存的属性', '请检查 key=value 格式'); return false; }
          saveBtn.disabled = true; saveBtn.textContent = '保存中…';
          try {
            await api(`/api/hosts/${encodeURIComponent(host.id)}/properties`, { method: 'PUT', body: { properties } });
            toastOk('属性已保存', '重启服务器后生效');
            close();
            if (alive) ctx.refresh();
          } catch (e) {
            toastErr('保存属性失败', e.message);
            saveBtn.disabled = false; saveBtn.textContent = '保存';
          }
          return false;
        },
      },
    ],
    onClose: () => { propsModal = null; },
  });
}

/* ---------------- 新建服务器弹窗 ---------------- */
async function openCreate(ctx, trigger) {
  if (!trigger || trigger.disabled) return;
  const triggerLabel = trigger.textContent;
  trigger.disabled = true; trigger.textContent = '读取版本列表…';
  let releases = [];
  try {
    const r = await api('/api/versions');
    const all = pickArray(r, ['versions', 'list']);
    releases = all.filter((v) => v && v.type === 'release' && v.id);
    if (!releases.length) releases = all.filter((v) => v && v.id);
  } catch (e) {
    toastErr('读取游戏版本失败', e.message);
    trigger.disabled = false; trigger.textContent = triggerLabel;
    return;
  }
  trigger.disabled = false; trigger.textContent = triggerLabel;
  if (!alive) return;

  const field = (label, control, hint) => h('div', { class: 'field' }, [
    h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null,
  ]);
  const nameInput = h('input', { class: 'input', value: '我的服务器', maxlength: '40' });
  const versionSelect = h('select', { class: 'select' },
    releases.length ? releases.map((v) => h('option', { value: v.id }, v.id)) : h('option', { value: '' }, '（暂无可用版本）'));
  const typeSelect = h('select', { class: 'select' }, HOST_TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const portInput = h('input', { class: 'input', type: 'number', min: '1', max: '65535', value: '25565' });
  let memoryMb = 2048;
  const memoryRow = rangeRow({ min: 512, max: 16384, step: 256, value: memoryMb, onChange: (v) => { memoryMb = v; } });
  const motdInput = h('input', { class: 'input', value: '欢迎来到我的服务器', maxlength: '120' });
  const maxInput = h('input', { class: 'input', type: 'number', min: '1', max: '200', value: '20' });
  let onlineMode = true;
  let eula = true;

  const progLabel = h('div', { class: 'hint' }, '正在准备服务端…');
  const progBar = h('div', {}, progressBar(0));
  const progLog = h('div', { class: 'host-log', style: { height: '120px', fontSize: '10.5px' } });
  const progArea = h('div', { class: 'col', style: { display: 'none', gap: '8px', borderTop: '1px solid var(--line)', paddingTop: '12px' } }, [
    h('div', { class: 'row', style: { gap: '8px' } }, [progLabel, h('span', { class: 'spacer' }), h('span', { class: 'hint' }, '可能需要 1-3 分钟')]),
    progBar,
    progLog,
  ]);

  let lines = [];
  let lastFinished = false;
  const ui = {
    armed: false,
    hostId: null,
    append(line) {
      lines.push(String(line));
      if (lines.length > 300) lines.splice(0, lines.length - 300);
      progLog.textContent = lines.join('\n');
      progLog.scrollTop = progLog.scrollHeight;
    },
    progress(task) {
      let pct = Number(task.percent);
      if (!Number.isFinite(pct)) pct = task.total ? (Number(task.done) || 0) / (Number(task.total) || 1) : 0;
      if (pct > 1) pct = pct > 100 ? 1 : pct / 100;
      if (!Number.isFinite(pct) || pct < 0) pct = 0;
      progBar.replaceChildren(progressBar(pct));
      progLabel.textContent = `${task.label || '正在准备服务端'} · ${Math.round(pct * 100)}%`;
      if (!lastFinished && task.error) {
        lastFinished = true;
        ui.append('✕ ' + task.error);
      } else if (task.finished && !lastFinished) {
        lastFinished = true;
        ui.append(task.ok === false ? '✕ 服务端准备失败' : '✓ 服务端准备完成');
      }
    },
  };
  createUI = ui;

  createDialog = modal({
    title: '新建本地服务器',
    wide: true,
    body: [
      callout('info', '服务端将下载到本机数据目录并写入 server.properties / eula.txt。首次创建需要下载服务端核心，请耐心等待。'),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } }, [
        field('服务器名称', nameInput),
        field('游戏版本', versionSelect),
        field('服务端类型', typeSelect),
        field('端口', portInput, '默认 25565，冲突时请修改'),
        field('内存分配', memoryRow, '建议 2048 MB 以上'),
        field('最大玩家数', maxInput),
        h('div', { style: { gridColumn: '1 / -1' } }, field('MOTD（服务器列表显示的文字）', motdInput)),
      ]),
      h('div', { class: 'row', style: { gap: '20px', flexWrap: 'wrap' } }, [
        switchEl(true, (v) => { onlineMode = v; }, '正版验证（online-mode）'),
        switchEl(true, (v) => { eula = v; }, '同意 Minecraft EULA'),
      ]),
      progArea,
    ],
    actions: [
      { label: '取消' },
      {
        label: '创建服务器', kind: 'primary',
        onClick: async (ev, close) => {
          const btn = ev.currentTarget;
          if (btn.disabled) return false;
          const name = String(nameInput.value || '').trim();
          const version = String(versionSelect.value || '');
          const port = Number(portInput.value);
          if (!name) { toastErr('请填写服务器名称'); return false; }
          if (!version) { toastErr('请选择游戏版本'); return false; }
          if (!Number.isInteger(port) || port < 1 || port > 65535) { toastErr('端口不合法', '请输入 1-65535 之间的整数'); return false; }
          if (!eula) { toastErr('需要同意 EULA', '未同意 Minecraft 最终用户许可协议，无法创建服务器'); return false; }

          btn.disabled = true; btn.textContent = '正在下载服务端…';
          progArea.style.display = 'flex';
          ui.armed = true;
          progLabel.textContent = '正在创建服务器…';
          ui.append(`[启动器] 正在创建 ${name}（${typeSelect.value} ${version}，端口 ${port}）`);
          try {
            await api('/api/hosts', {
              method: 'POST',
              body: {
                name, gameVersion: version, type: typeSelect.value, port, memoryMb,
                motd: String(motdInput.value || '').trim(),
                maxPlayers: Math.max(1, Number(maxInput.value) || 20),
                eula: true, onlineMode,
              },
            });
            toastOk('服务器已创建', `${name} 已准备就绪，可在列表中启动`);
            ui.armed = false;
            close();
            if (alive) ctx.refresh();
          } catch (e) {
            toastErr('创建服务器失败', e.message);
            ui.append('✕ 创建失败：' + e.message);
            btn.disabled = false; btn.textContent = '重试创建';
            return false;
          }
          return false;
        },
      },
    ],
    onClose: () => {
      ui.armed = false;
      if (createUI === ui) createUI = null;
      createDialog = null;
    },
  });
}

/* ---------------- SSE ---------------- */
function handleEvent(e, live) {
  if (e.type === 'host' && e.evt) {
    const evt = e.evt;
    const id = evt.hostId || evt.id || evt.host;
    const line = evt.line ?? evt.message;
    if (id === undefined || id === null || line === undefined || line === null) return;
    const key = String(id);
    const rec = live.get(key);
    if (rec) {
      rec.lines.push(String(line));
      if (rec.lines.length > 200) rec.lines.splice(0, rec.lines.length - 200);
      if (rec.el && rec.el.isConnected) {
        rec.el.textContent = rec.lines.slice(-40).join('\n');
        rec.el.scrollTop = rec.el.scrollHeight;
      }
    }
    if (logLive && logLive.id === key) {
      logLive.lines.push(String(line));
      if (logLive.lines.length > 600) logLive.lines.splice(0, logLive.lines.length - 600);
      if (logLive.el && logLive.el.isConnected) {
        logLive.el.textContent = logLive.lines.join('\n');
        logLive.el.scrollTop = logLive.el.scrollHeight;
      }
    }
    if (createUI && createUI.armed) {
      if (!createUI.hostId) createUI.hostId = key;
      if (createUI.hostId === key) createUI.append(line);
    }
    return;
  }
  const task = e.type === 'task' ? e.task : (e.type === 'progress' ? (e.task || e) : null);
  if (!task || task.scope !== 'host') return;
  if (createUI && createUI.armed) {
    if (task.hostId) createUI.hostId = String(task.hostId);
    createUI.progress(task);
  }
}

/* ---------------- 页面 ---------------- */
async function render(view, ctx) {
  alive = true;
  view.replaceChildren(loadingBlock('正在读取开服环境…'));
  const [hostsRes, javaRes, systemRes] = await Promise.allSettled([
    api('/api/hosts'), api('/api/java'), api('/api/system'),
  ]);
  if (!alive) return;

  const hosts = hostsRes.status === 'fulfilled' ? pickHosts(hostsRes.value) : (Array.isArray(state.hosts) ? state.hosts : []);
  if (hostsRes.status === 'fulfilled') state.hosts = hosts;
  const hostError = hostsRes.status === 'rejected' ? hostsRes.reason : null;
  const hostErrorMsg = (hostError && hostError.message) || '未知错误';
  if (hostError) toastErr('读取服务器列表失败', hostErrorMsg);
  const live = new Map();
  unsub = subscribe((e) => handleEvent(e, live));

  const makeNewBtn = () => h('button', { class: 'btn btn-primary', html: `${icon('plus', 15)}<span>新建服务器</span>`, onclick: (ev) => openCreate(ctx, ev.currentTarget) });
  const newBtn = makeNewBtn();
  const list = hosts.length
    ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '14px' } },
      hosts.map((host) => hostCard(host, live, ctx)))
    : emptyState({
      icon: '⌂',
      title: hostError ? '无法读取服务器列表' : '还没有本地服务器',
      sub: hostError ? hostErrorMsg : '新建一个服务器，邀请朋友通过局域网或端口映射一起游玩。',
      action: makeNewBtn(),
    });

  view.replaceChildren(h('div', { class: 'home' }, [
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px' } }, [
      javaCard(javaRes.status === 'fulfilled' ? javaRes.value : null, javaRes.status === 'rejected' ? ((javaRes.reason && javaRes.reason.message) || '未知错误') : '', ctx),
      systemCard(systemRes.status === 'fulfilled' ? systemRes.value : null, systemRes.status === 'rejected' ? ((systemRes.reason && systemRes.reason.message) || '未知错误') : ''),
    ]),
    sectionTitle('本地服务器', h('div', { class: 'row', style: { gap: '8px' } }, [
      badge(`${hosts.length} 个`), newBtn,
    ])),
    hostError ? callout('err', '服务器列表读取失败：' + hostErrorMsg) : null,
    list,
    callout('info', '服务器运行在本机，启动后可在游戏「多人游戏 → 添加服务器」中填入 localhost:端口 加入。请确保已安装对应版本的 Java。'),
  ].filter(Boolean)));
}

function destroy() {
  alive = false;
  if (unsub) { unsub(); unsub = null; }
  clearLogPoll();
  createUI = null;
  if (logModal) { try { logModal.close(); } catch { /* ignore */ } logModal = null; }
  if (createDialog) { try { createDialog.close(); } catch { /* ignore */ } createDialog = null; }
  if (propsModal) { try { propsModal.close(); } catch { /* ignore */ } propsModal = null; }
  logLive = null;
}

export default { render, destroy };
