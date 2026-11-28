import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './paths.mjs';
import { bus } from './events.mjs';

export const BUS_LOG_FILE = path.join(LOGS_DIR, 'launcher.log');
let stream = null;

function ensureStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    // rotate when > 5 MB
    try {
      const st = fs.statSync(BUS_LOG_FILE);
      if (st.size > 5 * 1024 * 1024) fs.renameSync(BUS_LOG_FILE, BUS_LOG_FILE + '.1');
    } catch { /* ignore */ }
    stream = fs.createWriteStream(BUS_LOG_FILE, { flags: 'a' });
  } catch { /* ignore */ }
  return stream;
}

function line(level, message) {
  const ts = new Date().toISOString();
  const text = `[${ts}] [${level}] ${message}`;
  try { ensureStream()?.write(text + '\n'); } catch { /* ignore */ }
  return text;
}

export const log = {
  info: (m) => { line('INFO', m); bus.log('info', m); },
  warn: (m) => { line('WARN', m); bus.log('warn', m); },
  error: (m) => { line('ERROR', m); bus.log('error', m); },
  debug: (m) => { line('DEBUG', m); },
};

// Mirror every bus log event into the file as well.
bus.on('event', (e) => {
  if (e.type === 'log') { try { ensureStream()?.write(`[${new Date(e.ts).toISOString()}] [${String(e.level || 'INFO').toUpperCase()}] ${e.message}\n`); } catch { /* ignore */ } }
});

export function closeLog() {
  try { stream?.end(); } catch { /* ignore */ }
  stream = null;
}
