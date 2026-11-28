/**
 * 存档编辑：读取 / 修改 level.dat 中的常用世界设置。
 * 只使用 Node 内置模块实现最小 NBT 解析与写回，不改变其余标签。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { instanceGameDir } from '../core/paths.mjs';

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

const GAME_TYPES = ['生存', '创造', '冒险', '旁观'];
const DIFFICULTIES = ['和平', '简单', '普通', '困难'];

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() { return this.b.readUInt8(this.o++); }
  i8() { const v = this.b.readInt8(this.o); this.o += 1; return v; }
  i16() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; }
  u16() { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  i32() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  i64() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; }
  f32() { const v = this.b.readFloatBE(this.o); this.o += 4; return v; }
  f64() { const v = this.b.readDoubleBE(this.o); this.o += 8; return v; }
  str() { const n = this.u16(); const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
}

function readTag(r, type) {
  if (type === 0) return null;
  if (type === 1) return r.i8();
  if (type === 2) return r.i16();
  if (type === 3) return r.i32();
  if (type === 4) return r.i64();
  if (type === 5) return r.f32();
  if (type === 6) return r.f64();
  if (type === 7) { const n = r.i32(); const a = r.b.subarray(r.o, r.o + n); r.o += n; return a; }
  if (type === 8) return r.str();
  if (type === 9) {
    const t = r.u8(); const n = r.i32(); const list = [];
    for (let i = 0; i < n; i += 1) list.push(readTag(r, t));
    return { __listType: t, items: list };
  }
  if (type === 10) {
    const map = {};
    for (;;) {
      const t = r.u8();
      if (t === 0) break;
      const name = r.str();
      map[name] = { t, v: readTag(r, t) };
    }
    return map;
  }
  if (type === 11) { const n = r.i32(); const a = []; for (let i = 0; i < n; i += 1) a.push(r.i32()); return a; }
  if (type === 12) { const n = r.i32(); const a = []; for (let i = 0; i < n; i += 1) a.push(r.i64()); return a; }
  throw new Error('未知 NBT 类型 ' + type);
}

function parseNbt(buf) {
  const r = new Reader(buf);
  const t = r.u8();
  if (t !== 10) throw new Error('level.dat 不是复合标签');
  const name = r.str();
  const value = readTag(r, 10);
  return { name, value };
}

function encodeStr(s) {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2); len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function writeTag(t, v) {
  if (t === 1) { const b = Buffer.alloc(1); b.writeInt8(Number(v) || 0); return b; }
  if (t === 2) { const b = Buffer.alloc(2); b.writeInt16BE(Number(v) || 0); return b; }
  if (t === 3) { const b = Buffer.alloc(4); b.writeInt32BE(Number(v) || 0); return b; }
  if (t === 4) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v || 0)); return b; }
  if (t === 5) { const b = Buffer.alloc(4); b.writeFloatBE(Number(v) || 0); return b; }
  if (t === 6) { const b = Buffer.alloc(8); b.writeDoubleBE(Number(v) || 0); return b; }
  if (t === 7 || t === 11 || t === 12) {
    const data = t === 7 ? Buffer.from(v) : Buffer.alloc((t === 11 ? 4 : 8) * v.length);
    if (t === 11) v.forEach((x, i) => data.writeInt32BE(Number(x) || 0, i * 4));
    if (t === 12) v.forEach((x, i) => data.writeBigInt64BE(BigInt(x || 0), i * 8));
    const len = Buffer.alloc(4); len.writeInt32BE(data.length / (t === 7 ? 1 : t === 11 ? 4 : 8));
    return Buffer.concat([len, data]);
  }
  if (t === 8) return encodeStr(v);
  if (t === 9) {
    const head = Buffer.from([v.__listType || 0]); const len = Buffer.alloc(4); len.writeInt32BE(v.items.length);
    return Buffer.concat([head, len, ...v.items.map((x) => writeTag(v.__listType, x))]);
  }
  if (t === 10) {
    const parts = [];
    for (const [name, tag] of Object.entries(v)) {
      parts.push(Buffer.from([tag.t]), encodeStr(name), writeTag(tag.t, tag.v));
    }
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
  }
  throw new Error('未知 NBT 类型 ' + t);
}

function encodeNbt(root) {
  return Buffer.concat([Buffer.from([10]), encodeStr(root.name || ''), writeTag(10, root.value)]);
}

function safeWorldName(world) {
  const name = String(world || '').trim();
  if (!name || name !== path.basename(name) || name === '.' || name === '..') throw new Error('存档名称不合法');
  return name;
}

async function readLevel(instId, world) {
  const game = instanceGameDir(instId);
  const candidates = [path.join(game, 'saves', safeWorldName(world)), path.join(path.dirname(game), 'saves', safeWorldName(world))];
  let dir = null;
  for (const d of candidates) {
    try { await fs.access(path.join(d, 'level.dat')); dir = d; break; } catch { /* next */ }
  }
  if (!dir) throw new Error('找不到该存档的 level.dat');
  const file = path.join(dir, 'level.dat');
  const raw = await fs.readFile(file);
  const data = await gunzip(raw);
  const root = parseNbt(data);
  const level = root.value?.Data?.v;
  if (!level) throw new Error('level.dat 缺少 Data 标签');
  return { dir, file, root, level };
}

