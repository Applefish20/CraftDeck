/**
 * CraftDeck — multiplayer servers: Server List Ping (1.7+ and legacy) + LAN discovery
 * + the saved-server CRUD API.
 *
 * Zero third-party dependencies. All user-facing messages are Chinese.
 */
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { store } from '../core/store.mjs';
import { bus } from '../core/events.mjs';

/** Protocol number put in the handshake. Any status-capable server answers regardless. */
const HANDSHAKE_PROTOCOL = 764;
const DEFAULT_PORT = 25565;
const HARD_TIMEOUT_MS = 5000;
const LAN_GROUP = '224.0.2.60';
const LAN_PORT = 4445;
const MAX_PACKET_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return HARD_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 250), HARD_TIMEOUT_MS);
}

/** Unref'd timer that keeps the event loop free while racing DNS etc. */
function raceTimeout(ms, message = '连接超时') {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
    if (typeof t.unref === 'function') t.unref();
  });
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, raceTimeout(ms, message)]);
}

function stripFormatting(text) {
  return String(text).replace(/§[0-9a-fk-orA-FK-OR]/g, '');
}

/** Flatten a Minecraft chat component (or legacy §-string) to plain text. */
function flattenMotd(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return stripFormatting(value).trim();
  const parts = [];
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > 12) return;
    if (typeof node === 'string') { parts.push(node); return; }
    if (Array.isArray(node)) { for (const c of node) walk(c, depth + 1); return; }
    if (typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    if (typeof node.translate === 'string' && !node.text) parts.push(node.translate);
    if (node.extra) walk(node.extra, depth + 1);
  };
  walk(value, 0);
  return stripFormatting(parts.join('')).trim();
}

