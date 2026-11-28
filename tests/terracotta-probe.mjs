import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('.terracotta-test');
const exe = path.join(dir, 'terracotta-0.4.2-windows-x86_64.exe');
const portFile = path.join(dir, 'port.json');
try { fs.unlinkSync(portFile); } catch {}
const child = spawn(exe, ['--hmcl', portFile], { cwd: dir, stdio: 'ignore', windowsHide: true, detached: false });
child.on('error', (e) => console.log('spawn error', e.message));
console.log('spawned pid', child.pid);
let port = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try { port = JSON.parse(fs.readFileSync(portFile, 'utf8')).port; } catch {}
  if (port) break;
}
console.log('port', port);
if (port) {
  for (const p of ['/meta', '/state']) {
    try { const r = await fetch(`http://127.0.0.1:${port}${p}`); console.log(p, r.status, (await r.text()).slice(0, 300)); } catch (e) { console.log(p, 'ERR', e.message); }
  }
  try { await fetch(`http://127.0.0.1:${port}/panic?peaceful=true`); console.log('panic ok'); } catch (e) { console.log('panic ERR', e.message); }
}
setTimeout(() => process.exit(0), 1500);
