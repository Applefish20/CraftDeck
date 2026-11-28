/* ================= 实例页（首页） ================= */
import {
  h, frag, toast, toastOk, toastErr, modal, confirmDialog, promptDialog, emptyState, badge,
  fmtDuration, fmtRelative, fmtBytes, loaderLabel, progressBar, sectionTitle, timeGreeting, avatarEl, switchEl,
} from '../ui.js';
import {
  state, api, patchSettings, subscribe, emit, instanceById, isRunning, runningOf, currentInstance, loadState,
} from '../state.js';
import { iconForInstance, coverForInstance, isCutoutIcon } from '../versionicons.js';
import { modDisplayName, zhModName } from '../modnames.mjs';
import { icon } from '../icons.js';

let unsub = null;
let view = null;
let ctxRef = null;
let favoritesOnly = false;
let focusHandler = null;

const LOADERS = [
  { key: 'vanilla', label: '原版 Vanilla', hint: '官方原版，无需加载器' },
  { key: 'fabric', label: 'Fabric', hint: '轻量、更新快，适合大多数模组' },
  { key: 'quilt', label: 'Quilt', hint: 'Fabric 的衍生加载器' },
  { key: 'forge', label: 'Forge', hint: '老牌加载器，整合包生态庞大' },
  { key: 'neoforge', label: 'NeoForge', hint: '1.20.2+ 的现代 Forge 分支' },
];