function motdRaw(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

/** Chat components turned into a simple §-coloured string for UIs that want colours. */
function motdColored(value, depth = 0) {
  if (value === null || value === undefined || depth > 12) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((c) => motdColored(c, depth + 1)).join('');
  if (typeof value !== 'object') return '';
  let out = '';
  if (value.color) out += `§${colorCode(value.color)}`;
  if (value.bold) out += '§l';
  if (value.italic) out += '§o';
  if (value.underlined) out += '§n';
  if (value.strikethrough) out += '§m';
  if (value.obfuscated) out += '§k';
  if (value.text) out += String(value.text);
  if (value.extra) out += motdColored(value.extra, depth + 1);
  return out;
}

function colorCode(color) {
  const map = {
    black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5',
    gold: '6', gray: '7', dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c',
    light_purple: 'd', yellow: 'e', white: 'f',
  };
  if (/^#[0-9a-f]{6}$/i.test(String(color))) return 'f';
  return map[String(color)] || 'f';
}

function normalizeIcon(favicon) {
  if (typeof favicon !== 'string' || !favicon) return null;
  if (favicon.startsWith('data:image/')) return favicon;
  if (/^[A-Za-z0-9+/=\s]+$/.test(favicon) && favicon.length > 64) {
    return 'data:image/png;base64,' + favicon.replace(/\s+/g, '');
  }
  return null;
}

// ---------------------------------------------------------------------------
// packet helpers (VarInt framing)
// ---------------------------------------------------------------------------

function writeVarInt(value) {
  let v = Number(value) >>> 0;
  const bytes = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

function writeString(str) {
  const body = Buffer.from(String(str), 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

function frame(payload) {
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

function readVarIntAt(buf, offset) {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) return null;
    const b = buf[offset + size];
    value |= (b & 0x7f) << (7 * size);
    size++;
    if (!(b & 0x80)) break;
    if (size >= 5) throw new Error('VarInt 数据无效');
  }
  return { value: value >>> 0, size };
}

function readStringAt(buf, offset) {
  const head = readVarIntAt(buf, offset);
  if (!head) throw new Error('数据包不完整');
  const start = offset + head.size;
  const end = start + head.value;
  if (end > buf.length) throw new Error('数据包不完整');
  return { value: buf.toString('utf8', start, end), size: head.size + head.value };
}

/** Incremental reader over a TCP socket. One consumer at a time. */
class PacketReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.ended = false;
    this.error = null;
    this._onData = (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this._wake(); };
    this._onEnd = () => { this.ended = true; this._wake(); };
    this._onError = (e) => { this.error = e; this._wake(); };
    socket.on('data', this._onData);
    socket.on('end', this._onEnd);
    socket.on('close', this._onEnd);
    socket.on('error', this._onError);
  }

  _wake() {
    const w = this.waiter;
    if (w) { this.waiter = null; w(); }
  }

  _wait() {
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  async need(n) {
    if (n > MAX_PACKET_BYTES) throw new Error('响应数据过大');
    while (this.buf.length < n) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error('服务器提前关闭了连接');
      await this._wait();
    }
  }

  async readVarInt() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      await this.need(i + 1);
      const b = this.buf[i];
      value |= (b & 0x7f) << (7 * i);
      if (!(b & 0x80)) {
        this.buf = this.buf.subarray(i + 1);
        return value >>> 0;
      }
    }
    throw new Error('VarInt 数据无效');
  }

  async readBytes(n) {
    await this.need(n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readString() {
    const len = await this.readVarInt();
    if (len > MAX_PACKET_BYTES) throw new Error('字符串过长');
    return (await this.readBytes(len)).toString('utf8');
  }

  destroy() {
    this.socket.off('data', this._onData);
    this.socket.off('end', this._onEnd);
    this.socket.off('close', this._onEnd);
    this.socket.off('error', this._onError);
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

function waitConnect(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try { socket.destroy(); } catch { /* ignore */ }
      reject(new Error('连接超时'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (e) => { cleanup(); try { socket.destroy(); } catch { /* ignore */ } reject(e); };
    const onClose = () => { cleanup(); reject(new Error('连接已关闭')); };
    function cleanup() {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
    socket.once('connect', onConnect);
    socket.on('error', onError);
    socket.once('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// address parsing
// ---------------------------------------------------------------------------

/**
 * Accepts `host`, `host:port`, `minecraft://host:port`, `[::1]:port`, `host:port/path`.
 * `port` is only used when the address itself has no port.
 */
export function parseAddress(address, port = DEFAULT_PORT) {
  let raw = String(address ?? '').trim();
  if (!raw) return { error: '服务器地址不能为空' };
  raw = raw.replace(/^minecraft:\/\//i, '').replace(/^https?:\/\//i, '');
  raw = raw.replace(/^\/+/, '');
  const slash = raw.search(/[/?]/);
  if (slash >= 0) raw = raw.slice(0, slash);
  if (!raw) return { error: '服务器地址不能为空' };

  let host = raw;
  let explicitPort = null;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return { error: '服务器地址格式无效' };
    host = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest.startsWith(':')) explicitPort = parseInt(rest.slice(1), 10);
  } else {
    const first = raw.indexOf(':');
    if (first >= 0 && first === raw.lastIndexOf(':')) {
      const p = parseInt(raw.slice(first + 1), 10);
      if (Number.isFinite(p)) { host = raw.slice(0, first); explicitPort = p; }
    }
  }
  host = host.trim();
  if (!host) return { error: '服务器地址不能为空' };
  if (!net.isIP(host) && !/^[A-Za-z0-9._-]+$/.test(host)) {
    return { error: `服务器地址包含无效字符: ${host}` };
  }

  let finalPort = explicitPort !== null ? explicitPort : Number(port);
  if (!Number.isFinite(finalPort) || finalPort <= 0) finalPort = DEFAULT_PORT;
  if (finalPort < 1 || finalPort > 65535) return { error: '端口需在 1-65535 之间' };

  return { host, port: finalPort, explicitPort: explicitPort !== null };
}

async function resolveSrvSafe(host) {
  if (net.isIP(host)) return null;
  try {
    const records = await withTimeout(
      dns.promises.resolveSrv(`_minecraft._tcp.${host}`),
      900,
      'SRV 查询超时',
    );
    if (!Array.isArray(records) || !records.length) return null;
    const best = records.slice().sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight))[0];
    const name = String(best.name || '').replace(/\.$/, '');
    const port = Number(best.port);
    if (!name || !Number.isFinite(port) || port <= 0) return null;
    return { host: name, port };
  } catch {
    return null;
  }
}

/** SRV lookups are slow on hosts whose resolver refuses SRV queries; cache hits and misses. */
const srvCache = new Map(); // host -> { at, value }
const SRV_TTL_MS = 5 * 60_000;

async function resolveSrvCached(host) {
  const hit = srvCache.get(host);
  if (hit && Date.now() - hit.at < SRV_TTL_MS) return hit.value;
  const value = await resolveSrvSafe(host);
  if (srvCache.size > 200) srvCache.clear();
  srvCache.set(host, { at: Date.now(), value });
  return value;
}

function friendlyError(e) {
  const code = e && e.code ? String(e.code) : '';
  const msg = (e && e.message) || String(e);
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return '连接被拒绝（服务器未开启或端口错误）';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return '无法解析服务器地址（域名不存在或网络不可用）';
  if (code === 'ETIMEDOUT' || /超时|timeout/i.test(msg)) return '连接超时（服务器无响应）';
  if (code === 'ECONNRESET' || /ECONNRESET|reset/i.test(msg)) return '连接被服务器重置';
  if (/ENETUNREACH|EHOSTUNREACH/.test(code + msg)) return '网络不可达';
  return `连接失败: ${msg}`;
}

function shouldTryLegacy(e) {
  const msg = String((e && e.message) || e || '');
  return /响应包|VarInt|提前关闭|数据包|JSON|字符串|协议|parse|Unexpected/i.test(msg);
}

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

function normalizeStatus(json, extra) {
  const version = json && json.version ? json.version : {};
  const players = json && json.players ? json.players : {};
  const description = json && (json.description !== undefined ? json.description : json.motd);
  const sample = Array.isArray(players.sample) ? players.sample.slice(0, 200) : [];
  const status = {
    version: {
      name: String(version.name || (extra && extra.fallbackVersion) || '未知'),
      protocol: Number(version.protocol) || 0,
    },
    players: {
      online: Number(players.online) || 0,
      max: Number(players.max) || 0,
      sample: sample.map((p) => ({ name: String((p && p.name) || ''), id: String((p && p.id) || '') })),
    },
    motd: flattenMotd(description),
    motdColored: motdColored(description),
    motdRaw: motdRaw(description),
    icon: normalizeIcon(json && json.favicon),
    software: (json && json.modinfo && json.modinfo.type) || null,
  };
  return status;
}

async function pingModern(host, port, timeoutMs) {
  const socket = net.connect({ host, port });
  socket.setNoDelay(true);
  const reader = new PacketReader(socket);
  const startedAt = Date.now();
  try {
    await waitConnect(socket, timeoutMs);
    const handshake = Buffer.concat([
      writeVarInt(0x00),
      writeVarInt(HANDSHAKE_PROTOCOL),
      writeString(host),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port, 0); return b; })(),
      writeVarInt(0x01), // next state: status
    ]);
    socket.write(frame(handshake));
    socket.write(frame(Buffer.from([0x00]))); // status request

    const remaining = () => Math.max(400, timeoutMs - (Date.now() - startedAt));
    const len = await withTimeout(reader.readVarInt(), remaining(), '读取状态响应超时');
    if (len <= 0 || len > MAX_PACKET_BYTES) throw new Error('响应数据包长度无效');
    const payload = await withTimeout(reader.readBytes(len), remaining(), '读取状态响应超时');
    const pid = readVarIntAt(payload, 0);
    if (!pid || pid.value !== 0x00) throw new Error('服务器返回了未知的响应包');
    const jsonText = readStringAt(payload, pid.size).value;
    let json;
    try {
      json = JSON.parse(jsonText);
    } catch {
      throw new Error('服务器返回的状态数据不是有效 JSON');
    }

    const status = normalizeStatus(json);
    let latencyMs = Date.now() - startedAt;

    // Optional ping/pong gives a more accurate RTT and lets the server log us properly.
    try {
      const stamp = BigInt(Date.now());
      const pongPayload = Buffer.alloc(9);
      pongPayload.writeUInt8(0x01, 0);
      pongPayload.writeBigInt64BE(stamp, 1);
      const sentAt = Date.now();
      socket.write(frame(pongPayload));
      const pongLen = await withTimeout(reader.readVarInt(), Math.min(1200, remaining()), '等待 pong 超时');
      if (pongLen >= 9) {
        await withTimeout(reader.readBytes(pongLen), Math.min(1200, remaining()), '等待 pong 超时');
        latencyMs = Math.max(1, Date.now() - sentAt);
      }
    } catch { /* latency already measured by the status round-trip */ }

    return { ...status, latencyMs, protocolVersion: status.version.protocol };
  } finally {
    reader.destroy();
  }
}

async function pingLegacy(host, port, timeoutMs) {
  const socket = net.connect({ host, port });
  const startedAt = Date.now();
  try {
    await waitConnect(socket, timeoutMs);
    socket.write(Buffer.from([0xfe, 0x01]));
    const raw = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (buf.length) resolve(buf);
        else reject(new Error('连接超时'));
      }, Math.min(timeoutMs, 2000));
      if (typeof timer.unref === 'function') timer.unref();
      const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 3) return;
        const len = buf.readUInt16BE(1);
        if (buf.length >= 3 + len * 2) { cleanup(); resolve(buf); }
      };
      const onError = (e) => { cleanup(); reject(e); };
      const onClose = () => { if (buf.length) { cleanup(); resolve(buf); } else { cleanup(); reject(new Error('连接已关闭')); } };
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    });

    if (raw[0] !== 0xff) throw new Error('传统协议响应无效');
    const len = raw.readUInt16BE(1);
    const text = raw.subarray(3, 3 + len * 2).toString('utf16le');
    const parts = text.split('\u0000');
    if (parts[0] && parts[0].startsWith('§')) parts.shift();
    const [protocol, versionName, motd, online, max] = parts;
    const status = normalizeStatus({
      version: { name: versionName || '未知', protocol: Number(protocol) || 0 },
      players: { online: Number(online) || 0, max: Number(max) || 0, sample: [] },
      description: motd || '',
    });
    return { ...status, latencyMs: Math.max(1, Date.now() - startedAt), legacy: true };
  } finally {
    try { socket.destroy(); } catch { /* ignore */ }
  }
}

