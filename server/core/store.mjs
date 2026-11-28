import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE_FILE, INSTANCES_DIR, ensureLayout } from './paths.mjs';
import { readJsonSync, writeJsonSync, uid, safeFileName } from './util.mjs';
import { bus } from './events.mjs';

export const DEFAULT_SETTINGS = {
  javaPath: 'auto',
  memoryMb: 4096,
  autoMemory: true,
  windowWidth: 0,
  windowHeight: 0,
  jvmArgs: '',
  downloadSource: 'auto', // auto | official
  language: 'zh-CN',
  theme: 'light',
  accent: '#1962f5',
  background: { type: 'preset', value: 'aurora', blur: 0, dim: 0.35, opacity: 1 },
  music: false,
  closeToTray: false,
  keepLauncherOpen: false,
  autoUpdateManifest: true,
  showSnapshots: false,
  showOldVersions: false,
  maxConcurrentDownloads: 24,
  downloadThreads: 12,
  maxUploadMb: 4096,
  curseforgeApiKey: '',
  microsoftClientId: 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb',
  translationEnabled: true,
  translationSource: 'auto',
  translateModNames: true,
  updateFeedUrl: '',
  autoCheckUpdate: false,
  lastInstanceId: null,
  lastAccountId: null,
  onboarded: false,
  hiddenPages: [],
  hiddenTabs: [],
  hideNavText: false,
  showNews: true,
  showStats: true,
  showInstances: true,
  newsCollapsed: false,
};

function freshState() {
  return {
    version: 2,
    createdAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS, background: { ...DEFAULT_SETTINGS.background } },
    accounts: [],
    instances: [],
    servers: [],
    hosts: [],
    tasks: [],
    stats: { launches: 0, playTimeMs: 0 },
  };
}

class Store {
  constructor() {
    ensureLayout();
    this.state = freshState();
    this.load();
    if (!this.state.instances.length) {
      const recovered = this.recoverInstancesFromDirs();
      if (recovered.length) {
        this.state.instances = recovered;
        this.state.settings.lastInstanceId = recovered[0].id;
        this.save();
        bus.log('warn', `检测到 ${recovered.length} 个实例目录，已自动恢复实例列表（账户需重新登录）`);
      } else {
        this.seed();
      }
    }
  }

  /** 配置丢失但 instances 目录还在时，至少把游戏实例救回来。 */
  recoverInstancesFromDirs() {
    try {
      if (!fs.existsSync(INSTANCES_DIR)) return [];
      const dirs = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
      const now = Date.now();
      return dirs.map((id) => {
        const m = /^(.+?)-(Fabric|Forge|NeoForge|Quilt)_(.+)$/i.exec(id);
        return {
          id,
          name: id,
          versionId: m ? m[1] : id,
          loader: m ? { type: m[2].toLowerCase(), version: m[3] } : { type: 'vanilla', version: null },
          accountId: null,
          javaPath: null,
          memoryMb: null,
          jvmArgs: '',
          gameDir: null,
          notes: '从原有实例目录自动恢复',
          createdAt: now,
          lastPlayed: null,
          playTimeMs: 0,
          launchCount: 0,
          modsEnabled: true,
          mrpackName: null,
          icon: null,
          cover: null,
          modpackIcon: null,
        };
      });
    } catch { return []; }
  }

