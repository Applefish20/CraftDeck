/* ================= 百宝箱（独立页面） ================= */
import { h, sectionTitle } from '../ui.js';
import { toolboxCard, setToolboxRefresh, ensureToolboxData } from './settings.js';

export default {
  async render(el, ctx) {
    el.innerHTML = '';
    setToolboxRefresh(() => ctx.refresh());
    await ensureToolboxData();
    el.append(h('div', { class: 'home' }, [
      h('div', { class: 'panel', style: { padding: '14px' } }, [
        h('div', { class: 'panel-title' }, '百宝箱'),
        h('div', { class: 'hint' }, '内存优化、缓存清理、文件校验、网络诊断、端口检测、自定义下载与诊断导出。'),
      ]),
      toolboxCard(),
    ]));
  },
  destroy() { setToolboxRefresh(null); },
};