function heroFor(inst) {
  if (!inst) {
    return h('div', { class: 'hero' }, [
      h('div', { class: 'hero-icon', html: icon('cube', 42) }),
      h('div', { class: 'hero-main' }, [
        h('div', { class: 'hero-title' }, '欢迎使用 CraftDeck'),
        h('div', { class: 'hero-sub' }, '还没有可启动的版本。先去「下载」请一个回来，装完它会自己出现在这里。'),
        h('div', { class: 'hero-meta' }, [badge('下载版本', 'accent'), badge('模组'), badge('整合包'), badge('开服')]),
      ]),
      h('div', { class: 'hero-actions' }, [
        h('button', { class: 'btn btn-primary hero-launch', onclick: () => { location.hash = '#/downloads'; } }, '去下载版本'),
      ]),
    ]);
  }
  const running = runningOf(inst.id);
  const can = !!inst.versionId;
  const acc = state.accounts.find((a) => a.id === inst.accountId) || state.activeAccount;
  const launchBtn = running
    ? h('button', { class: 'btn btn-danger hero-launch', onclick: () => killInstance(inst) }, '■ 停止游戏')
    : h('button', {
      class: 'btn btn-primary hero-launch',
      disabled: !can,
      onclick: () => launchInstance(inst),
      title: can ? '启动游戏' : '请先选择版本',
    }, can ? '▶ 启动游戏' : '未安装版本');
  const heroCover = coverForInstance(inst);
  const heroShade = state.settings.theme === 'light'
    ? 'linear-gradient(100deg, rgba(248,250,255,.9), rgba(248,250,255,.62))'
    : 'linear-gradient(100deg, rgba(7,11,17,.84), rgba(7,11,17,.58))';
  const heroStyle = heroCover
    ? { backgroundImage: `${heroShade}, url("${heroCover}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : {};
  return h('div', { class: 'hero' + (running ? ' launching' : ''), style: heroStyle }, [
    h('div', { class: `hero-icon ${isCutoutIcon(iconForInstance(inst, state.versions.versions || [])) ? 'is-cutout' : ''}`, title: '点击更换图标', style: { padding: 0, overflow: 'hidden', cursor: 'pointer' }, onclick: () => openVisualPicker(inst) },
      h('img', { src: iconForInstance(inst, state.versions.versions || []), alt: '', style: { width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }, onerror: (e) => { e.target.src = '/assets/instance/grass-block.webp'; } })),
    h('div', { class: 'hero-main' }, [
      h('div', { class: 'hero-title' }, [inst.name, running ? badge('运行中', 'ok') : null]),
      h('div', { class: 'hero-meta' }, [
        inst.versionId ? badge(inst.versionId, 'accent') : badge('未安装版本', 'warn'),
        badge(loaderLabel(inst.loader)),
        acc ? badge(acc.username, 'violet') : badge('未选择账户', 'err'),
        inst.memoryMb ? badge(inst.memoryMb + ' MB') : null,
      ]),
      h('div', { class: 'hero-sub' },
        running
          ? `游戏进程运行中（PID ${running.pid}） · 已运行 ${fmtDuration(Date.now() - running.startedAt)}`
          : can
            ? `上次启动：${fmtRelative(inst.lastPlayed)} · 累计 ${fmtDuration(inst.playTimeMs || 0)} · 点击启动开始游戏`
            : '请先为该实例安装游戏版本（版本下载页或编辑实例）'),
    ]),
    h('div', { class: 'hero-actions' }, [
      h('button', { class: 'btn btn-ghost', html: `${icon('logs', 14)}<span>内容</span>`, onclick: () => openContentModal(inst), title: '管理版本、模组、光影与账户' }),
      h('button', { class: 'btn btn-ghost', html: `${icon('settings', 14)}<span>设置</span>`, onclick: () => openEditModal(inst), title: '实例设置' }),
      launchBtn,
    ]),
  ]);
}

function runningDock(inst) {
  const r = inst && runningOf(inst.id);
  if (!r) return null;
  return h('div', { class: 'launch-dock' }, [
    h('div', { class: 'ld-head' }, [
      h('div', { class: 'ld-label' }, [h('span', { class: 'dot on' }), `游戏运行中 · ${inst.name}`]),
      h('div', { class: 'row' }, [
        h('button', { class: 'btn btn-sm', onclick: () => openGameConsole(inst) }, '控制台'),
        h('button', { class: 'btn btn-sm btn-danger', onclick: () => killInstance(inst) }, '结束进程'),
      ]),
    ]),
  ]);
}

function taskDock() {
  const active = [...state.tasks.values()].filter((t) => !t.finished).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!active.length) return null;
  return h('div', { class: 'task-list' }, active.slice(0, 4).map((t) => {
    const pct = Math.round((t.percent ?? (t.total ? (t.done || 0) / t.total : 0)) * 100);
    const speed = t.speedBps ? fmtBytes(t.speedBps) + '/s' : '';
    const eta = t.speedBps && t.totalBytes ? Math.max(0, (t.totalBytes - (t.bytes || 0)) / t.speedBps) : 0;
    return h('div', { class: 'task-item' }, [
      h('div', { class: 'row' }, [
        h('div', { class: 'li-title grow' }, t.label || '处理中…'),
        h('span', { class: 'small muted' }, `${pct}%`),
      ]),
      progressBar(pct / 100),
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
        t.totalBytes ? h('div', { class: 'small muted' }, `${fmtBytes(t.bytes || 0)} / ${fmtBytes(t.totalBytes)}`) : h('span'),
        h('div', { class: 'small muted' }, [speed, eta ? ` · 剩余 ${eta > 60 ? Math.ceil(eta / 60) + ' 分' : Math.ceil(eta) + ' 秒'}` : ''].join('')),
      ]),
    ]);
  }));
}

function statsRow(visibleCount = state.instances.length) {
  const totalPlay = state.stats.playTimeMs || 0;
  const ready = state.instances.filter((i) => !i.installing);
  return h('div', { class: 'stats-row' }, [
    statCard('可启动版本', visibleCount, `${ready.filter((i) => i.versionId).length} 个已安装版本`),
    statCard('累计启动', state.stats.launches || 0, '次游戏启动'),
    statCard('游戏时长', fmtDuration(totalPlay), '所有实例合计'),
    statCard('账户', state.accounts.length, state.activeAccount ? `当前：${state.activeAccount.username}` : '未登录'),
  ]);
}

function statCard(label, value, sub) {
  return h('div', { class: 'stat-card' }, [
    h('div', { class: 's-label' }, label),
    h('div', { class: 's-value' }, String(value)),
    h('div', { class: 's-sub' }, sub),
  ]);
}

async function saveInstanceVisual(inst, patch) {
  await api(`/api/instances/${inst.id}`, { method: 'PATCH', body: patch });
  await refresh();
}

function readImageFile(file, width, height) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片格式不支持'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(width / img.width, height / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function openVisualPicker(inst) {
  const presets = [
    ['/assets/instance/grass-block.webp', '草方块'],
    ['/assets/instance/command.webp', '命令方块'],
    ['/assets/instance/test.webp', '测试方块'],
    ['/assets/instance/barrier.webp', '屏障'],
    ['/assets/instance/cobblestone.webp', '圆石'],
    ['/assets/instance/diamond.webp', '钻石块'],
    ['/assets/instance/emerald.webp', '绿宝石块'],
    ['/assets/instance/redstone.webp', '红石块'],
    ['/assets/instance/redstone-lamp.webp', '红石灯'],
    ['/assets/instance/lodestone.webp', '磁石'],
    ['/assets/instance/jigsaw.webp', '拼图方块'],
    ['/assets/instance/slime.webp', '黏液块'],
    ['/assets/instance/oak-log.webp', '橡木原木'],
    ['/assets/instance/fabric-cut.webp', 'Fabric'],
    ['/assets/instance/forge-cut.webp', 'Forge'],
    ['/assets/instance/neoforge-cut.webp', 'NeoForge'],
  ];
  const current = iconForInstance(inst, state.versions.versions || []);
  const iconPreview = h('img', { class: 'visual-preview-icon', src: current, alt: '' });
  const iconInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } });
  const coverInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } });
  const presetRow = h('div', { class: 'visual-presets' }, presets.map(([src, label]) => h('button', {
    class: `visual-preset ${current === src ? 'active' : ''}`,
    title: label,
    onclick: async () => {
      iconPreview.src = src;
      await saveInstanceVisual(inst, { icon: src });
      toastOk('图标已更新', label);
    },
  }, [h('img', { src, alt: label, class: isCutoutIcon(src) ? 'is-cutout' : '' }), h('span', {}, label)])));
  const customIconBtn = h('button', { class: 'btn btn-sm', onclick: () => iconInput.click() }, '上传自定义图标');
  const customCoverBtn = h('button', { class: 'btn btn-sm', onclick: () => coverInput.click() }, '上传自定义封面');
  const coverUrlBtn = h('button', { class: 'btn btn-sm', onclick: async () => {
    const url = await promptDialog({ title: '网络封面', label: '图片 URL（http/https）', placeholder: 'https://example.com/cover.jpg' });
    if (url) { await saveInstanceVisual(inst, { cover: url }); toastOk('封面已更新'); }
  } }, '封面链接');
  const coverSources = [
    ...Array.from({ length: 6 }, (_, i) => ({ src: `/assets/instance/covers/cover-${i + 1}.webp`, label: `封面 ${i + 1}` })),
    ...['autumn', 'coral', 'village', 'end', 'stronghold', 'night', 'plains', 'monument', 'mottled', 'end-outer', 'desert', 'cherry']
      .map((key, i) => ({ src: `/assets/backgrounds/${key}.webp`, label: `背景 ${i + 1}` })),
  ];
  const coverPresets = h('div', { class: 'cover-presets' }, coverSources.map(({ src, label }, i) => h('button', {
    class: `cover-preset ${inst.cover === src ? 'active' : ''}`,
    style: { backgroundImage: `url("${src}")` },
    title: label,
    onclick: async () => {
      await saveInstanceVisual(inst, { cover: src });
      for (const b of coverPresets.children) b.classList.toggle('active', b === coverPresets.children[i]);
      toastOk('封面已更新', label);
    },
  }, h('span', {}, String(i + 1)))));
  const resetBtn = h('button', {
    class: 'btn btn-sm btn-ghost', onclick: async () => {
      await saveInstanceVisual(inst, { cover: null });
      toastOk('已恢复默认背景');
    },
  }, '恢复默认背景');
  if (inst.modpackIcon) {
    presetRow.append(h('button', {
      class: 'visual-preset', title: '整合包图标',
      onclick: async () => { await saveInstanceVisual(inst, { icon: inst.modpackIcon, cover: inst.modpackIcon }); toastOk('已使用整合包图片'); },
    }, [h('img', { src: inst.modpackIcon, alt: '整合包' }), h('span', {}, '整合包')]));
  }
  iconInput.addEventListener('change', async () => {
    const f = iconInput.files?.[0];
    if (!f) return;
    try {
      const data = await readImageFile(f, 128, 128);
      iconPreview.src = data;
      await saveInstanceVisual(inst, { icon: data });
      toastOk('图标已更新');
    } catch (e) { toastErr('更换图标失败', e.message); }
  });
  coverInput.addEventListener('change', async () => {
    const f = coverInput.files?.[0];
    if (!f) return;
    try {
      const data = await readImageFile(f, 960, 300);
      await saveInstanceVisual(inst, { cover: data });
      toastOk('封面已更新');
    } catch (e) { toastErr('更换封面失败', e.message); }
  });
  modal({
    title: '更换版本图标 / 封面',
    wide: true,
    body: [
      h('div', { class: 'row', style: { gap: '14px', alignItems: 'center' } }, [
        h('div', { class: 'visual-preview-box' }, iconPreview),
        h('div', { class: 'grow' }, [
          h('div', { class: 'panel-title' }, inst.name),
          h('div', { class: 'hint', style: { marginTop: '4px' } }, '图标会显示在启动页卡片左侧；封面会显示在卡片顶部。'),
          h('div', { class: 'row', style: { marginTop: '10px', gap: '6px', flexWrap: 'wrap' } }, [customIconBtn, customCoverBtn, coverUrlBtn, resetBtn]),
        ]),
      ]),
      h('div', { class: 'divider' }),
      h('div', { class: 'field' }, [h('label', {}, '预设图标'), presetRow]),
      h('div', { class: 'field', style: { marginTop: '4px' } }, [h('label', {}, '预设封面'), coverPresets]),
      iconInput, coverInput,
      inst.cover ? h('div', { class: 'hint', style: { marginTop: '10px' } }, '当前已有自定义封面，可上传新图或恢复默认。') : null,
    ],
    actions: [{ label: '关闭', kind: 'primary' }],
  });
}

function instanceCard(inst) {
  const running = runningOf(inst.id);
  const active = state.settings.lastInstanceId === inst.id;
  const iconSrc = iconForInstance(inst, state.versions.versions || []);
  const cardCover = coverForInstance(inst);
  return h('div', {
    class: `inst-card ${active ? 'active' : ''}`,
    onclick: async (e) => {
      if (e.target.closest('button') || e.target.closest('.inst-icon')) return;
      await patchSettings({ lastInstanceId: inst.id });
      await refresh();
    },
  }, [
    h('div', {
      class: `inst-banner ${cardCover ? 'has-cover' : ''}`,
      style: cardCover ? { backgroundImage: `url("${cardCover}")` } : {},
    }, [
      running ? h('div', { class: 'inst-running' }, badge('运行中', 'ok')) : null,
      h('div', { class: 'inst-more' }, [
        h('button', {
          class: `icon-btn inst-fav ${inst.favorite ? 'on' : ''}`, title: inst.favorite ? '取消收藏' : '收藏',
          html: icon('star', 15),
          onclick: async (e) => { e.stopPropagation(); await api(`/api/instances/${inst.id}`, { method: 'PATCH', body: { favorite: !inst.favorite } }); await refresh(); },
        }),
        h('button', {
          class: 'icon-btn', title: '更多', html: icon('more', 16),
          onclick: (e) => { e.stopPropagation(); openCardMenu(inst, e.currentTarget); },
        }),
      ]),
    ]),
    h('div', { class: 'inst-body' }, [
      h('div', { class: `inst-icon ${isCutoutIcon(iconSrc) ? 'is-cutout' : ''}`, title: '点击更换图标', onclick: (e) => { e.stopPropagation(); openVisualPicker(inst); } },
        h('img', { src: iconSrc, alt: '', onerror: (e) => { e.target.src = '/assets/instance/grass-block.webp'; } })),
      h('div', { class: 'inst-info' }, [
        h('div', { class: 'inst-name' }, inst.name),
        h('div', { class: 'inst-ver' }, [
          badge(inst.versionId || '未选择版本', inst.versionId ? 'accent' : 'warn'),
          badge(loaderLabel(inst.loader)),
          inst.playTimeMs ? h('span', { class: 'small muted' }, fmtDuration(inst.playTimeMs)) : null,
        ]),
      ]),
    ]),
    h('div', { class: 'inst-actions', style: { padding: '0 14px 14px' } }, [
      h('button', {
        class: `btn btn-sm ${running ? 'btn-danger' : 'btn-primary'}`,
        onclick: () => (running ? killInstance(inst) : launchInstance(inst)),
        disabled: !inst.versionId && !running,
      }, running ? '停止' : '启动'),
      h('button', { class: 'btn btn-sm', onclick: () => openContentModal(inst) }, '内容'),
      h('button', { class: 'btn btn-sm', onclick: () => openEditModal(inst) }, '设置'),
      h('button', { class: 'btn btn-sm', style: { flex: '0 0 auto' }, title: '打开目录', html: icon('folder', 15), onclick: () => openFolder(inst) }),
    ]),
  ]);
}

async function refresh() {
  if (!ctxRef) return;
  await loadState();
  ctxRef.refresh();
}

function openSavesModal(inst) {
  let current = [];
  const list = h('div', { class: 'save-list' }, h('div', { class: 'hint' }, '正在读取存档…'));
  const body = h('div', { class: 'col', style: { gap: '10px' } }, [
    h('div', { class: 'hint' }, '修改的是存档的 level.dat。建议先关闭游戏再改，避免被游戏覆盖。'),
    list,
  ]);
  const dlg = modal({ title: `世界存档 · ${inst.name}`, wide: true, body, actions: [{ label: '关闭', kind: 'primary' }] });
  const load = async () => {
    try {
      const r = await api(`/api/instances/${encodeURIComponent(inst.id)}/saves`);
      current = r.items || [];
      if (!current.length) {
        list.replaceChildren(emptyState({ icon: '▦', title: '还没有个人存档', sub: '进入游戏创建一个世界，保存后会出现在这里。' }));
        return;
      }
      list.replaceChildren(...current.map((w) => h('div', { class: 'save-row' }, [
        h('div', { class: 'save-main' }, [
          h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [
            h('strong', { class: 'save-name' }, w.name),
            badge(w.gameTypeLabel, w.gameType === 1 ? 'ok' : 'accent'),
            badge(w.difficultyLabel, w.difficulty === 3 ? 'err' : 'violet'),
            w.hardcore ? badge('硬核', 'err') : null,
            w.allowCommands ? badge('作弊', 'warn') : null,
          ]),
          h('div', { class: 'hint' }, `${w.world}${w.lastPlayed ? ' · ' + fmtRelative(w.lastPlayed) : ''}`),
        ]),
        h('button', {
          class: 'icon-btn', title: '编辑世界设置', html: icon('more', 16),
          onclick: async () => {
            const gameType = h('select', { class: 'select' }, [['0', '生存'], ['1', '创造'], ['2', '冒险'], ['3', '旁观']]
              .map(([v, l]) => h('option', { value: v, selected: String(w.gameType) === v }, l)));
            const difficulty = h('select', { class: 'select' }, [['0', '和平'], ['1', '简单'], ['2', '普通'], ['3', '困难']]
              .map(([v, l]) => h('option', { value: v, selected: String(w.difficulty) === v }, l)));
            const hardcore = switchEl(w.hardcore, () => {});
            const cheats = switchEl(w.allowCommands, () => {});
            const hardcoreInput = hardcore.querySelector('input');
            const cheatsInput = cheats.querySelector('input');
            const nameInput = h('input', { class: 'input', value: w.name });
            const seedInput = h('input', { class: 'input mono', value: w.seed || '0' });
            const spawnInput = h('input', { class: 'input', type: 'number', min: 0, max: 128, value: w.spawnRadius ?? 10 });
            const tickInput = h('input', { class: 'input', type: 'number', min: 0, max: 4096, value: w.gameRules?.randomTickSpeed ?? 3 });
            const toggle = (title, hint, checked) => {
              const el = switchEl(checked, () => {});
              return { row: h('label', { class: 'row', style: { justifyContent: 'space-between', gap: '12px' } }, [h('div', {}, [h('div', { style: { fontWeight: '600' } }, title), h('div', { class: 'hint' }, hint)]), el]), input: el.querySelector('input') };
            };
            const structures = toggle('生成建筑结构', '村庄、要塞、遗迹等', w.generateFeatures !== false);
            const bonus = toggle('奖励箱', '新世界出生点附近生成奖励箱', !!w.bonusChest);
            const rules = {
              keepInventory: toggle('保留物品栏', '死亡后不掉落物品', !!w.gameRules?.keepInventory),
              doMobSpawning: toggle('生成生物', '允许自然生成怪物和动物', w.gameRules?.doMobSpawning !== false),
              doDaylightCycle: toggle('昼夜循环', '时间会正常流逝', w.gameRules?.doDaylightCycle !== false),
              doWeatherCycle: toggle('天气变化', '会下雨/下雪', w.gameRules?.doWeatherCycle !== false),
              mobGriefing: toggle('生物破坏方块', '苦力怕、末影人等可破坏', w.gameRules?.mobGriefing !== false),
              naturalRegeneration: toggle('自然回血', '饥饿值足够时自动恢复', w.gameRules?.naturalRegeneration !== false),
              doImmediateRespawn: toggle('立即重生', '死亡后跳过重生按钮', !!w.gameRules?.doImmediateRespawn),
              doFireTick: toggle('火焰蔓延', '火会烧毁方块', w.gameRules?.doFireTick !== false),
            };
            const save = h('button', { class: 'btn btn-primary' }, '保存世界设置');
            const edit = modal({
              title: `编辑 · ${w.name}`,
              wide: true,
              body: h('div', { class: 'col', style: { gap: '12px' } }, [
                h('div', { class: 'field' }, [h('label', {}, '存档名称'), nameInput]),
                h('div', { class: 'field' }, [h('label', {}, '种子（只影响新生成区块，不会重新生成已有地形）'), seedInput]),
                h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' } }, [
                  h('div', { class: 'field', style: { flex: '1 1 160px' } }, [h('label', {}, '出生点范围'), spawnInput]),
                  h('div', { class: 'field', style: { flex: '1 1 160px' } }, [h('label', {}, '随机刻速度'), tickInput]),
                ]),
                h('div', { class: 'field' }, [h('label', {}, '游戏模式'), gameType]),
                h('div', { class: 'field' }, [h('label', {}, '难度'), difficulty]),
                h('label', { class: 'row', style: { justifyContent: 'space-between', gap: '12px' } }, [
                  h('div', {}, [h('div', { style: { fontWeight: '600' } }, '硬核模式'), h('div', { class: 'hint' }, '死亡后无法复活，难度会被锁定')]),
                  hardcore,
                ]),
                h('label', { class: 'row', style: { justifyContent: 'space-between', gap: '12px' } }, [
                  h('div', {}, [h('div', { style: { fontWeight: '600' } }, '允许作弊'), h('div', { class: 'hint' }, '允许使用命令和开启局域网作弊')]),
                  cheats,
                ]),
                h('div', { class: 'label', style: { marginTop: '4px' } }, '世界生成'),
                structures.row, bonus.row,
                h('div', { class: 'label', style: { marginTop: '4px' } }, '游戏规则'),
                ...Object.values(rules).map((r) => r.row),
                h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px', marginTop: '4px' } }, [save]),
              ]),
            });
            save.addEventListener('click', async () => {
              save.disabled = true; save.textContent = '保存中…';
              try {
                await api(`/api/instances/${encodeURIComponent(inst.id)}/saves/${encodeURIComponent(w.world)}`, {
                  method: 'PATCH', body: {
                    name: nameInput.value.trim(), seed: seedInput.value.trim(),
                    gameType: Number(gameType.value), difficulty: Number(difficulty.value),
                    hardcore: hardcoreInput.checked, allowCommands: cheatsInput.checked,
                    generateFeatures: structures.input.checked, bonusChest: bonus.input.checked,
                    spawnRadius: Number(spawnInput.value) || 0,
                    gameRules: {
                      ...Object.fromEntries(Object.entries(rules).map(([k, r]) => [k, r.input.checked])),
                      randomTickSpeed: Number(tickInput.value) || 3,
                    },
                  },
                });
                toastOk('世界设置已保存', nameInput.value.trim() || w.name);
                edit.close?.(); await load();
              } catch (e) { toastErr('保存失败', e.message); }
              finally { save.disabled = false; save.textContent = '保存世界设置'; }
            });
          },
        }),
      ])));
    } catch (e) {
      list.replaceChildren(h('div', { class: 'callout err' }, e.message));
    }
  };
  load();
  return dlg;
}

function openCardMenu(inst, anchor) {
  document.querySelectorAll('.popover.card-menu').forEach((el) => el.remove());
  const rect = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'popover card-menu', style: { top: rect.bottom + 6 + 'px', left: Math.max(12, rect.right - 200) + 'px' } });
  const item = (label, fn, danger = false) => h('button', { class: 'pop-item', style: danger ? { color: 'var(--err)' } : {}, onclick: () => { menu.remove(); fn(); } }, label);
  menu.append(
    item('设为当前实例', async () => { await patchSettings({ lastInstanceId: inst.id }); refresh(); }),
    item('管理内容（版本 / 模组 / 光影 / 账户）', () => openContentModal(inst)),
    item('编辑实例', () => openEditModal(inst)),
    item('更换图标 / 封面', () => openVisualPicker(inst)),
    item('世界存档', () => openSavesModal(inst)),
    item('打开游戏目录', () => openFolder(inst)),
    item('查看启动命令', () => showDryRun(inst)),
    item('复制实例', () => duplicateInstance(inst)),
    item('导出整合包（MultiMC）', async () => {
      try {
        toast({ kind: 'info', title: '正在导出整合包', message: '正在打包 mods、config、存档与光影…', timeout: 4000 });
        const r = await api(`/api/instances/${inst.id}/export-modpack`, { method: 'POST', body: {} });
        toastOk('整合包已导出', r.path || '已保存到 downloads/exports');
      } catch (e) { toastErr('导出失败', e.message); }
    }),
    h('div', { class: 'pop-sep' }),
    item('删除实例', () => removeInstance(inst), true),
  );
  document.body.append(menu);
  const mh = menu.getBoundingClientRect().height;
  if (rect.bottom + 6 + mh > window.innerHeight - 8) {
    menu.style.top = `${Math.max(8, rect.top - mh - 6)}px`;
  }
  setTimeout(() => {
    const close = (e) => {
      if (e?.target && menu.contains(e.target)) return;
      cleanup();
    };
    const cleanup = () => {
      menu.remove();
      document.removeEventListener('click', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
    const onScroll = (e) => { if (e?.target && menu.contains(e.target)) return; cleanup(); };
    document.addEventListener('click', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  }, 0);
}

async function removeInstance(inst) {
  const ok = await confirmDialog({
    title: '删除实例',
    message: `确定要删除「${inst.name}」吗？\n\n实例目录（含存档与模组）会被永久删除，此操作不可恢复。`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/instances/${inst.id}`, { method: 'DELETE' });
    toastOk('已删除实例', inst.name);
    refresh();
  } catch (e) { toastErr('删除失败', e.message); }
}