function readNumber(level, key, fallback = 0) {
  const tag = level[key];
  return tag ? Number(tag.v) : fallback;
}
function readString(level, key, fallback = '') {
  const tag = level[key];
  return tag ? String(tag.v) : fallback;
}
function readBool(level, key, fallback = false) {
  const tag = level[key];
  return tag ? !!Number(tag.v) : fallback;
}
function readLongString(level, key, fallback = '0') {
  const tag = level[key];
  return tag ? String(tag.v) : fallback;
}
function worldgen(level) { return level.WorldGenSettings?.v || level; }
function readRule(level, key, fallback = false) {
  const tag = level.GameRules?.v?.[key];
  return tag ? String(tag.v) === 'true' : fallback;
}
function readRuleNumber(level, key, fallback = 3) {
  const tag = level.GameRules?.v?.[key];
  return tag ? Number(tag.v) || fallback : fallback;
}
function publicWorld(world, level) {
  const gameType = readNumber(level, 'GameType', 0);
  const difficulty = readNumber(level, 'Difficulty', 2);
  const wg = worldgen(level);
  return {
    world,
    name: readString(level, 'LevelName', world),
    gameType,
    gameTypeLabel: GAME_TYPES[gameType] || '未知',
    difficulty,
    difficultyLabel: DIFFICULTIES[difficulty] || '未知',
    hardcore: !!readNumber(level, 'hardcore', 0),
    allowCommands: !!readNumber(level, 'allowCommands', 0),
    lastPlayed: readNumber(level, 'LastPlayed', 0),
    seed: readLongString(wg, 'seed', readLongString(level, 'RandomSeed', '0')),
    generateFeatures: readBool(wg, 'generate_features', readBool(level, 'generateFeatures', true)),
    bonusChest: readBool(wg, 'bonus_chest', readBool(level, 'bonusChest', false)),
    worldType: readString(level, 'generatorName', readString(level, 'WorldType', 'default')),
    spawnRadius: readNumber(level, 'spawnRadius', 10),
    gameRules: {
      keepInventory: readRule(level, 'keepInventory', false),
      doMobSpawning: readRule(level, 'doMobSpawning', true),
      doDaylightCycle: readRule(level, 'doDaylightCycle', true),
      doWeatherCycle: readRule(level, 'doWeatherCycle', true),
      mobGriefing: readRule(level, 'mobGriefing', true),
      naturalRegeneration: readRule(level, 'naturalRegeneration', true),
      doImmediateRespawn: readRule(level, 'doImmediateRespawn', false),
      doFireTick: readRule(level, 'doFireTick', true),
      randomTickSpeed: readRuleNumber(level, 'randomTickSpeed', 3),
    },
  };
}