/**
 * Ping a Minecraft server.
 *
 * @param {string} address host, host:port or minecraft://host:port
 * @param {number} [port=25565]
 * @param {number} [timeoutMs=5000] clamped to a hard 5s ceiling
 * @returns {Promise<object>} {online:true, version, players, motd, icon, latencyMs, address, port}
 *                            or {online:false, error, latencyMs, address, port}
 */
export async function ping(address, port = DEFAULT_PORT, timeoutMs = HARD_TIMEOUT_MS) {
  const startedAt = Date.now();
  const budget = clampTimeout(timeoutMs);
  const target = parseAddress(address, port);
  if (target.error) {
    return { online: false, error: target.error, latencyMs: Date.now() - startedAt, address: String(address ?? ''), port: DEFAULT_PORT };
  }

  let host = target.host;
  let finalPort = target.port;
  let srv = null;
  if (!target.explicitPort && Number(port) === DEFAULT_PORT) {
    srv = await resolveSrvCached(target.host);
    if (srv) { host = srv.host; finalPort = srv.port; }
  }

  const base = () => ({
    address: host,
    port: finalPort,
    srv: srv ? { host: srv.host, port: srv.port } : null,
  });
  const remaining = () => Math.max(400, budget - (Date.now() - startedAt));

  const attempt = async () => {
    try {
      const res = await pingModern(host, finalPort, remaining());
      return { online: true, ...res, ...base(), at: Date.now() };
    } catch (modernErr) {
      if (shouldTryLegacy(modernErr) && remaining() > 500) {
        try {
          const legacy = await pingLegacy(host, finalPort, Math.min(2500, remaining()));
          return { online: true, ...legacy, ...base(), at: Date.now() };
        } catch { /* fall through to the modern error */ }
      }
      return {
        online: false,
        error: friendlyError(modernErr),
        detail: String((modernErr && modernErr.message) || modernErr),
        latencyMs: Date.now() - startedAt,
        ...base(),
        at: Date.now(),
      };
    }
  };

  // Absolute safety net: nothing below may hold the caller longer than the budget.
  try {
    return await withTimeout(attempt(), budget + 500, '连接超时');
  } catch (e) {
    return {
      online: false,
      error: friendlyError(e),
      detail: String((e && e.message) || e),
      latencyMs: Date.now() - startedAt,
      ...base(),
      at: Date.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// LAN discovery
// ---------------------------------------------------------------------------

function parseLanPayload(text) {
  const motd = /\[MOTD\]([\s\S]*?)\[\/MOTD\]/i.exec(text);
  const ad = /\[AD\]([\s\S]*?)\[\/AD\]/i.exec(text);
  if (!motd && !ad) return null;
  const port = parseInt((ad && ad[1]) || '', 10) || DEFAULT_PORT;
  return { motd: stripFormatting((motd && motd[1]) || '').trim(), port };
}

/**
 * Broadcast the 1.6-era LAN probe to 224.0.2.60:4445 and collect replies for
 * `timeoutMs` (default 3s here, hard ceiling 5s). Never rejects.
 *
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<Array<{motd:string, port:number, address:string, name:string}>>}
 */
export async function scanLan(timeoutMs = 3000) {
  const window = Math.min(Math.max(Number(timeoutMs) || 3000, 300), HARD_TIMEOUT_MS);
  return new Promise((resolve) => {
    const worlds = new Map();
    let socket = null;
    let timer = null;
    let interval = null;
    let done = false;
    let bound = false;
    let retried = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      try { socket && socket.close(); } catch { /* ignore */ }
      resolve([...worlds.values()].sort((a, b) => a.port - b.port));
    };

    const probe = Buffer.from('[MOTD]CraftDeck[/MOTD][AD]25565[/AD]', 'utf8');
    const send = () => {
      if (!socket || done) return;
      try {
        socket.send(probe, 0, probe.length, LAN_PORT, LAN_GROUP, () => { /* ignore send errors */ });
      } catch { /* ignore */ }
    };

    const onMessage = (msg, rinfo) => {
      try {
        // Ignore our own probe reflected by the multicast/broadcast loopback.
        if (msg.length === probe.length && msg.equals(probe)) return;
        const parsed = parseLanPayload(msg.toString('utf8'));
        if (!parsed) return;
        const key = `${rinfo.address}:${parsed.port}`;
        if (worlds.has(key)) return;
        worlds.set(key, {
          motd: parsed.motd,
          name: parsed.motd || `${rinfo.address}:${parsed.port}`,
          port: parsed.port,
          address: rinfo.address,
          lastSeen: Date.now(),
        });
      } catch { /* ignore malformed datagrams */ }
    };

    const onBound = () => {
      bound = true;
      try { socket.setBroadcast(true); } catch { /* ignore */ }
      try { socket.addMembership(LAN_GROUP); } catch { /* multicast may be unavailable */ }
      send();
      interval = setInterval(send, 700);
      if (typeof interval.unref === 'function') interval.unref();
    };

    const bind = (port) => {
      try {
        socket.bind(port, onBound);
      } catch {
        finish();
      }
    };

    const onError = (e) => {
      const code = e && e.code;
      if (!bound && !retried && (code === 'EADDRINUSE' || code === 'EACCES')) {
        // Another launcher/game owns 4445 without SO_REUSEADDR: retry on a random port.
        retried = true;
        try { socket.close(); } catch { /* ignore */ }
        try {
          socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          socket.on('message', onMessage);
          socket.on('error', onError);
          bind(0);
          return;
        } catch {
          finish();
          return;
        }
      }
      if (!bound) finish(); // could not listen at all
      // Otherwise ignore transient send/membership errors and keep collecting.
    };

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    socket.on('message', onMessage);
    socket.on('error', onError);
    // The vanilla client listens on 4445; reuseAddr lets us share the port with a running game.
    bind(LAN_PORT);

    timer = setTimeout(finish, window);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

function findServer(id) {
  const entry = store.servers.find((s) => s.id === id);
  if (!entry) throw Object.assign(new Error('服务器不存在或已被删除'), { status: 404 });
  return entry;
}

function cleanName(value, fallback) {
  const name = String(value ?? '').trim();
  return (name || fallback).slice(0, 80);
}

export function register(router, ctx = {}) {
  // Literal routes must be registered before parameterised ones.
  router.get('/api/servers', () => store.servers);

  router.get('/api/servers/ping', async (req, res, c) => {
    const address = String(c.query.address || '').trim();
    if (!address) throw Object.assign(new Error('缺少服务器地址（address）'), { status: 400 });
    const port = Number(c.query.port) || undefined;
    const timeout = Number(c.query.timeout) || HARD_TIMEOUT_MS;
    return ping(address, port, timeout);
  });

  router.get('/api/servers/lan', async (req, res, c) => {
    const timeout = Number(c.query.timeout) || 3000;
    const worlds = await scanLan(timeout);
    return { worlds };
  });

  router.post('/api/servers', async (req, res, c) => {
    const body = await c.body();
    const target = parseAddress(body.address, body.port);
    if (target.error) throw Object.assign(new Error(target.error), { status: 400 });
    const entry = store.addServer({
      name: cleanName(body.name, `${target.host}:${target.port}`),
      address: target.host,
      port: target.port,
      notes: String(body.notes ?? body.note ?? '').slice(0, 200),
      lastStatus: null,
    });
    bus.emitEvent({ type: 'servers', action: 'added', serverId: entry.id });
    return entry;
  });

  router.patch('/api/servers/:id', async (req, res, c) => {
    const entry = findServer(c.params.id);
    const body = await c.body();
    const patch = {};
    if (body.name !== undefined) patch.name = cleanName(body.name, entry.name);
    if (body.address !== undefined || body.port !== undefined) {
      const target = parseAddress(body.address !== undefined ? body.address : entry.address, body.port !== undefined ? body.port : entry.port);
      if (target.error) throw Object.assign(new Error(target.error), { status: 400 });
      patch.address = target.host;
      patch.port = target.port;
    }
    if (body.note !== undefined) patch.note = String(body.note || '').slice(0, 200);
    if (body.notes !== undefined || body.note !== undefined) {
      patch.notes = String(body.notes ?? body.note ?? '').slice(0, 200);
    }
    const updated = store.updateServer(entry.id, patch);
    bus.emitEvent({ type: 'servers', action: 'updated', serverId: entry.id });
    return updated;
  });

  router.delete('/api/servers/:id', async (req, res, c) => {
    const entry = findServer(c.params.id);
    store.removeServer(entry.id);
    bus.emitEvent({ type: 'servers', action: 'removed', serverId: entry.id });
    return { ok: true, id: entry.id };
  });

  router.get('/api/servers/:id/ping', async (req, res, c) => {
    const entry = findServer(c.params.id);
    const result = await ping(entry.address, entry.port, Number(c.query.timeout) || HARD_TIMEOUT_MS);
    const lastStatus = {
      online: !!result.online,
      players: result.players || null,
      version: result.version || null,
      motd: result.motd || '',
      latencyMs: Number(result.latencyMs) || 0,
      at: Date.now(),
    };
    if (!result.online && result.error) lastStatus.error = result.error;
    store.updateServer(entry.id, { lastStatus });
    bus.emitEvent({ type: 'servers', action: 'ping', serverId: entry.id, online: lastStatus.online });
    return { ...result, id: entry.id, name: entry.name, lastStatus };
  });
}

export default { ping, scanLan, parseAddress, register };
