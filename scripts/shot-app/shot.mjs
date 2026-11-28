import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:25567/#/settings';
const out = process.argv.find((a) => a.endsWith('.png')) || path.resolve('shot.png');
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 950, show: false,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true },
  });
  win.webContents.setFrameRate(10);
  await win.loadURL(url).catch(() => {});
  await new Promise((r) => setTimeout(r, 4500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('captured', out, img.getSize());
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