function setString(level, key, value) { level[key] = { t: 8, v: String(value) }; }
function setInt(level, key, value) { level[key] = { t: 3, v: Number(value) || 0 }; }
function setLong(level, key, value) { level[key] = { t: 4, v: BigInt(String(value || '0').replace(/[^\d-]/g, '') || 0) }; }
function setRule(level, key, value) {
  if (!level.GameRules) level.GameRules = { t: 10, v: {} };
  level.GameRules.v[key] = { t: 8, v: value ? 'true' : 'false' };
}

function setByte(level, key, value) {
  level[key] = { t: 1, v: Number(value) ? 1 : 0 };
}

export function register(router) {
  router.get('/api/instances/:instanceId/saves', async (req, res, ctx) => {
    if (!ctx.instance) throw new Error('实例不存在');
    const savesDir = path.join(instanceGameDir(ctx.instance.id), 'saves');
    const altDir = path.join(path.dirname(instanceGameDir(ctx.instance.id)), 'saves');
    let dirs = [];
    for (const base of [savesDir, altDir]) {
      try {
        const found = (await fs.readdir(base, { withFileTypes: true }))
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name);
        dirs.push(...found);
      } catch { /* next */ }
    }
    dirs = [...new Set(dirs)];
    const items = [];
    for (const world of dirs) {
      try {
        const { level } = await readLevel(ctx.instance.id, world);
        items.push(publicWorld(world, level));
      } catch { /* skip invalid */ }
    }
    items.sort((a, b) => b.lastPlayed - a.lastPlayed);
    return { items };
  });

  router.patch('/api/instances/:instanceId/saves/:world', async (req, res, ctx) => {
    if (!ctx.instance) throw new Error('实例不存在');
    const body = await ctx.body();
    const { file, root, level } = await readLevel(ctx.instance.id, ctx.params.world);
    if ('name' in body) {
      const name = String(body.name || '').trim().slice(0, 80);
      if (name) setString(level, 'LevelName', name);
    }
    if ('gameType' in body) {
      const v = Math.max(0, Math.min(3, Number(body.gameType) || 0));
      setByte(level, 'GameType', v);
      // 旁观者/创造通常需要允许作弊；保留原值不强制。
    }
    if ('difficulty' in body) {
      const v = Math.max(0, Math.min(3, Number(body.difficulty) || 0));
      setByte(level, 'Difficulty', v);
      setByte(level, 'DifficultyLocked', 0);
    }
    if ('hardcore' in body) setByte(level, 'hardcore', body.hardcore);
    if ('allowCommands' in body) setByte(level, 'allowCommands', body.allowCommands);
    if ('seed' in body && /^-?\d+$/.test(String(body.seed || '').trim())) {
      setLong(level, 'RandomSeed', body.seed);
      if (level.WorldGenSettings?.v) setLong(level.WorldGenSettings.v, 'seed', body.seed);
    }
    const wg = level.WorldGenSettings?.v;
    if ('generateFeatures' in body) {
      if (wg) setByte(wg, 'generate_features', body.generateFeatures);
      else setByte(level, 'generateFeatures', body.generateFeatures);
    }
    if ('bonusChest' in body) {
      if (wg) setByte(wg, 'bonus_chest', body.bonusChest);
      else setByte(level, 'bonusChest', body.bonusChest);
    }
    if ('spawnRadius' in body) setInt(level, 'spawnRadius', Math.max(0, Math.min(128, Number(body.spawnRadius) || 0)));
    if (body.gameRules && typeof body.gameRules === 'object') {
      for (const key of ['keepInventory', 'doMobSpawning', 'doDaylightCycle', 'doWeatherCycle', 'mobGriefing', 'naturalRegeneration', 'doImmediateRespawn', 'doFireTick']) {
        if (key in body.gameRules) setRule(level, key, body.gameRules[key]);
      }
      if ('randomTickSpeed' in body.gameRules) {
        if (!level.GameRules) level.GameRules = { t: 10, v: {} };
        level.GameRules.v.randomTickSpeed = { t: 8, v: String(Math.max(0, Math.min(4096, Number(body.gameRules.randomTickSpeed) || 3))) };
      }
    }
    const packed = await gzip(encodeNbt(root), { level: 6 });
    await fs.writeFile(file, packed);
    return { ok: true, world: publicWorld(ctx.params.world, level) };
  });
}