async function duplicateInstance(inst) {
  const name = await promptDialog({ title: '复制实例', label: '新实例名称', value: inst.name + ' - 副本' });
  if (!name) return;
  try {
    const r = await api('/api/instances', {
      method: 'POST',
      body: { name, versionId: inst.versionId, loader: inst.loader, accountId: inst.accountId },
    });
    toastOk('已创建实例', r.instance.name);
    refresh();
  } catch (e) { toastErr('创建失败', e.message); }
}

async function openFolder(inst) {
  try {
    const r = await api(`/api/instances/${inst.id}/open`, { method: 'POST', body: {} });
    toast({ kind: 'info', title: '已打开实例目录', message: r.dir, timeout: 5000 });
  } catch (e) {
    toastErr('无法打开目录', e.message + '\n可在资源管理器中手动打开启动器数据目录');
  }
}

async function showDryRun(inst) {
  try {
    const r = await api(`/api/instances/${inst.id}/dryrun`);
    modal({
      title: '启动命令预览',
      wide: true,
      body: [
        h('div', { class: 'callout info' }, h('div', {}, '以下为实际启动时执行的 Java 命令（已替换账户占位符，仅展示用）。')),
        h('pre', { class: 'console-body', style: { maxHeight: '320px', background: '#05080c', borderRadius: '10px', border: '1px solid var(--line)' } }, r.command),
        h('div', { class: 'detail-list' }, [
          detailItem('Java', r.javaPath), detailItem('主类', r.mainClass), detailItem('版本', r.versionId),
          detailItem('内存', r.memory + ' MB'), detailItem('类路径条目', r.classpathCount + ' 个'),
        ]),
      ],
      actions: [{ label: '复制', onClick: () => { navigator.clipboard?.writeText(r.command); } }, { label: '关闭', kind: 'primary' }],
    });
  } catch (e) {
    modal({
      title: '无法生成启动命令',
      body: h('div', { class: 'col', style: { gap: '10px' } }, [
        h('div', { class: 'callout warn' }, '启动命令预览需要已安装版本、可用 Java 和账户。'),
        h('div', { class: 'hint' }, e.message || '生成失败'),
        h('div', { class: 'hint' }, '「查看启动命令」用于排查启动问题：可以复制实际 Java 命令、检查内存、主类和类路径。'),
      ]),
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  }
}

const detailItem = (k, v) => h('div', { class: 'detail-item' }, [h('span', { class: 'dk' }, k), h('span', { class: 'dv' }, v ?? '—')]);

async function showEarlyExit(inst, evt) {
  const secs = Math.max(1, Math.round((Number(evt.durationMs) || 0) / 1000));
  let tail = '';
  try {
    const r = await api(`/api/instances/${encodeURIComponent(inst.id)}/log?tail=80`);
    tail = (r.lines || []).slice(-30).join('\n');
  } catch { /* ignore */ }
  const missing = /NoSuchFileException|FileNotFoundException|找不到|missing/i.test(tail);
  const reason = missing ? '游戏资源文件缺失' : '游戏启动后很快退出';
  const fix = missing
    ? '启动器会自动补下载缺失资源，但这次没有补全。点「检查文件」重新校验版本，或重新启动一次让资源修复跑完。'
    : '查看下方日志最后几行，通常是 Java、模组/加载器不兼容、内存或显卡驱动问题。';
  modal({
    title: '游戏启动失败',
    wide: true,
    body: [
      h('div', { class: 'callout err' }, [
        h('strong', {}, `${reason}（运行 ${secs} 秒后退出，代码 ${evt.code}）`),
        h('div', { style: { marginTop: '6px' } }, '游戏进程已经退出，所以启动器没有继续停留在运行状态。'),
      ]),
      h('div', { class: 'callout info', style: { marginTop: '10px' } }, fix),
      tail ? h('pre', { class: 'console-body', style: { maxHeight: '240px', marginTop: '10px', background: '#05080c', borderRadius: '9px', padding: '10px', overflow: 'auto', fontSize: '11px' } }, tail) : null,
    ],
    actions: [
      { label: '打开日志', onClick: () => { location.hash = '#/logs'; } },
      { label: '检查文件', onClick: () => { openContentModal(inst); } },
      { label: '关闭', kind: 'primary' },
    ],
  });
}

function launchReason(message) {
  const m = String(message || '');
  if (/java|jvm|runtime/i.test(m)) return ['没有找到可用的 Java', '安装 Java 21，或在「设置 → Java 与内存」手动指定 java.exe。完整版启动器已内置 Java 8 / 21。'];
  if (/内存|memory|heap|OutOfMemory/i.test(m)) return ['内存不足或分配过大', '在「内容 → 设置」降低内存，或关闭其他占用内存的程序。'];
  if (/auth|login|token|401|403|账户/i.test(m)) return ['账户登录失效', '到「账户」页刷新令牌或重新登录；离线账户请确认用户名。'];
  if (/mod|fabric|forge|neoforge|quilt|loader|crash/i.test(m)) return ['模组或加载器导致启动失败', '在「内容 → Mod 管理」先全部禁用 Mod 再启动，逐步排查；或重新安装对应加载器。'];
  if (/version|版本|client\.jar|json|sha1|文件缺失|ENOENT|找不到/i.test(m)) return ['游戏版本文件不完整', '到「内容 → 概览」重新安装该版本，或到「百宝箱 → 游戏文件校验」修复。'];
  return ['未知启动错误', '先查看「日志」页的最后几行；常见原因是 Java、内存、模组冲突或版本文件损坏。'];
}

function showLaunchFailure(inst, err) {
  const [reason, fix] = launchReason(err.message);
  modal({
    title: '启动失败',
    wide: true,
    body: [
      h('div', { class: 'callout err' }, [h('strong', {}, reason), h('div', { style: { marginTop: '6px' } }, err.message || '未知错误')]),
      h('div', { class: 'detail-list', style: { marginTop: '12px' } }, [
        h('div', { class: 'detail-item' }, [h('span', {}, '实例'), h('strong', {}, inst.name)]),
        h('div', { class: 'detail-item' }, [h('span', {}, '版本'), h('strong', {}, inst.versionId || '未安装')]),
        h('div', { class: 'detail-item' }, [h('span', {}, 'Java'), h('strong', {}, inst.javaPath || '自动')]),
      ]),
      h('div', { class: 'callout info', style: { marginTop: '12px' } }, fix),
    ],
    actions: [
      { label: '打开日志', onClick: () => { location.hash = '#/logs'; } },
      { label: '检查文件', onClick: () => { openContentModal(inst).then?.(); } },
      { label: '关闭', kind: 'primary' },
    ],
  });
}

async function launchInstance(inst) {
  if (!inst.versionId) { toastErr('没有游戏版本', '请先编辑实例并选择版本'); return; }
  try {
    toast({ kind: 'info', title: '正在启动', message: `${inst.name} · 首次启动需要下载游戏文件，请耐心等待` , timeout: 3000 });
    const r = await api(`/api/instances/${inst.id}/launch`, { method: 'POST', body: {} });
    toastOk('游戏已启动', `PID ${r.pid} · 内存 ${r.memory} MB`);
    refresh();
  } catch (e) {
    showLaunchFailure(inst, e);
  }
}

async function killInstance(inst) {
  const ok = await confirmDialog({ title: '结束游戏', message: '强制结束游戏进程可能导致存档未保存，确定继续？', okText: '结束进程', danger: true });
  if (!ok) return;
  try {
    await api(`/api/instances/${inst.id}/kill`, { method: 'POST', body: {} });
    toastOk('已发送结束指令', inst.name);
    setTimeout(refresh, 800);
  } catch (e) { toastErr('操作失败', e.message); }
}

function openGameConsole(inst) {
  const panel = document.getElementById('console-panel');
  if (panel.hidden) document.getElementById('btn-console').click();
}

/* ---------------- 新建 / 编辑弹窗 ---------------- */
async function openCreateModal() {
  const versionsResp = await api('/api/versions').catch(() => ({ versions: [], latest: {} }));
  const versions = versionsResp.versions || [];
  if (!versions.length) { toastErr('版本列表为空', '请检查网络后重试'); return; }
  const latest = versionsResp.latest || {};

  const nameInput = h('input', { class: 'input', value: '新实例', placeholder: '实例名称' });
  const verSelect = h('select', { class: 'select' }, versions.filter((v) => v.type === 'release').slice(0, 80).map((v) =>
    h('option', { value: v.id, selected: v.id === (latest.release || versions[0].id) }, `${v.id}${v.id === latest.release ? '（最新正式版）' : ''}`)));
  const loaderRow = h('div', { class: 'chip-row' });
  let loaderType = 'vanilla';
  const loaderSelect = h('select', { class: 'select', style: { display: 'none' } });
  const loaderHint = h('div', { class: 'hint' }, '原版不需要加载器');
  const loaderStatus = h('div', { class: 'hint' });
  const showSnapshots = h('input', { type: 'checkbox' });

  const rebuildLoaderChips = () => {
    loaderRow.innerHTML = '';
    for (const l of LOADERS) {
      loaderRow.append(h('button', {
        class: `chip ${l.key === loaderType ? 'active' : ''}`,
        style: l.key === loaderType ? { background: 'color-mix(in srgb, var(--accent) 22%, transparent)', borderColor: 'var(--accent)', color: '#fff' } : {},
        onclick: () => { loaderType = l.key; rebuildLoaderChips(); loadLoaderVersions(); },
      }, l.label));
    }
    loaderHint.textContent = (LOADERS.find((l) => l.key === loaderType) || {}).hint || '';
  };

  const loadLoaderVersions = async () => {
    loaderSelect.innerHTML = '';
    loaderSelect.style.display = 'none';
    if (loaderType === 'vanilla') { loaderStatus.textContent = ''; return; }
    loaderStatus.textContent = '正在获取加载器版本…';
    try {
      const r = await api(`/api/versions/loaders?type=${loaderType}&gameVersion=${encodeURIComponent(verSelect.value)}`);
      const list = r.versions || [];
      if (!list.length) { loaderStatus.textContent = `该版本没有可用的 ${loaderType} 加载器`; return; }
      loaderSelect.style.display = '';
      for (const v of list.slice(0, 80)) loaderSelect.append(h('option', { value: v.version }, `${v.version}${v.stable ? '' : ' (测试版)'}`));
      loaderStatus.textContent = `找到 ${list.length} 个加载器版本`;
    } catch (e) {
      loaderStatus.textContent = '获取加载器版本失败：' + e.message;
    }
  };

  const rebuildVersionList = () => {
    const show = showSnapshots.checked;
    verSelect.innerHTML = '';
    const list = versions.filter((v) => (show ? v.type !== 'old_alpha' && v.type !== 'old_beta' : v.type === 'release')).slice(0, 120);
    for (const v of list) verSelect.append(h('option', { value: v.id, selected: v.id === (latest.release || '') }, `${v.id} · ${v.type}`));
  };

  rebuildVersionList();
  verSelect.addEventListener('change', loadLoaderVersions);
  showSnapshots.addEventListener('change', rebuildVersionList);
  rebuildLoaderChips();

  const accountSelect = h('select', { class: 'select' }, state.accounts.length
    ? state.accounts.map((a) => h('option', { value: a.id, selected: a.id === state.settings.lastAccountId }, `${a.username}（${a.type === 'microsoft' ? '正版' : a.type === 'thirdparty' ? '第三方' : '离线'}）`))
    : [h('option', { value: '' }, '（暂无账户，可在账户页添加）')]);

  const body = [
    h('div', { class: 'field' }, [h('label', {}, '实例名称'), nameInput]),
    h('div', { class: 'field' }, [h('label', {}, '游戏版本'), verSelect,
      h('div', { class: 'row', style: { marginTop: '4px' } }, [h('label', { class: 'check' }, [showSnapshots, '显示快照版本'])]),
    ]),
    h('div', { class: 'field' }, [h('label', {}, '模组加载器'), loaderRow, loaderHint,
      loaderSelect, loaderStatus]),
    h('div', { class: 'field' }, [h('label', {}, '使用账户'), accountSelect]),
    h('div', { class: 'callout info' }, '创建后会自动下载游戏与加载器文件，完成后即可启动。'),
  ];

  let created = null;
  modal({
    title: '新建实例',
    wide: true,
    body,
    actions: [
      { label: '取消' },
      {
        label: '创建并安装', kind: 'primary', keepOpen: true,
        onClick: async (ev, close) => {
          const name = nameInput.value.trim() || '新实例';
          try {
            ev.target.disabled = true;
            ev.target.textContent = '正在创建…';
            const inst = await api('/api/instances', {
              method: 'POST',
              body: { name, versionId: verSelect.value, loader: { type: loaderType, version: loaderType === 'vanilla' ? null : loaderSelect.value || null }, accountId: accountSelect.value || null },
            });
            created = inst.instance;
            ev.target.textContent = '正在下载游戏文件…';
            const loaderVersion = loaderType === 'vanilla' ? null : loaderSelect.value || null;
            await api(`/api/instances/${created.id}/setup`, {
              method: 'POST',
              body: { versionId: verSelect.value, loader: loaderType, loaderVersion },
            });
            toast({ kind: 'info', title: '开始安装', message: '下载已在后台进行，进度显示在左侧任务栏', timeout: 3500 });
            close();
            ctxRef.refresh();
          } catch (e) {
            ev.target.disabled = false;
            ev.target.textContent = '创建并安装';
            toastErr('创建失败', e.message);
          }
        },
      },
    ],
  });
}

async function openEditModal(inst) {
  const versionsResp = await api('/api/versions').catch(() => ({ versions: [] }));
  const versions = versionsResp.versions || [];
  const nameInput = h('input', { class: 'input', value: inst.name });
  const versionSelect = h('select', { class: 'select' }, [
    h('option', { value: '' }, '（未选择）'),
    ...versions.filter((v) => v.type === 'release').slice(0, 80).map((v) => h('option', { value: v.id, selected: v.id === inst.versionId }, v.id)),
  ]);
  const loaderSelect = h('select', { class: 'select' }, LOADERS.map((l) => h('option', { value: l.key, selected: l.key === (inst.loader?.type || 'vanilla') }, l.label)));
  const accSelect = h('select', { class: 'select' }, [
    h('option', { value: '' }, '使用默认账户'),
    ...state.accounts.map((a) => h('option', { value: a.id, selected: a.id === inst.accountId }, a.username)),
  ]);
  const memInput = h('input', { class: 'input', type: 'number', min: 512, max: 32768, step: 256, value: inst.memoryMb || '' , placeholder: '默认（由全局设置决定）' });
  const javaInput = h('input', { class: 'input', value: inst.javaPath || '', placeholder: 'auto（自动选择）' });
  const jvmInput = h('textarea', { class: 'textarea', rows: 3 }, inst.jvmArgs || '');
  const notesInput = h('textarea', { class: 'textarea', rows: 2 }, inst.notes || '');

  modal({
    title: '实例设置 · ' + inst.name,
    wide: true,
    body: [
      h('div', { class: 'field' }, [h('label', {}, '实例名称'), nameInput]),
      h('div', { class: 'row', style: { alignItems: 'flex-end' } }, [
        h('div', { class: 'field grow' }, [h('label', {}, '游戏版本（改版本需要重新安装文件）'), versionSelect]),
        h('div', { class: 'field', style: { width: '190px' } }, [h('label', {}, '加载器'), loaderSelect]),
      ]),
      h('div', { class: 'field' }, [h('label', {}, '账户'), accSelect]),
      h('div', { class: 'row' }, [
        h('div', { class: 'field grow' }, [h('label', {}, '最大内存 (MB)'), memInput]),
        h('div', { class: 'field grow' }, [h('label', {}, 'Java 路径'), javaInput]),
      ]),
      h('div', { class: 'field' }, [h('label', {}, '额外 JVM 参数'), jvmInput]),
      h('div', { class: 'field' }, [h('label', {}, '备注'), notesInput]),
    ],
    actions: [
      { label: '取消' },
      {
        label: '保存', kind: 'primary',
        onClick: async () => {
          const patch = {
            name: nameInput.value.trim() || inst.name,
            versionId: versionSelect.value || null,
            accountId: accSelect.value || null,
            memoryMb: memInput.value ? Number(memInput.value) : null,
            javaPath: javaInput.value.trim() || null,
            jvmArgs: jvmInput.value,
            notes: notesInput.value,
            loader: { ...(inst.loader || { type: 'vanilla' }), type: loaderSelect.value },
          };
          if (patch.versionId !== inst.versionId || patch.loader.type !== (inst.loader?.type || 'vanilla')) {
            patch.loader = { type: loaderSelect.value, version: null, versionId: null };
          }
          try {
            await api(`/api/instances/${inst.id}`, { method: 'PATCH', body: patch });
            toastOk('已保存', patch.name);
            await refresh();
            if (patch.versionId && (patch.versionId !== inst.versionId || patch.loader.type !== (inst.loader?.type || 'vanilla'))) {
              const need = await confirmDialog({ title: '安装游戏文件', message: '版本或加载器已变更，是否现在下载所需文件？', okText: '开始下载' });
              if (need) {
                await api(`/api/instances/${inst.id}/setup`, { method: 'POST', body: { versionId: patch.versionId, loader: patch.loader.type, loaderVersion: null } });
                toast({ kind: 'info', title: '开始安装', message: '进度显示在左下角', timeout: 3000 });
              }
            }
          } catch (e) { toastErr('保存失败', e.message); return false; }
        },
      },
    ],
  });
}

/* ---------------- 实例内容管理 ---------------- */
async function openContentModal(inst) {
  let tab = 'overview';
  let close = null;
  const tabs = [
    { key: 'overview', label: '概览' },
    { key: 'settings', label: '设置' },
    { key: 'mods', label: 'Mod 管理' },
    { key: 'shaders', label: '光影与材质' },
    { key: 'account', label: '账户' },
    { key: 'advanced', label: '高级' },
  ];
  const resetScroll = () => {
    const body = m.el.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  };
  const tabsEl = h('div', { class: 'tabs' }, tabs.map((t) => h('button', {
    class: `tab ${t.key === tab ? 'active' : ''}`, dataset: { key: t.key },
    onclick: () => { tab = t.key; for (const b of tabsEl.children) b.classList.toggle('active', b.dataset.key === tab); render(); setTimeout(resetScroll, 0); },
  }, t.label)));
  const content = h('div', { class: 'col', style: { gap: '12px' } });
  const m = modal({
    title: '实例内容 · ' + inst.name,
    wide: true,
    body: [tabsEl, content],
    actions: [{ label: '关闭', kind: 'primary' }],
  });
  close = m.close;

  const loadFileList = async (type) => {
    const r = await api(`/api/instances/${inst.id}/files?type=${type}`);
    return r.files || [];
  };

  const fileDetail = (f, type) => {
    const typeName = type === 'shaderpacks' ? '光影包' : '材质包';
    modal({
      title: f.name,
      body: [
        h('div', { class: 'detail-list' }, [
          h('div', { class: 'detail-item' }, [h('span', {}, '类型'), h('strong', {}, typeName)]),
          h('div', { class: 'detail-item' }, [h('span', {}, '大小'), h('strong', {}, fmtBytes(f.size))]),
          h('div', { class: 'detail-item' }, [h('span', {}, '状态'), h('strong', {}, f.disabled ? '已禁用' : '已启用')]),
          h('div', { class: 'detail-item' }, [h('span', {}, '位置'), h('strong', { class: 'mono' }, `${type}/${f.name}`)]),
        ]),
        h('div', { class: 'hint' }, '可以在版本内容中启用、禁用或删除；需要下载新版时点「去下载页」。'),
      ],
      actions: [
        { label: '打开文件夹', onClick: () => api(`/api/instances/${inst.id}/open`, { method: 'POST', body: { type } }).catch(() => {}) },
        { label: '去下载页', onClick: () => {
          close?.();
          sessionStorage.setItem('craftdeck.downloadTab', 'resources');
          sessionStorage.setItem('craftdeck.resourceQuery', f.name.replace(/\.[^.]+$/i, ''));
          location.hash = '#/downloads';
        } },
        { label: f.disabled ? '启用' : '禁用', onClick: async () => { try { await api(`/api/instances/${inst.id}/files/toggle`, { method: 'POST', body: { type, name: f.name } }); render(); } catch (e) { toastErr('操作失败', e.message); } } },
        { label: '删除', kind: 'danger', onClick: async () => { if (!(await confirmDialog({ title: '删除文件', message: `确定删除 ${f.name} 吗？`, okText: '删除', danger: true }))) return; try { await api(`/api/instances/${inst.id}/files`, { method: 'DELETE', body: { type, name: f.name } }); render(); } catch (e) { toastErr('删除失败', e.message); } } },
        { label: '关闭', kind: 'primary' },
      ],
    });
  };
  const fileRow = (f, type) => h('div', { class: 'list-item' }, [
    h('div', { class: 'li-main' }, [
      h('div', { class: 'li-title ellipsis' }, f.name),
      h('div', { class: 'li-sub' }, `${fmtBytes(f.size)} · ${f.disabled ? '已禁用' : '已启用'}`),
    ]),
    h('button', { class: 'btn btn-sm', onclick: () => fileDetail(f, type) }, '详情'),
    h('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        try { await api(`/api/instances/${inst.id}/files/toggle`, { method: 'POST', body: { type, name: f.name } }); render(); }
        catch (e) { toastErr('操作失败', e.message); }
      },
    }, f.disabled ? '启用' : '禁用'),
    h('button', {
      class: 'btn btn-sm btn-danger',
      onclick: async () => {
        if (!(await confirmDialog({ title: '删除文件', message: `确定删除 ${f.name} 吗？`, okText: '删除', danger: true }))) return;
        try { await api(`/api/instances/${inst.id}/files`, { method: 'DELETE', body: { type, name: f.name } }); render(); }
        catch (e) { toastErr('删除失败', e.message); }
      },
    }, '删除'),
  ]);

  const render = async () => {
    resetScroll();
    content.innerHTML = '';
    content.append(h('div', { class: 'loading-inline' }, [h('div', { class: 'spinner' }), '加载中…']));
    try {
      if (tab === 'overview') {
        const resp = await api('/api/versions').catch(() => ({ versions: [] }));
        const versions = (resp.versions || []).filter((v) => v.type === 'release').slice(0, 100);
        const verSelect = h('select', { class: 'select' }, versions.map((v) => h('option', { value: v.id, selected: v.id === inst.versionId }, v.id)));
        const loaderSelect = h('select', { class: 'select' }, [['vanilla', '原版 Vanilla'], ['fabric', 'Fabric'], ['quilt', 'Quilt'], ['forge', 'Forge'], ['neoforge', 'NeoForge']]
          .map(([k, l]) => h('option', { value: k, selected: k === (inst.loader?.type || 'vanilla') }, l)));
        const openType = (type) => api(`/api/instances/${inst.id}/open`, { method: 'POST', body: { type } }).catch(() => {});
        content.replaceChildren(
          h('div', { class: 'callout info' }, `当前版本：${inst.versionId || '未安装'} · 加载器：${loaderLabel(inst.loader)} · 账户：${state.accounts.find((a) => a.id === inst.accountId)?.username || '默认'}`),
          h('div', { class: 'row', style: { flexWrap: 'wrap' } }, [
            h('div', { class: 'field', style: { flex: '1 1 220px' } }, [h('label', {}, '游戏版本'), verSelect]),
            h('div', { class: 'field', style: { flex: '0 0 190px' } }, [h('label', {}, '模组加载器'), loaderSelect]),
          ]),
          h('div', { class: 'hint' }, '更改版本或加载器会重新下载对应文件；已安装的模组不会删除，但可能不兼容新版本。'),
          h('div', { class: 'row', style: { flexWrap: 'wrap' } }, [
            h('button', {
              class: 'btn btn-primary',
              onclick: async (e) => {
                const btn = e.currentTarget;
                try {
                  btn.disabled = true; btn.textContent = '正在开始安装…';
                  await api(`/api/instances/${inst.id}/setup`, { method: 'POST', body: { versionId: verSelect.value, loader: loaderSelect.value, loaderVersion: null } });
                  toast({ kind: 'info', title: '开始安装', message: '进度见左下角，完成后即可启动', timeout: 4000 });
                  close && close();
                } catch (err) { toastErr('安装失败', err.message); btn.disabled = false; btn.textContent = '保存并安装'; }
              },
            }, '保存并安装'),
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn btn-sm', onclick: () => openType('mods') }, 'Mod 文件夹'),
            h('button', { class: 'btn btn-sm', onclick: () => openType('saves') }, '存档文件夹'),
            h('button', { class: 'btn btn-sm', onclick: () => openType('screenshots') }, '截图文件夹'),
            h('button', { class: 'btn btn-sm', onclick: () => openType('logs') }, '日志文件夹'),
          ]),
        );
      } else if (tab === 'settings') {
        const mem = h('input', { class: 'input', type: 'number', min: 512, max: 32768, step: 256, value: inst.memoryMb || '', placeholder: '跟随全局设置' });
        const java = h('input', { class: 'input', value: inst.javaPath || '', placeholder: 'auto（自动选择 Java）' });
        const jvm = h('textarea', { class: 'textarea', rows: 3, placeholder: '每行一个 JVM 参数，例如 -XX:+UseG1GC' }, inst.jvmArgs || '');
        const game = h('textarea', { class: 'textarea', rows: 2, placeholder: '额外游戏参数，例如 --width 1280 --height 720' }, inst.gameArgs || '');
        content.replaceChildren(
          h('div', { class: 'callout info' }, '这些设置只对当前实例生效，不会影响其他版本。'),
          h('div', { class: 'field' }, [h('label', {}, '内存分配（MB，留空跟随全局）'), mem]),
          h('div', { class: 'field' }, [h('label', {}, 'Java 路径（留空自动选择）'), java]),
          h('div', { class: 'field' }, [h('label', {}, 'JVM 参数'), jvm]),
          h('div', { class: 'field' }, [h('label', {}, '游戏参数'), game]),
          h('div', { class: 'row' }, [
            h('button', {
              class: 'btn btn-primary',
              onclick: async (e) => {
                const btn = e.currentTarget;
                try {
                  btn.disabled = true; btn.textContent = '保存中…';
                  await api(`/api/instances/${inst.id}`, {
                    method: 'PATCH',
                    body: {
                      memoryMb: mem.value ? Number(mem.value) : null,
                      javaPath: java.value.trim() || null,
                      jvmArgs: jvm.value,
                      gameArgs: game.value,
                    },
                  });
                  toastOk('实例设置已保存');
                  close && close(); ctxRef.refresh();
                } catch (err) { toastErr('保存失败', err.message); btn.disabled = false; btn.textContent = '保存设置'; }
              },
            }, '保存设置'),
            h('button', { class: 'btn', onclick: () => { mem.value = ''; java.value = ''; jvm.value = ''; game.value = ''; } }, '跟随全局'),
          ]),
        );
      } else if (tab === 'advanced') {
        const result = h('div', { class: 'tool-result' }, '可导出启动脚本、补全游戏文件或删除这个版本。');
        const openType = (type) => api(`/api/instances/${inst.id}/open`, { method: 'POST', body: { type } }).catch(() => {});
        const download = (text, name) => {
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = name; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        };
        content.replaceChildren(
          h('div', { class: 'row', style: { flexWrap: 'wrap' } }, [
            h('button', {
              class: 'btn',
              onclick: async () => {
                try {
                  const r = await api(`/api/instances/${inst.id}/dryrun`);
                  download('@echo off\r\nchcp 65001 >nul\r\n' + r.command + '\r\npause\r\n', `启动 ${inst.name}.bat`);
                  result.className = 'tool-result ok'; result.textContent = '已导出启动脚本（.bat）';
                } catch (e) { result.className = 'tool-result err'; result.textContent = '导出失败：' + e.message; }
              },
            }, '导出启动脚本'),
            h('button', {
              class: 'btn',
              onclick: async () => {
                try {
                  result.className = 'tool-result'; result.textContent = '正在校验文件…';
                  const r = await api('/api/toolbox/verify', { method: 'POST', body: { instanceId: inst.id } });
                  result.className = 'tool-result ok';
                  result.textContent = `校验完成：检查 ${r.checked || 0} 个文件，修复 ${r.repaired || 0} 个。`;
                } catch (e) { result.className = 'tool-result err'; result.textContent = '补全失败：' + e.message; }
              },
            }, '补全文件'),
            h('button', { class: 'btn', onclick: () => openType('logs') }, '打开日志'),
            h('button', {
              class: 'btn btn-danger',
              onclick: async () => { close && close(); await removeInstance(inst); },
            }, '删除版本'),
          ]),
          result,
        );
      } else if (tab === 'mods') {
        const resp = await api(`/api/instances/${inst.id}/installed-mods`);
        const files = resp.files || [];
        const enabled = files.filter((f) => !f.disabled).length;
        const disabled = files.length - enabled;
        const listBox = h('div', { class: 'installed-mods' });
        const search = h('input', { class: 'input', placeholder: '搜索 Mod 名称…', oninput: () => draw() });
        let modFilter = 'all';

        const toggle = async (f) => {
          try {
            await api(`/api/instances/${inst.id}/files/toggle`, { method: 'POST', body: { type: 'mods', name: f.name } });
            render();
          } catch (e) { toastErr('操作失败', e.message); }
        };
        const remove = async (f) => {
          if (!(await confirmDialog({ title: '删除 Mod', message: `确定删除 ${f.name} 吗？`, okText: '删除', danger: true }))) return;
          try {
            await api(`/api/instances/${inst.id}/files`, { method: 'DELETE', body: { type: 'mods', name: f.name } });
            render();
          } catch (e) { toastErr('删除失败', e.message); }
        };
        const detail = (f) => {
          const meta = f.meta || {};
          const displayName = modDisplayName({ title: meta.name || f.name, slug: meta.id || '', project_id: '' });
          const updateStatus = h('div', { class: 'hint' }, '正在检查新版本…');
          const mcmodBox = h('div', { class: 'mcmod-box hint' }, '正在读取 MC百科 中文资料…');
          let updateInfo = null;
          const m = modal({
            title: displayName,
            wide: true,
            body: [
              h('div', { class: 'row', style: { gap: '14px', alignItems: 'flex-start' } }, [
                f.icon ? h('img', { class: 'mod-detail-icon', src: f.icon, alt: '', onerror: (e) => { e.target.style.display = 'none'; } }) : h('div', { class: 'mod-icon-box' }, '✦'),
                h('div', { class: 'grow' }, [
                  h('div', { class: 'panel-title' }, displayName),
                  h('div', { class: 'hint' }, `${meta.version ? '模组版本 ' + meta.version : ''}${meta.loader ? ' · ' + meta.loader : ''}${meta.authors?.length ? ' · ' + meta.authors.join(', ') : ''}`),
                  h('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } }, [
                    badge(f.disabled ? '已禁用' : '已启用', f.disabled ? 'warn' : 'ok'),
                    badge(fmtBytes(f.size)),
                    zhModName({ title: meta.name || f.name, slug: meta.id || '' }) ? badge('有中文名', 'accent') : null,
                  ]),
                ]),
              ]),
              meta.description ? h('p', { class: 'hint', style: { marginTop: '12px', lineHeight: '1.7' } }, `原始简介：${meta.description}`) : null,
              mcmodBox,
              updateStatus,
              h('div', { class: 'detail-list', style: { marginTop: '12px' } }, [
                h('div', { class: 'detail-item' }, [h('span', {}, '文件'), h('strong', { class: 'mono' }, f.name)]),
              ]),
            ],
            actions: [
              { label: '文件位置', onClick: () => api(`/api/instances/${inst.id}/open`, { method: 'POST', body: { type: 'mods' } }).catch(() => {}) },
              { label: '一键更新', kind: 'primary', onClick: async () => {
                if (!updateInfo) { toastErr('没有可用更新', '请等待检查完成，或当前已是最新版本'); return false; }
                try {
                  const res = await api('/api/mods/install', { method: 'POST', body: {
                    projectId: updateInfo.projectId, versionId: updateInfo.versionId,
                    instanceId: inst.id, gameVersion: inst.versionId, loader: inst.loader?.type || 'vanilla',
                  } });
                  const newName = res.installed?.[0]?.filename;
                  if (newName && newName !== f.name) {
                    await api(`/api/instances/${inst.id}/files`, { method: 'DELETE', body: { type: 'mods', name: f.name } });
                  }
                  toastOk('模组已更新', updateInfo.version);
                  m.close?.();
                  render();
                  return false;
                } catch (e) { toastErr('更新失败', e.message); return false; }
              } },
              { label: '查找新版本', onClick: () => {
                m.close?.(); close?.();
                sessionStorage.setItem('craftdeck.downloadTab', 'mods');
                sessionStorage.setItem('craftdeck.modquery', meta.name || f.name.replace(/\.jar$/, ''));
                location.hash = '#/downloads';
              } },
              { label: f.disabled ? '启用' : '禁用', onClick: () => { toggle(f); return true; } },
              { label: '删除', kind: 'danger', onClick: () => { remove(f); return true; } },
              { label: '关闭', kind: 'primary' },
            ],
          });
          (async () => {
            try {
              const mr = await api('/api/mcmod/search?q=' + encodeURIComponent(meta.name || f.name.replace(/\.jar$/, '')));
              if (mr?.found) {
                mcmodBox.className = 'mcmod-box';
                mcmodBox.replaceChildren(
                  h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, [badge('MC百科', 'ok'), h('span', { class: 'muted small' }, '中文资料优先')]),
                  h('div', { class: 'mcmod-title' }, mr.title),
                  h('div', { class: 'hint', style: { lineHeight: '1.7', marginTop: '4px' } }, mr.description || '暂无摘要'),
                  h('button', { class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: () => {
                    if (window.desktopWindow?.openExternal) window.desktopWindow.openExternal(mr.url);
                    else window.open(mr.url, '_blank', 'noopener');
                  } }, '打开 MC百科'),
                );
                const titleEl = m.el.querySelector('.modal-title');
                if (titleEl && mr.title) titleEl.textContent = mr.title;
              } else {
                mcmodBox.remove();
              }
            } catch { mcmodBox.remove(); }
          })();
          (async () => {
            try {
              const params = new URLSearchParams({ query: meta.name || f.name.replace(/\.jar$/, ''), type: 'mod', gameVersion: inst.versionId || '', loader: inst.loader?.type || '' });
              const r = await api('/api/mods/search?' + params.toString());
              const hit = r.hits?.[0];
              if (!hit) { updateStatus.textContent = '没有在 Modrinth 找到同名项目，可手动到下载页搜索。'; return; }
              const vs = await api(`/api/mods/versions/${hit.project_id}?gameVersion=${encodeURIComponent(inst.versionId || '')}&loader=${encodeURIComponent(inst.loader?.type || '')}`);
              const latest = Array.isArray(vs) ? vs[0] : vs.versions?.[0];
              if (!latest) { updateStatus.textContent = '没有找到可用版本。'; return; }
              if (latest.version_number && meta.version && latest.version_number !== meta.version) {
                updateInfo = { projectId: hit.project_id, versionId: latest.id, version: latest.version_number };
                updateStatus.className = 'callout warn';
                updateStatus.textContent = `发现新版本 ${latest.version_number}（当前 ${meta.version}），可点「一键更新」升级。`;
              } else {
                updateStatus.className = 'hint';
                updateStatus.textContent = `已是最新版本${latest.version_number ? '（' + latest.version_number + '）' : ''}。`;
              }
            } catch {
              updateStatus.textContent = '检查更新失败，可稍后重试。';
            }
          })();
        };
        const row = (f) => h('div', {
          class: `installed-mod ${f.disabled ? 'disabled' : ''}`,
          onclick: () => detail(f),
        }, [
          f.icon
            ? h('img', { class: 'mod-icon-img', src: f.icon, alt: '', loading: 'lazy', onerror: (e) => { e.target.replaceWith(h('div', { class: 'mod-icon-box' }, '✦')); } })
            : h('div', { class: 'mod-icon-box' }, '✦'),
          h('div', { class: 'mod-main' }, [
            h('div', { class: 'mod-item-title ellipsis' }, f.meta?.name || f.name.replace(/\.disabled$/i, '')),
            h('div', { class: 'mod-item-sub ellipsis' }, [
              f.meta?.version ? 'v' + f.meta.version : '',
              f.meta?.description ? ' · ' + f.meta.description : '',
            ].filter(Boolean).join('') || f.name),
          ]),
          h('div', { class: 'row', style: { gap: '5px' } }, [
            h('button', { class: 'btn btn-sm', onclick: (e) => { e.stopPropagation(); detail(f); } }, '详情'),
            h('button', { class: 'btn btn-sm', onclick: (e) => { e.stopPropagation(); toggle(f); } }, f.disabled ? '启用' : '禁用'),
            h('button', { class: 'btn btn-sm btn-danger', onclick: (e) => { e.stopPropagation(); remove(f); } }, '删除'),
          ]),
        ]);
        const draw = () => {
          const q = search.value.trim().toLowerCase();
          const arr = files.filter((f) => {
            if (modFilter === 'enabled' && f.disabled) return false;
            if (modFilter === 'disabled' && !f.disabled) return false;
            return !q || `${f.name} ${f.meta?.name || ''}`.toLowerCase().includes(q);
          });
          listBox.replaceChildren(...(arr.length ? arr.map(row) : [h('div', { class: 'hint' }, q ? '没有匹配的 Mod。' : modFilter === 'disabled' ? '没有禁用的 Mod。' : '还没有模组。可到「下载 → 模组」安装，或把 .jar 放进 mods 文件夹。')]));
        };
        draw();
        content.replaceChildren(
          h('div', { class: 'row', style: { flexWrap: 'wrap' } }, [
            h('div', { class: 'panel-title grow' }, `Mod 管理（${files.length}）`),
            h('button', { class: 'btn btn-sm btn-primary', onclick: async () => { await patchSettings({ lastInstanceId: inst.id }); close && close(); location.hash = '#/downloads'; } }, '下载新 Mod'),
            h('button', { class: 'btn btn-sm', onclick: () => api(`/api/instances/${inst.id}/open`, { method: 'POST', body: { type: 'mods' } }).catch(() => {}) }, '打开文件夹'),
          ]),
          h('div', { class: 'row', style: { gap: '6px' } }, [
            h('button', { class: `btn btn-sm ${modFilter === 'all' ? 'btn-primary' : ''}`, onclick: () => { modFilter = 'all'; draw(); } }, `全部 ${files.length}`),
            h('button', { class: `btn btn-sm ${modFilter === 'enabled' ? 'btn-primary' : ''}`, onclick: () => { modFilter = 'enabled'; draw(); } }, `启用 ${enabled}`),
            h('button', { class: `btn btn-sm ${modFilter === 'disabled' ? 'btn-primary' : ''}`, onclick: () => { modFilter = 'disabled'; draw(); } }, `禁用 ${disabled}`),
          ]),
          search,
          listBox,
        );
      } else if (tab === 'shaders') {
        const [shaders, packs] = await Promise.all([loadFileList('shaderpacks'), loadFileList('resourcepacks')]);
        content.replaceChildren(
          h('div', { class: 'row' }, [
            h('div', { class: 'panel-title grow' }, `光影包（${shaders.length}）`),
            h('button', { class: 'btn btn-sm', onclick: () => api(`/api/instances/${inst.id}/open`, { method: 'POST', body: { type: 'shaderpacks' } }).catch(() => {}) }, '打开文件夹'),
          ]),
          shaders.length ? h('div', { class: 'list' }, shaders.map((f) => fileRow(f, 'shaderpacks'))) : h('div', { class: 'hint' }, '还没有光影包。'),
          h('div', { class: 'divider' }),
          h('div', { class: 'row' }, [
            h('div', { class: 'panel-title grow' }, `材质包（${packs.length}）`),
            h('button', { class: 'btn btn-sm', onclick: () => api(`/api/instances/${inst.id}/open`, { method: 'POST', body: { type: 'resourcepacks' } }).catch(() => {}) }, '打开文件夹'),
          ]),
          packs.length ? h('div', { class: 'list' }, packs.map((f) => fileRow(f, 'resourcepacks'))) : h('div', { class: 'hint' }, '还没有材质包。'),
        );
      } else {
        const accSelect = h('select', {
          class: 'select',
          onchange: async (e) => {
            try { await api(`/api/instances/${inst.id}`, { method: 'PATCH', body: { accountId: e.target.value || null } }); toastOk('已切换账户'); ctxRef.refresh(); }
            catch (err) { toastErr('切换失败', err.message); }
          },
        }, [
          h('option', { value: '' }, '使用默认账户'),
          ...state.accounts.map((a) => h('option', { value: a.id, selected: a.id === inst.accountId }, `${a.username} · ${a.type === 'microsoft' ? '正版' : a.type === 'thirdparty' ? '第三方' : '离线'}`)),
        ]);
        content.replaceChildren(
          h('div', { class: 'callout info' }, '这里的账户用于启动这个实例。正版账户可进正版服，离线/第三方账户适合单机或对应皮肤站服务器。'),
          h('div', { class: 'field' }, [h('label', {}, '实例账户'), accSelect]),
          h('div', { class: 'row' }, [
            h('button', { class: 'btn btn-sm', onclick: () => { close && close(); location.hash = '#/accounts'; } }, '管理账户（正版 / 离线 / 第三方）'),
            h('button', { class: 'btn btn-sm', onclick: () => { close && close(); location.hash = '#/skins'; } }, '设置皮肤'),
          ]),
          h('div', { class: 'hint' }, '离线账户 UUID 由用户名派生；第三方账户需要在账户页填写皮肤站地址。'),
        );
      }
    } catch (e) {
      content.replaceChildren(h('div', { class: 'callout err' }, e.message));
    }
  };
  render();
}

