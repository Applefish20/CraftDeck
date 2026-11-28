/**
 * CraftDeck 桌面版入口（Electron 外壳）。
 * 开发运行：npm i -D electron && npm run desktop
 * 打包运行：dist/CraftDeck-win32-x64/CraftDeck.exe（resources/app 内为本项目文件）
 * 核心逻辑仍由 server/server.mjs 提供，Electron 只负责窗口与系统集成。
 *
 * 启动日志：%APPDATA%\CraftDeck\logs\desktop.log（排查“双击没反应”时看这里）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
let LOG_DIR = path.join(process.env.APPDATA || process.env.TEMP || '.', 'CraftDeck', 'logs');
let LOG_FILE = path.join(LOG_DIR, 'desktop.log');

// Windows 下从快捷方式/无控制台启动时 stdout 管道可能已被关闭；写入会异步触发
// EPIPE，try/catch 捕获不到，必须提前吞掉流错误，否则会弹出“未捕获异常”。
process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch { /* ignore */ }
  try {
    if (process.stdout?.isTTY && process.stdout.writable) process.stdout.write(line);
  } catch { /* ignore */ }
}

log('---- desktop start ----');
log('argv=' + process.argv.join(' '));
log('electron=' + process.versions.electron + ' chrome=' + process.versions.chrome + ' node=' + process.versions.node);
log('platform=' + process.platform + ' arch=' + process.arch);

let electron;
try {
  electron = await import('electron');
} catch (e) {
  log('import electron failed: ' + (e.stack || e));
  process.exit(1);
}
const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = electron;

/**
 * 便携版目录：
 *   CraftDeck-3.6.1/
 *     CraftDeck/   ← 启动器本体（exe）
 *     minecraft/   ← 只放游戏实例/版本
 *     log/         ← 下载、缓存、日志、账户配置
 *     ﹣启动 CraftDeck.lnk
 */
const exeDir = path.dirname(app.getPath('exe'));
const bundleDir = path.resolve(exeDir, '..');
const portable = (() => {
  const candidates = [
    { root: path.join(bundleDir, 'log'), instances: path.join(bundleDir, 'minecraft') },
    { root: path.join(bundleDir, 'log'), instances: path.join(bundleDir, 'Minecraft') },
    // 兼容旧版单文件夹布局：Minecraft/ 就是数据根。
    { root: path.join(bundleDir, 'Minecraft'), instances: path.join(bundleDir, 'Minecraft', 'instances') },
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c.root).isDirectory()) return c;
    } catch { /* continue */ }
  }
  return null;
})();
const portableRoot = portable?.root || null;

