/**
 * Game launch engine: builds the java command line for an instance and manages the game process.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  ensureDir, exists, readJson, readText, writeJson, uid, isWin, isMac, formatDuration,
} from './util.mjs';
import {
  ROOT, LIBRARIES_DIR, ASSETS_DIR, nativesDirFor, instanceGameDir, instanceDir,
} from './paths.mjs';
import { bus } from './events.mjs';
import { store, resolveInstance } from './store.mjs';
import {
  resolveVersion, readLocalVersionJson, installVersion, installLoader, classpathFor,
  libraryAllowed, arcForNative, extractNatives, buildVirtualAssets, collectAssetTasks,
} from './versions.mjs';
import { downloadBatch } from './downloader.mjs';

async function accountsApi() {
  try { return await import('../features/accounts.mjs'); } catch { return null; }
}

async function javaApi() {
  try { return await import('./java.mjs'); } catch { return { pickJava: async () => 'java', javaMajor: () => 0 }; }
}

const running = new Map(); // instanceId -> { child, startedAt, logPath, lines: [] }
const MAX_LOG_LINES = 4000;
const LAUNCHER_VERSION = '3.6.1';

export function isRunning(instanceId) {
  return running.has(instanceId);
}

export function runningList() {
  return [...running.entries()].map(([id, r]) => ({ instanceId: id, pid: r.child.pid, startedAt: r.startedAt, versionId: r.versionId }));
}

export function getRunning(instanceId) {
  return running.get(instanceId) || null;
}

export function getLogTail(instanceId, n = 300) {
  const r = running.get(instanceId);
  if (r) return r.lines.slice(-n);
  try {
    const file = path.join(instanceDir(instanceId), 'launcher-last.log');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-n);
  } catch { /* ignore */ }
  return [];
}

export function writeStdin(instanceId, text) {
  const r = running.get(instanceId);
  if (!r) throw new Error('该实例未在运行');
  r.child.stdin.write(text + '\n');
}