/* ---------------- 页面 ---------------- */
async function loadHomeNews(slot) {
  if (!slot || state.settings.showNews === false) return;
  try {
    const r = await api('/api/news');
    const items = (r.entries || []).slice(0, 6);
    if (!items.length) {
      slot.remove();
      document.querySelector('.home-body')?.classList.remove('has-news');
      document.querySelector('.stats-row.has-news-inline')?.classList.remove('has-news-inline');
      return;
    }
    const openExternal = (n) => {
      if (window.desktopWindow?.openExternal && n.url) window.desktopWindow.openExternal(n.url);
      else if (n.url) window.open(n.url, '_blank', 'noopener');
    };
    const thumb = (n) => {
      const fallback = h('div', { class: 'news-side-img placeholder' }, [
        h('span', {}, n.category === '整合包推荐' ? '整合包' : 'MC 资讯'),
      ]);
      if (!n.image) return fallback;
      return h('img', {
        class: 'news-side-img', src: `/api/news/image?url=${encodeURIComponent(n.image)}`, alt: '', loading: 'lazy',
        onerror: (e) => e.target.replaceWith(fallback),
      });
    };
    const newsCard = (n, modalView = false) => h('a', {
      class: 'news-side-card', href: n.url || '#', target: '_blank', rel: 'noreferrer',
      onclick: (e) => { e.preventDefault(); openExternal(n); },
    }, [
      thumb(n),
      h('div', { class: 'news-side-body' }, [
        h('div', { class: 'news-side-title' }, n.title),
        h('div', { class: 'news-side-meta' }, `${n.category || '资讯'} · ${n.date || ''}`),
        h('div', { class: 'news-side-text' }, n.text || ''),
      ]),
    ]);
    const showAll = () => {
      modal({
        title: 'Minecraft 中文资讯',
        wide: true,
        body: h('div', { class: 'news-side-list news-modal-list' }, items.map((n) => newsCard(n, true))),
        actions: [{ label: '关闭', kind: 'primary' }],
      });
    };
    const collapsed = state.settings.newsCollapsed === true;
    const inline = slot.classList.contains('inline-news');
    slot.className = `home-news-side ${collapsed ? 'collapsed' : ''} ${inline ? 'inline-news' : ''}`;
    const toggle = h('button', {
      class: 'news-collapse', type: 'button', 'data-tip': collapsed ? '展开资讯' : '收起资讯',
      html: `<span class="news-toggle-text">MC新闻</span>${icon('chevron', 16)}`,
    });
    toggle.addEventListener('click', async () => {
      const isCollapsed = slot.classList.contains('collapsed');
      const next = !isCollapsed;
      const body = document.querySelector('.home-body');
      const stats = document.querySelector('.stats-row');
      if (isCollapsed && stats) {
        // 展开：从统计行移回右侧，不刷新整个页面。
        slot.remove();
        body?.append(slot);
        stats.classList.remove('has-news-inline');
        slot.className = 'home-news-side';
        body?.classList.remove('news-inline', 'news-collapsed');
        body?.classList.add('has-news');
      } else if (!isCollapsed && stats) {
        // 收起：变成和统计卡片同宽的方形卡片。
        slot.remove();
        stats.append(slot);
        stats.classList.add('has-news-inline');
        slot.className = 'home-news-side collapsed inline-news';
        body?.classList.add('news-inline', 'news-collapsed');
      } else {
        slot.classList.toggle('collapsed', next);
        body?.classList.toggle('news-collapsed', next);
      }
      toggle.dataset.tip = next ? '展开资讯' : '收起资讯';
      try { await patchSettings({ newsCollapsed: next }); } catch { /* ignore */ }
    });
    slot.replaceChildren(
      h('div', { class: 'news-panel-head' }, [
        h('div', { class: 'news-panel-title' }, [badge('MC', 'accent'), h('strong', {}, '资讯')]),
        toggle,
      ]),
      h('div', { class: 'news-side-list' }, items.map((n) => newsCard(n))),
      h('button', { class: 'news-more', onclick: showAll }, '查看全部资讯'),
    );
  } catch {
    slot.remove();
    document.querySelector('.home-body')?.classList.remove('has-news');
    document.querySelector('.stats-row.has-news-inline')?.classList.remove('has-news-inline');
  }
}