  load() {
    let raw = readJsonSync(STATE_FILE, null);
    if (!raw) {
      const backup = readJsonSync(STATE_FILE + '.bak', null);
      if (backup) {
        raw = backup;
        bus.log('warn', '主配置文件缺失或损坏，已从 state.json.bak 恢复');
      }
    }
    if (!raw) return;
    const accounts = (raw.accounts || []).map((a) => this.decryptAccount({ ...a }));
    this.state = {
      ...freshState(),
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}), background: { ...DEFAULT_SETTINGS.background, ...((raw.settings || {}).background || {}) } },
      accounts,
      instances: raw.instances || [],
      servers: raw.servers || [],
      hosts: raw.hosts || [],
    };
    this.migrate();
  }

  decryptAccount(account) {
    const api = global.__MCL_SAFE_STORAGE__;
    if (!api?.available || !api.decryptString) return account;
    for (const field of ['accessToken', 'refreshToken', 'clientToken']) {
      const value = account[field];
      if (typeof value === 'string' && value.startsWith('enc:')) {
        try { account[field] = api.decryptString(value.slice(4)); }
        catch { bus.log('warn', `账户 ${account.username || account.id} 的 ${field} 解密失败，请重新登录`); }
      }
    }
    return account;
  }

  encryptedAccounts() {
    const api = global.__MCL_SAFE_STORAGE__;
    if (!api?.available || !api.encryptString) return this.state.accounts;
    return this.state.accounts.map((a) => {
      const copy = { ...a };
      for (const field of ['accessToken', 'refreshToken', 'clientToken']) {
        const value = copy[field];
        if (typeof value === 'string' && value && !value.startsWith('enc:')) {
          try { copy[field] = 'enc:' + api.encryptString(value); } catch { /* keep */ }
        }
      }
      return copy;
    });
  }

  serializeState() {
    return { ...this.state, accounts: this.encryptedAccounts() };
  }

  migrate() {
    const v = Number(this.state.version) || 1;
    if (v < 2) {
      // v2: 增加窗口大小设置；实例字段保持兼容，缺失的由默认值补齐。
      this.state.settings = { ...DEFAULT_SETTINGS, ...(this.state.settings || {}) };
      this.state.version = 2;
      this.save();
    }
    this.migrateInstanceFolders();
  }

  /** 把 inst_xxx 随机目录改成「版本-加载器_版本」的可读目录名。 */
  migrateInstanceFolders() {
    let changed = false;
    const used = new Set(this.state.instances.map((i) => String(i.id || '').toLowerCase()));
    for (const inst of this.state.instances) {
      if (!/^inst_/i.test(String(inst.id || ''))) continue;
      const base = String(inst.versionId || inst.name || 'Minecraft').trim();
      const loader = String(inst.loader?.type || 'vanilla').toLowerCase();
      const loaderLabel = loader === 'vanilla' ? '' : `${loader.charAt(0).toUpperCase()}${loader.slice(1)}${inst.loader?.version ? `_${inst.loader.version}` : ''}`;
      let desired = safeFileName([base, loaderLabel].filter(Boolean).join('-')) || base;
      desired = desired.slice(0, 80) || 'Minecraft';
      let candidate = desired;
      let n = 2;
      while (used.has(candidate.toLowerCase()) && candidate.toLowerCase() !== String(inst.id).toLowerCase()) {
        candidate = `${desired}-${n++}`;
      }
      const oldId = inst.id;
      if (candidate === oldId) continue;
      const oldDir = path.join(INSTANCES_DIR, oldId);
      const newDir = path.join(INSTANCES_DIR, candidate);
      try {
        if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
      } catch {
        continue;
      }
      used.delete(String(oldId).toLowerCase());
      used.add(candidate.toLowerCase());
      inst.id = candidate;
      if (this.state.settings.lastInstanceId === oldId) this.state.settings.lastInstanceId = candidate;
      changed = true;
      bus.log('info', `实例目录已重命名为 ${candidate}`);
    }
    if (changed) this.save();
  }

  save() {
    this.scheduleSave();
  }

  scheduleSave() {
    if (this._t) return;
    this._t = setTimeout(() => {
      this._t = null;
      try {
        try { if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak'); } catch { /* ignore */ }
        writeJsonSync(STATE_FILE, this.serializeState());
      } catch (e) { bus.log('error', '保存配置失败: ' + e.message); }
    }, 120);
  }

  flush() {
    if (this._t) { clearTimeout(this._t); this._t = null; }
    try { if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak'); } catch { /* ignore */ }
    writeJsonSync(STATE_FILE, this.serializeState());
  }

  seed() {
    const now = Date.now();
    this.state.instances = [{
      id: uid('inst_'),
      name: '默认实例',
      versionId: null,
      loader: { type: 'vanilla', version: null },
      accountId: null,
      javaPath: null,
      memoryMb: null,
      jvmArgs: '',
      gameDir: null,
      notes: '',
      createdAt: now,
      lastPlayed: null,
      playTimeMs: 0,
      launchCount: 0,
      modsEnabled: true,
      mrpackName: null,
      icon: null,
      cover: null,
      modpackIcon: null,
    }];
    this.state.settings.lastInstanceId = this.state.instances[0].id;
    this.save();
  }

  get settings() { return this.state.settings; }

  get instances() { return this.state.instances; }

  getInstance(id) { return this.state.instances.find((i) => i.id === id) || null; }

  addInstance(inst) {
    const item = {
      id: uid('inst_'), name: '新实例', versionId: null, loader: { type: 'vanilla', version: null },
      accountId: null, javaPath: null, memoryMb: null, jvmArgs: '', gameDir: null, notes: '',
      createdAt: Date.now(), lastPlayed: null, playTimeMs: 0, launchCount: 0, modsEnabled: true, mrpackName: null,
      icon: null, cover: null, modpackIcon: null, installing: false,
      ...inst,
    };
    this.state.instances.push(item);
    this.save();
    return item;
  }

  updateInstance(id, patch) {
    const inst = this.getInstance(id);
    if (!inst) return null;
    Object.assign(inst, patch, { id, updatedAt: Date.now() });
    this.save();
    return inst;
  }

  removeInstance(id) {
    const n = this.state.instances.length;
    this.state.instances = this.state.instances.filter((i) => i.id !== id);
    if (this.state.settings.lastInstanceId === id) {
      this.state.settings.lastInstanceId = this.state.instances[0]?.id || null;
    }
    this.save();
    return this.state.instances.length !== n;
  }

  get accounts() { return this.state.accounts; }

  getAccount(id) { return this.state.accounts.find((a) => a.id === id) || null; }

  addAccount(acc) {
    const item = { id: uid('acc_'), createdAt: Date.now(), ...acc };
    // one entry per (type, identity)
    const dup = this.state.accounts.findIndex((a) => a.type === item.type && a.uuid === item.uuid && a.username === item.username && (a.authServer || '') === (item.authServer || ''));
    if (dup >= 0) this.state.accounts[dup] = { ...this.state.accounts[dup], ...item, id: this.state.accounts[dup].id };
    else this.state.accounts.push(item);
    const saved = dup >= 0 ? this.state.accounts[dup] : item;
    if (!this.state.settings.lastAccountId) this.state.settings.lastAccountId = saved.id;
    this.save();
    return saved;
  }

  updateAccount(id, patch) {
    const acc = this.getAccount(id);
    if (!acc) return null;
    Object.assign(acc, patch, { id });
    this.save();
    return acc;
  }

  removeAccount(id) {
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
    for (const inst of this.state.instances) if (inst.accountId === id) inst.accountId = null;
    if (this.state.settings.lastAccountId === id) this.state.settings.lastAccountId = this.state.accounts[0]?.id || null;
    this.save();
  }

  get servers() { return this.state.servers; }

  addServer(s) {
    const item = { id: uid('srv_'), addedAt: Date.now(), ...s };
    this.state.servers.push(item);
    this.save();
    return item;
  }

  updateServer(id, patch) {
    const s = this.state.servers.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch);
    this.save();
    return s;
  }

  removeServer(id) {
    this.state.servers = this.state.servers.filter((s) => s.id !== id);
    this.save();
  }

  get hosts() { return this.state.hosts; }

  addHost(h) {
    const item = { id: uid('host_'), createdAt: Date.now(), ...h };
    this.state.hosts.push(item);
    this.save();
    return item;
  }

  updateHost(id, patch) {
    const h = this.state.hosts.find((x) => x.id === id);
    if (!h) return null;
    Object.assign(h, patch);
    this.save();
    return h;
  }

  removeHost(id) {
    this.state.hosts = this.state.hosts.filter((h) => h.id !== id);
    this.save();
  }

  updateSettings(patch) {
    this.state.settings = {
      ...this.state.settings,
      ...patch,
      background: { ...this.state.settings.background, ...(patch.background || {}) },
    };
    // 启动器当前账户切换后，所有游戏实例同步使用同一个账户。
    if (patch.lastAccountId && this.state.accounts.some((a) => a.id === patch.lastAccountId)) {
      for (const inst of this.state.instances) inst.accountId = patch.lastAccountId;
    }
    this.save();
    return this.state.settings;
  }

  /** Public state: secrets stripped. */
  publicState() {
    return {
      version: this.state.version,
      settings: this.state.settings,
      accounts: this.state.accounts.map((a) => ({
        id: a.id, type: a.type, username: a.username, uuid: a.uuid, authServer: a.authServer || null,
        skinModel: a.skinModel, createdAt: a.createdAt, expiresAt: a.expiresAt || null,
        hasSkin: !!a.skin, hasAvatar: !!a.avatar, isDefault: this.state.settings.lastAccountId === a.id,
      })),
      instances: this.state.instances.map((i) => this.instancesWithProgress(i)),
      servers: this.state.servers,
      hosts: this.state.hosts.map((h) => ({ ...h, pid: undefined })),
      stats: this.state.stats,
      root: ROOT,
    };
  }

  instancesWithProgress(i) {
    return { ...i, running: !!this.running?.[i.id] };
  }

  markRunning(instanceId, value) {
    this.running = this.running || {};
    if (value) this.running[instanceId] = Date.now();
    else delete this.running[instanceId];
    this.save();
  }

  recordLaunch(instanceId, ms) {
    const inst = this.getInstance(instanceId);
    this.state.stats.launches++;
    this.state.stats.playTimeMs += ms || 0;
    if (inst) {
      inst.launchCount = (inst.launchCount || 0) + 1;
      inst.lastPlayed = Date.now();
      inst.playTimeMs = (inst.playTimeMs || 0) + (ms || 0);
      this.state.settings.lastInstanceId = instanceId;
    }
    this.save();
  }
}

export const store = new Store();
export function instanceById(id) { return store.getInstance(id); }
export function resolveInstance(id) {
  if (id) return store.getInstance(id);
  return store.getInstance(store.settings.lastInstanceId) || store.instances[0] || null;
}
export { ROOT, fs };