/** Substitute ${...} placeholders in an argument string. */
export function substitute(str, vars) {
  return String(str).replace(/\$\{([^}]+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/** Evaluate a Mojang argument rule object for the current OS/features. */
export function ruleAllows(entry, features = {}) {
  if (typeof entry === 'string') return true;
  if (!entry || !entry.rules) return true;
  let allow = false;
  const osName = isWin ? 'windows' : isMac ? 'osx' : 'linux';
  for (const rule of entry.rules) {
    let ok = true;
    if (rule.os?.name && rule.os.name !== osName) ok = false;
    if (rule.os?.arch) {
      const want = rule.os.arch;
      if (want === 'x86' && process.arch !== 'ia32') ok = false;
      if (want === 'x86_64' && process.arch !== 'x64') ok = false;
      if (want === 'arm64' && process.arch !== 'arm64') ok = false;
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (!!features[k] !== !!v) ok = false;
      }
    }
    if (ok) allow = rule.action === 'allow';
  }
  return allow;
}

/**
 * Build everything needed to launch, without starting the process.
 * @returns {Promise<{javaPath, args, mainClass, cwd, versionId, variables, classpath}>}
 */
export async function buildLaunchCommand(instance, account, opts = {}) {
  const settings = store.settings;
  const versionId = instance.versionId;
  if (!versionId) throw new Error('请先为实例选择一个游戏版本');

  // Make sure base + loader files are installed.
  const loader = instance.loader || { type: 'vanilla' };
  if (!opts.skipInstallCheck) {
    const baseInstalled = await exists(path.join(ROOT, 'launcher', 'shared', 'versions', versionId, versionId + '.json'));
    if (!baseInstalled) {
      await installVersion(versionId, { taskId: opts.taskId });
    }
    if (loader.type && loader.type !== 'vanilla') {
      if (!loader.versionId || !readLocalVersionJson(loader.versionId)) {
        const newId = await installLoader(loader.type, versionId, loader.version, { taskId: opts.taskId });
        instance.loader.versionId = newId;
        store.updateInstance(instance.id, { loader: instance.loader });
      }
    }
  }

  const launchVersionId = loader.type && loader.type !== 'vanilla' && loader.versionId ? loader.versionId : versionId;
  const resolved = await resolveVersion(launchVersionId);
  // 启动前检查资源对象；缺失会导致游戏启动几秒后因 NoSuchFileException 退出。
  try {
    const assetTasks = await collectAssetTasks(resolved);
    const missing = assetTasks.filter((t) => !exists(t.dest));
    if (missing.length) {
      bus.log('warn', `检测到 ${missing.length} 个缺失的游戏资源，正在修复`);
      bus.progress({ taskId: opts.taskId || 'assets-repair', scope: 'launch', label: `修复缺失的游戏资源 (${missing.length})`, percent: 0.05 });
      const result = await downloadBatch(missing, {
        taskId: opts.taskId || 'assets-repair', scope: 'launch', label: '修复缺失的游戏资源', concurrency: 8,
      });
      if (result?.errors?.length) {
        throw new Error(`游戏资源修复失败：${result.errors[0].error || result.errors[0].message || '下载失败'}`);
      }
    }
  } catch (e) {
    if (/游戏资源修复失败/.test(e.message)) throw e;
    bus.log('warn', '资源预检查失败：' + e.message);
  }
  const gameDir = instance.gameDir || instanceGameDir(instance.id);
  await ensureDir(gameDir);
  for (const d of ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'logs', 'config', 'screenshots']) {
    await ensureDir(path.join(gameDir, d));
  }
  await ensureDir(path.join(gameDir, 'versions'));
  // 所有实例启动时统一中文；不覆盖其他 options 设置。
  try {
    const optFile = path.join(gameDir, 'options.txt');
    let text = '';
    try { text = await fsp.readFile(optFile, 'utf8'); } catch { /* new */ }
    const line = 'lang:zh_cn';
    if (/^lang:.*$/m.test(text)) text = text.replace(/^lang:.*$/m, line);
    else text = text.replace(/\s*$/, '') + (text ? '\n' : '') + line + '\n';
    await fsp.writeFile(optFile, text, 'utf8');
  } catch { /* ignore */ }

  // Natives: extract if needed
  const nativesDir = nativesDirFor(launchVersionId);
  await ensureDir(nativesDir);
  await extractNatives(resolved);
  await buildVirtualAssets(resolved);

  // --- Java selection
  const required = resolved.javaVersion?.majorVersion || (resolved.inheritsFrom ? 8 : 17);
  let javaPath = instance.javaPath && instance.javaPath !== 'auto' ? instance.javaPath : settings.javaPath;
  if (!javaPath || javaPath === 'auto') {
    const { pickJava } = await javaApi();
    try {
      javaPath = await pickJava({ major: required });
    } catch {
      javaPath = 'java';
    }
    if (!javaPath) javaPath = 'java';
  }
  if (!javaPath) throw new Error('未找到可用的 Java 运行时，请在设置中指定 Java 路径');
  try {
    const api = await javaApi();
    const info = api.javaInfo ? api.javaInfo(javaPath) : null;
    if (info && Number(info.major) > 0 && Number(info.major) < Number(required)) {
      throw new Error(`该版本需要 Java ${required}，当前使用的是 Java ${info.major}（${javaPath}）。请到设置 → Java 与内存选择 Java ${required}，或使用完整版内置 Java。`);
    }
  } catch (e) {
    if (/该版本需要 Java/.test(e.message)) throw e;
  }

  // --- Memory
  let memory = instance.memoryMb || settings.memoryMb || 2048;
  if (settings.autoMemory && !instance.memoryMb) {
    const total = Math.floor((os.totalmem() / 1024 / 1024 / 1024) * 1024);
    memory = Math.min(Math.max(2048, Math.floor(total * 0.5)), 8192);
  }
  memory = Math.max(512, Math.min(32768, Math.round(memory)));

  const classpath = await classpathFor(resolved);
  if (!classpath.length) throw new Error('缺少游戏核心文件，请重新安装版本');
  const cp = classpath.join(path.delimiter);
  const sep = path.delimiter;

  // --- Account variables
  const acct = account || store.getAccount(instance.accountId) || store.getAccount(settings.lastAccountId);
  if (!acct) throw new Error('请先添加并选择一个账户');
  const userType = acct.type === 'microsoft' ? 'msa' : acct.type === 'thirdparty' ? 'mojang' : 'legacy';
  const width = Number(opts.width || instance.windowWidth || settings.windowWidth) || 0;
  const height = Number(opts.height || instance.windowHeight || settings.windowHeight) || 0;
  const features = {
    is_demo_user: false,
    has_custom_resolution: !!(width && height),
    has_quick_plays_support: false,
  };
  const vars = {
    auth_player_name: acct.username,
    version_name: launchVersionId,
    game_directory: gameDir,
    assets_root: ASSETS_DIR,
    assets_index_name: resolved.assets || resolved.assetIndex?.id || 'legacy',
    auth_uuid: acct.uuid,
    auth_access_token: acct.accessToken || '0',
    auth_session: `token:${acct.accessToken || '0'}:${acct.uuid}`,
    user_type: userType,
    user_properties: '{}',
    clientid: '',
    auth_xuid: acct.xuid || '',
    version_type: resolved.type || 'release',
    launcher_name: 'CraftDeck',
    launcher_version: LAUNCHER_VERSION,
    library_directory: LIBRARIES_DIR,
    classpath: cp,
    classpath_separator: sep,
    natives_directory: nativesDir,
    resolution_width: width || 1280,
    resolution_height: height || 720,
  };

  // --- JVM args
  const jvm = [];
  jvm.push(`-Xmx${memory}M`, `-Xms${Math.min(memory, 256)}M`);
  if (isWin) jvm.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
  if (process.arch === 'x64') jvm.push('-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50');
  jvm.push('-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8');
  jvm.push(`-Djava.library.path=${nativesDir}`);
  if (isMac) jvm.push('-XstartOnFirstThread');
  jvm.push('-Djna.tmpdir=' + nativesDir);
  jvm.push('-Dorg.lwjgl.system.SharedLibraryExtractPath=' + nativesDir);
  jvm.push('-Dio.netty.native.workdir=' + nativesDir);
  jvm.push('-Dminecraft.launcher.brand=CraftDeck', `-Dminecraft.launcher.version=${LAUNCHER_VERSION}`);

  const argumentTemplates = resolved.arguments?.jvm;
  if (Array.isArray(argumentTemplates) && argumentTemplates.length) {
    for (const entry of argumentTemplates) {
      if (!ruleAllows(entry, features)) continue;
      const value = typeof entry === 'string' ? entry : entry.value;
      const list = Array.isArray(value) ? value : [value];
      for (let i = 0; i < list.length; i++) {
        let s = substitute(list[i], vars);
        // Classpath is always appended by us (below); drop template -cp and its value.
        if (s === '-cp' || s === '-classpath') { i++; continue; }
        if (s === '${classpath}' || s === cp) continue;
        if (s.startsWith('-Djava.library.path=')) continue; // our natives dir wins
        jvm.push(s);
      }
    }
  }
  // Classpath & module-path related flags that loaders may add
  const extraCp = [];
  if (loader.type === 'forge' || loader.type === 'neoforge') {
    // Forge adds module path + add-modules in its arguments; already processed above.
  }
  jvm.push('-cp', cp);

  // Custom user JVM args
  if (instance.jvmArgs || settings.jvmArgs) {
    for (const part of String(instance.jvmArgs || settings.jvmArgs).match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
      jvm.push(part.replace(/^"|"$/g, ''));
    }
  }

  // Third-party auth (authlib-injector)
  try {
    if (acct.type === 'thirdparty') {
      const acc = await accountsApi();
      if (acc?.authlibJvmArgs) {
        const inject = await acc.authlibJvmArgs(acct);
        if (inject.args?.length) jvm.push(...inject.args);
      }
    }
  } catch (e) {
    bus.log('warn', 'authlib-injector 准备失败: ' + e.message);
  }

  // --- Game args
  const game = [];
  if (resolved.minecraftArguments) {
    for (const part of String(resolved.minecraftArguments).match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
      game.push(substitute(part, vars));
    }
  } else {
    for (const entry of resolved.arguments?.game || []) {
      if (!ruleAllows(entry, features)) continue;
      const value = typeof entry === 'string' ? entry : entry.value;
      const list = Array.isArray(value) ? value : [value];
      for (const raw of list) game.push(substitute(raw, vars));
    }
  }
  if (!game.length) {
    game.push('--username', vars.auth_player_name, '--version', launchVersionId,
      '--gameDir', gameDir, '--assetsDir', ASSETS_DIR,
      '--assetIndex', vars.assets_index_name, '--uuid', vars.auth_uuid,
      '--accessToken', vars.auth_access_token, '--userType', userType, '--userProperties', '{}');
  }
  // Direct connect (multiplayer "join server"): --server host --port port
  if (opts.server && opts.server.host) {
    game.push('--server', String(opts.server.host), '--port', String(opts.server.port || 25565));
  }

  // Log4j config for 1.12-ish versions
  if (resolved.logging?.client?.argument) {
    const logFile = path.join(ASSETS_DIR, 'log_configs', resolved.logging.client.file?.id || 'client.xml');
    if (fs.existsSync(logFile)) {
      jvm.unshift(substitute(resolved.logging.client.argument, { ...vars, path: logFile }));
    }
  }

  const mainClass = resolved.mainClass || 'net.minecraft.client.main.Main';
  const args = [...jvm, mainClass, ...game];
  return { javaPath, args, mainClass, cwd: gameDir, versionId: launchVersionId, variables: vars, classpath, memory, resolved };
}

/** Launch the game for an instance. Streams '[launch]' events with log lines. */
export async function launchInstance(instanceId, opts = {}) {
  if (running.has(instanceId)) throw new Error('该实例已经在运行中');
  const instance = resolveInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  if (!instance.accountId) {
    instance.accountId = store.settings.lastAccountId;
    if (!instance.accountId) throw new Error('请先添加并选择一个账户');
    store.updateInstance(instance.id, { accountId: instance.accountId });
  }
  let account = store.getAccount(instance.accountId);
  if (!account) throw new Error('所选账户不存在，请重新选择');
  const acc = await accountsApi();
  if (acc?.ensureValid) {
    account = await acc.ensureValid(account).catch((e) => { throw new Error('账户校验失败: ' + e.message); });
  }

  const taskId = opts.taskId || uid('launch_');
  bus.emitEvent({ type: 'launch', phase: 'preparing', instanceId, taskId });
  const built = await buildLaunchCommand(instance, account, { taskId, skipInstallCheck: opts.skipInstallCheck, server: opts.server });

  bus.emitEvent({ type: 'launch', phase: 'starting', instanceId, taskId, java: built.javaPath, versionId: built.versionId });
  bus.log('info', `启动 ${instance.name} (${built.versionId}) · Java: ${built.javaPath}`);

  const logFile = path.join(instanceDir(instance.id), 'launcher-last.log');
  await fsp.writeFile(logFile, `# ${new Date().toISOString()} ${built.javaPath} ${built.args.join(' ')}\n`).catch(() => {});

  const entry = { child: null, startedAt: Date.now(), logPath: logFile, lines: [], taskId, versionId: built.versionId, pid: null };
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const onData = (stream) => (buf) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      entry.lines.push(line);
      if (entry.lines.length > MAX_LOG_LINES) entry.lines.splice(0, entry.lines.length - MAX_LOG_LINES);
      logStream.write(line + '\n');
      bus.emitEvent({ type: 'launch', phase: 'log', instanceId, taskId, line, stream });
    }
  };

  /**
   * Some hardened environments (application sandboxes, aggressive AV) forbid opening
   * pipes for a child process. Piped stdio gives us the in-app console; if that is
   * denied we transparently relaunch with inherited handles so the game still starts.
   */
  const gameEnv = { ...process.env };
  delete gameEnv.JAVA_TOOL_OPTIONS;
  delete gameEnv._JAVA_OPTIONS;
  const spawnGame = (mode = 'pipe') => {
    const stdio = mode === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'];
    let child;
    try {
      child = spawn(built.javaPath, built.args, {
        cwd: built.cwd,
        windowsHide: false,
        stdio,
        env: gameEnv,
      });
    } catch (e) {
      // Windows can surface a denied pipe as a synchronous EPERM; retry with inherited stdio.
      if ((e.code === 'EPERM' || e.code === 'EACCES') && mode === 'pipe' && !entry.retried) {
        entry.retried = true;
        bus.log('warn', '无法捕获游戏输出（受限环境），将以继承控制台的方式启动游戏');
        return spawnGame('inherit');
      }
      throw new Error('无法启动 Java 进程: ' + (e.code === 'EPERM' ? '系统权限不足（沙箱/杀毒软件拦截）' : e.message));
    }
    entry.child = child;
    entry.pid = child.pid || null;
    if (mode === 'pipe') {
      child.stdout.on('data', onData('stdout'));
      child.stderr.on('data', onData('stderr'));
    }
    child.on('error', (e) => {
      if (e.code === 'EPERM' && mode === 'pipe' && !entry.retried) {
        entry.retried = true;
        bus.log('warn', '无法捕获游戏输出（受限环境），将以继承控制台的方式重新启动游戏');
        try { child.kill(); } catch { /* ignore */ }
        try { spawnGame('inherit'); return; } catch (e2) {
          bus.emitEvent({ type: 'launch', phase: 'error', instanceId, taskId, error: e2.message });
          bus.notify('error', '启动失败', e2.message);
          return;
        }
      }
      if (entry.child !== child) return;
      running.delete(instance.id);
      store.markRunning(instance.id, false);
      bus.emitEvent({ type: 'launch', phase: 'error', instanceId, taskId, error: e.code === 'EPERM' ? '系统禁止启动 Java 进程（沙箱/杀毒软件拦截）' : e.message });
      bus.notify('error', '启动失败', e.code === 'EPERM' ? '系统禁止启动 Java 进程（沙箱/杀毒软件拦截）' : e.message);
    });
    child.on('exit', (code, signal) => {
      if (entry.child !== child) return; // superseded by a restart
      const ms = Date.now() - entry.startedAt;
      running.delete(instance.id);
      store.markRunning(instance.id, false);
      store.recordLaunch(instance.id, ms);
      logStream.end();
      bus.emitEvent({ type: 'launch', phase: 'exit', instanceId, taskId, code, signal, durationMs: ms });
      bus.log('info', `${instance.name} 已退出 (code ${code})，本次游戏时长 ${formatDuration(ms)}`);
    });
    return child;
  };

  const child = spawnGame('pipe');
  running.set(instance.id, entry);
  store.markRunning(instance.id, true);
  bus.emitEvent({ type: 'launch', phase: 'running', instanceId, taskId, pid: child.pid });

  store.recordLaunch(instance.id, 0);
  return { ok: true, instanceId, pid: child.pid, taskId, command: { java: built.javaPath, args: built.args.length, memory: built.memory } };
}

export async function killInstance(instanceId) {
  const r = running.get(instanceId);
  if (!r) return false;
  const pid = r.child?.pid;
  // Terminate the process directly first: this works even when spawning helpers is blocked.
  try {
    if (pid) process.kill(pid, 'SIGTERM');
  } catch { /* ignore */ }
  try {
    if (isWin && pid) {
      spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true, stdio: 'ignore' });
    } else if (!isWin) {
      r.child.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  return true;
}

/** Diagnostics: returns the generated command without launching. */
export async function dryRun(instanceId, accountId) {
  const instance = resolveInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const account = accountId ? store.getAccount(accountId) : store.getAccount(instance.accountId) || store.getAccount(store.settings.lastAccountId);
  if (!account) throw new Error('请先添加一个账户');
  const built = await buildLaunchCommand(instance, account, { skipInstallCheck: true });
  return {
    javaPath: built.javaPath, mainClass: built.mainClass, cwd: built.cwd, versionId: built.versionId,
    command: [built.javaPath, ...built.args].join(' '), classpathCount: built.classpath.length, memory: built.memory,
    argsCount: built.args.length,
  };
}