export default {
  async render(el, ctx) {
    view = el;
    ctxRef = ctx;
    let inst = currentInstance();
    if (inst?.installing) inst = state.instances.find((i) => !i.installing) || null;
    if (inst && state.settings.lastInstanceId !== inst.id) inst = state.instances.find((i) => i.id === state.settings.lastInstanceId && !i.installing) || inst;
    const readyInstances = state.instances.filter((i) => !i.installing);
    const newsSlot = state.settings.showNews !== false ? h('div', { class: `home-news-side ${state.settings.newsCollapsed ? 'collapsed' : ''}` }) : null;
    const mainParts = [];
    const collapsed = state.settings.newsCollapsed === true;
    const statsEl = state.settings.showStats !== false ? statsRow(readyInstances.length) : null;
    const inlineNews = !!(statsEl && newsSlot && collapsed);
    if (statsEl && newsSlot && collapsed) {
      statsEl.append(newsSlot);
      statsEl.classList.add('has-news-inline');
      newsSlot.classList.add('inline-news');
    }
    if (statsEl) mainParts.push(statsEl);
    if (state.settings.showInstances !== false) {
      const shown = favoritesOnly ? readyInstances.filter((i) => i.favorite) : readyInstances;
      mainParts.push(sectionTitle('可启动版本', h('div', { class: 'row', style: { gap: '7px' } }, [
        h('button', {
          class: `btn btn-sm ${favoritesOnly ? 'btn-primary' : ''}`,
          html: favoritesOnly ? `${icon('back', 14)}<span>返回全部</span>` : `${icon('star', 14)}<span>收藏</span>`,
          onclick: () => { favoritesOnly = !favoritesOnly; ctxRef?.refresh?.(); },
        }),
        h('span', { class: 'muted small' }, `${shown.length}${favoritesOnly ? ' 个收藏' : ' 个'}`),
      ])));
      mainParts.push(shown.length
        ? h('div', { class: 'inst-grid' }, shown.map((i) => instanceCard(i)))
        : emptyState({ icon: '▦', title: favoritesOnly ? '还没有收藏的版本' : '还没有可启动的版本', sub: favoritesOnly ? '点版本卡片右上角的星星，把常玩的收藏起来。' : '去「下载」装一个，别让启动器一直闲着', action: favoritesOnly ? h('button', { class: 'btn', onclick: () => { favoritesOnly = false; ctxRef?.refresh?.(); } }, '查看全部版本') : h('button', { class: 'btn btn-primary', onclick: () => { location.hash = '#/downloads'; } }, '去下载版本') }));
    }
    if (!mainParts.length) mainParts.push(h('div', { class: 'callout info' }, '统计概览和版本列表已隐藏，可以在 设置 → 通用 里重新打开。'));

    el.append(h('div', { class: 'home' }, [
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, [
        h('div', {}, [
          h('h2', {}, `${timeGreeting()}，${state.activeAccount ? state.activeAccount.username : '玩家'}`),
          h('div', { class: 'muted', style: { marginTop: '4px' } }, '点击版本卡片切换当前启动项'),
        ]),
        h('div', { class: 'row' }, [
          h('button', {
            class: 'btn btn-sm', id: 'home-refresh', title: '刷新主界面', html: `${icon('refresh', 14)}<span>刷新</span>`,
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true; btn.innerHTML = `${icon('refresh', 14)}<span>刷新中…</span>`;
              try {
                await loadState();
                ctxRef.refresh();
                toastOk('主界面已刷新', '版本、实例与运行状态已重新读取');
              } catch (err) {
                toastErr('刷新失败', err.message);
              } finally {
                btn.disabled = false; btn.innerHTML = `${icon('refresh', 14)}<span>刷新</span>`;
              }
            },
          }),
          h('button', { class: 'btn btn-primary', onclick: () => { location.hash = '#/downloads'; } }, '下载游戏'),
        ]),
      ]),
      heroFor(inst),
      runningDock(inst),
      taskDock(),
      h('div', { class: `home-body ${newsSlot ? 'has-news' : ''} ${collapsed ? 'news-collapsed' : ''} ${inlineNews ? 'news-inline' : ''}` }, [
        h('div', { class: 'home-main' }, mainParts),
        collapsed && inlineNews ? null : newsSlot,
      ]),
    ]));
    if (newsSlot) loadHomeNews(newsSlot);
    if (focusHandler) window.removeEventListener('focus', focusHandler);
    focusHandler = () => {
      if (document.hidden || document.querySelector('.modal-backdrop, .modal')) return;
      loadState().then(() => { if (view?.isConnected) ctxRef?.refresh?.(); }).catch(() => {});
    };
    window.addEventListener('focus', focusHandler);

    unsub = subscribe((evt) => {
      if (evt.type === 'sse') {
        const e = evt.evt;
        if (e.type === 'launch' && (e.phase === 'exit' || e.phase === 'running' || e.phase === 'error')) {
          if (e.phase === 'exit') {
            setTimeout(refresh, 400);
            const code = Number(e.code) >>> 0;
            if (code !== 0 && (Number(e.durationMs) || 0) < 60000) setTimeout(() => showEarlyExit(inst, e), 200);
          }
        }
        if (e.type === 'progress' && e.scope === 'setup' && e.finished) setTimeout(refresh, 500);
      }
    });
  },
  destroy() {
    if (unsub) unsub();
    if (focusHandler) window.removeEventListener('focus', focusHandler);
    focusHandler = null;
    unsub = null;
    view = null;
    ctxRef = null;
  },
};