if (portableRoot) {
  process.env.MCL_ROOT = portableRoot;
  process.env.MCL_INSTANCES = portable.instances;
  LOG_DIR = path.join(portableRoot, 'logs');
  LOG_FILE = path.join(LOG_DIR, 'desktop.log');
  // Windows 会给从浏览器下载的 ZIP 打上“来自 Internet”标记，解压后每个文件都会继承。
  // 首次运行后静默清理一次，避免每次打开 exe / 读写文件都弹安全提示。
  try {
    const marker = path.join(portableRoot, '.unblocked');
    if (!fs.existsSync(marker)) {
      const target = path.dirname(process.execPath).replace(/'/g, "''");
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Get-ChildItem -LiteralPath '${target}' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File`,
      ], { windowsHide: true, timeout: 30000 }, () => {});
      fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    }
  } catch { /* ignore */ }
}

app.setName('CraftDeck');
app.setAppUserModelId('com.craftdeck.launcher');
// Keep the Electron userData path inside log/electron for portable builds.
try {
  const stableUserData = portableRoot
    ? path.join(portableRoot, 'electron')
    : path.join(app.getPath('appData'), 'CraftDeck', 'electron');
  fs.mkdirSync(stableUserData, { recursive: true });
  app.setPath('userData', stableUserData);
} catch (e) { log('set stable userData failed: ' + e.message); }
const browserMode = process.argv.includes('--browser');

let win = null;
let serverInfo = null;
let appStore = null;
let quitting = false;

ipcMain.on('window:minimize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.minimize();
});
ipcMain.on('window:toggle-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.on('window:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.close();
});
ipcMain.on('open-external', (e, url) => {
  if (/^(https?:|mailto:)/i.test(String(url || ''))) shell.openExternal(String(url)).catch(() => {});
});

function fatal(title, err) {
  const text = String((err && err.stack) || err);
  log('FATAL ' + title + ': ' + text);
  try { dialog.showErrorBox(title, text + '\n\n日志：' + LOG_FILE); } catch { /* ignore */ }
}

process.on('uncaughtException', (e) => {
  if (e?.code === 'EPIPE') return;
  fatal('CraftDeck 未捕获异常', e);
});
process.on('unhandledRejection', (e) => {
  if (e?.code === 'EPIPE') return;
  fatal('CraftDeck 启动异常', e);
});

async function boot() {
  log('app ready');
  // Resolve the data directory only after Electron is ready, then import the server
  // (paths.mjs reads MCL_ROOT at module load time).
  if (!process.env.MCL_ROOT) {
    process.env.MCL_ROOT = path.join(app.getPath('appData'), 'CraftDeck');
  }
  log('MCL_ROOT=' + process.env.MCL_ROOT + (portableRoot ? ' (portable)' : ''));
  try {
    // 用系统钥匙串加密账户令牌后再落盘（Windows DPAPI / macOS Keychain）。
    try {
      const ss = electron.safeStorage;
      if (ss?.isEncryptionAvailable()) {
        global.__MCL_SAFE_STORAGE__ = {
          available: true,
          encryptString: (s) => ss.encryptString(String(s)).toString('base64'),
          decryptString: (b) => ss.decryptString(Buffer.from(String(b), 'base64')),
        };
      }
    } catch { /* ignore */ }
    const { startServer } = await import('./server/server.mjs');
    const port = Number(process.env.MCL_PORT) || 0;
    log('starting local server on port ' + (port || 'auto'));
    serverInfo = await startServer(port, '127.0.0.1');
    log('server ready: ' + serverInfo.loadUrl);
    try { appStore = (await import('./server/core/store.mjs')).store; } catch { /* ignore */ }
  } catch (e) {
    fatal('CraftDeck 本地服务启动失败', e);
    app.quit();
    return;
  }
  if (browserMode) {
    log('browser mode: opening ' + serverInfo.loadUrl);
    await shell.openExternal(serverInfo.loadUrl);
    return;
  }
  try {
    createWindow(serverInfo.loadUrl);
  } catch (e) {
    log('createWindow failed: ' + (e.stack || e));
    await shell.openExternal(serverInfo.loadUrl).catch(() => {});
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0a0d12',
    title: 'CraftDeck',
    autoHideMenuBar: true,
    icon: path.join(APP_DIR, 'icon.ico'),
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  log('window created, loading ' + url);
  win.loadURL(url).catch((e) => log('loadURL failed: ' + e.message));

  // A window that never becomes visible is the most common "双击没反应" symptom.
  // Force it visible after 8s; after 20s, fall back to the default browser.
  const showTimer = setTimeout(() => {
    if (!win) return;
    if (!win.isVisible()) {
      log('watchdog: window not visible after 8s, forcing show');
      try { win.show(); } catch (e) { log('show failed: ' + e.message); }
    }
  }, 8000);
  const fallbackTimer = setTimeout(() => {
    if (!win) return;
    const current = win.webContents.getURL();
    log('watchdog 20s: url=' + current + ' visible=' + win.isVisible());
    if (!current || current === 'about:blank') {
      log('watchdog: page never loaded, opening default browser');
      shell.openExternal(url).catch(() => {});
    }
  }, 20000);

  win.once('ready-to-show', () => {
    clearTimeout(showTimer);
    log('ready-to-show');
    win.show();
    if (process.env.MCL_SHOT) {
      setTimeout(async () => {
        try {
          const hasControls = await win.webContents.executeJavaScript('!!window.desktopWindow').catch(() => false);
          log('desktopWindow preload=' + hasControls);
          const navInfo = await win.webContents.executeJavaScript(`(() => {
            const e = document.querySelector('.nav-item.active');
            if (!e) return null;
            const s = e.querySelector('span:last-child');
            const r = e.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + 60, r.top + r.height / 2);
            return { text: e.textContent, theme: document.documentElement.dataset.theme, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent'), color: getComputedStyle(e).color, span: s && getComputedStyle(s).color, bg: getComputedStyle(e).backgroundColor, rect: [r.left, r.top, r.width, r.height], opacity: getComputedStyle(e).opacity, top: top && (top.className || top.id || top.tagName) };
          })()`).catch(() => null);
          log('navinfo ' + JSON.stringify(navInfo));
          if (process.env.MCL_CLICK) {
            await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(process.env.MCL_CLICK)})?.click()`).catch((e) => log('click failed: ' + e.message));
            await new Promise((r) => setTimeout(r, 1800));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.MCL_SHOT, img.toPNG());
          log('screenshot saved: ' + process.env.MCL_SHOT);
        } catch (e) {
          log('screenshot failed: ' + e.message);
        }
        app.quit();
      }, 6000);
    }
  });
  win.webContents.on('did-finish-load', () => log('did-finish-load'));
  win.webContents.on('did-fail-load', (e, code, desc, failedUrl) => {
    log(`did-fail-load ${code} ${desc} ${failedUrl}`);
    dialog.showErrorBox('界面加载失败', `无法加载 ${failedUrl}\n${code} ${desc}\n\n已尝试用默认浏览器打开。`);
    shell.openExternal(url).catch(() => {});
  });
  win.webContents.on('render-process-gone', (e, details) => {
    log('render-process-gone: ' + JSON.stringify(details));
    shell.openExternal(url).catch(() => {});
  });
  win.on('unresponsive', () => log('window unresponsive'));
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  if (process.env.MCL_DEBUG === '1') win.webContents.openDevTools({ mode: 'detach' });
  win.on('close', (e) => {
    const toTray = appStore?.settings?.closeToTray === true || process.env.MCL_TRAY === '1';
    if (!quitting && toTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    log('window closed');
    clearTimeout(showTimer);
    clearTimeout(fallbackTimer);
    win = null;
  });
}

log('requesting single instance lock');
if (!app.requestSingleInstanceLock()) {
  log('another instance is already running; exiting this one');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance: focusing existing window');
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(boot).catch((e) => {
    fatal('CraftDeck 启动失败', e);
    app.quit();
  });
  app.on('activate', () => { if (!win && serverInfo) createWindow(serverInfo.loadUrl); });
  app.on('window-all-closed', () => {
    log('window-all-closed');
    if (!browserMode && process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    log('before-quit');
    try { serverInfo?.server?.close(); } catch { /* ignore */ }
  });
}
