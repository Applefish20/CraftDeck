/**
 * 反馈：把用户填写的内容发送到作者邮箱（FormSubmit 转发）。
 * 首次使用时 FormSubmit 会向作者邮箱发送一封激活邮件，激活后即可正常收信。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, LOGS_DIR } from '../core/paths.mjs';
import { ensureDir, uid } from '../core/util.mjs';

const EMAIL = 'pakagchong@qq.com';
const CATEGORIES = ['使用问题', '启动/崩溃', '下载/安装', '联机/开服', '皮肤/账户', '功能建议', '其他'];

async function tailLauncherLog(lines = 160) {
  try {
    const text = await fsp.readFile(path.join(LOGS_DIR, 'launcher.log'), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch { return ''; }
}

export function register(router) {
  router.get('/api/feedback/info', () => ({ masked: true, categories: CATEGORIES, provider: 'FormSubmit' }));

  router.post('/api/feedback', async (req, res, ctx) => {
    const b = await ctx.body();
    const message = String(b.message || '').trim();
    if (message.length < 5) throw new Error('请至少写 5 个字，方便定位问题');
    if (message.length > 8000) throw new Error('反馈内容太长，请精简到 8000 字以内');
    const category = CATEGORIES.includes(b.category) ? b.category : '其他';
    const contact = String(b.contact || '').trim().slice(0, 120);
    const withLogs = !!b.withLogs;
    const logs = withLogs ? await tailLauncherLog() : '';
    const id = uid('fb_');
    const body = [
      `反馈类型：${category}`,
      `联系方式：${contact || '未填写'}`,
      `启动器版本：${b.version || '2.7.1'}`,
      `系统：${os.type()} ${os.release()} ${process.arch}`,
      '',
      '反馈内容：',
      message,
      '',
      withLogs ? '---- 最近启动器日志 ----\n' + (logs || '（无日志）') : '（用户未附日志）',
    ].join('\n');
    const record = { id, at: new Date().toISOString(), category, contact, message, withLogs, logs: withLogs ? logs.slice(-20000) : '' };
    await ensureDir(LOGS_DIR);
    await fsp.writeFile(path.join(LOGS_DIR, `${id}.json`), JSON.stringify(record, null, 2), 'utf8').catch(() => {});
    let sent = false;
    let activation = false;
    let error = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(EMAIL)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: `[CraftDeck 反馈] ${category}`,
          _template: 'table',
          _captcha: 'false',
          name: contact || 'CraftDeck 用户',
          email: contact || EMAIL,
          message: body,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = await r.json().catch(() => ({}));
      sent = r.ok && String(data.success) !== 'false';
      if (!sent) error = data.message || `HTTP ${r.status}`;
    } catch (e) {
      error = e.message;
    }
    if (!sent) activation = true;
    const subject = encodeURIComponent(`[CraftDeck 反馈] ${category}`);
    const mailto = `mailto:${EMAIL}?subject=${subject}&body=${encodeURIComponent(body)}`;
    return { ok: sent, activation, error, id, mailto, email: EMAIL };
  });
}
