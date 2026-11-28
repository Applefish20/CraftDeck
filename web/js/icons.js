/**
 * CraftDeck 图标系统
 * 统一的 24×24 线性图标；所有图标使用 currentColor，不重复使用图形。
 */
const PATHS = {
  play: '<path d="M9.4 7.1c0-.85.94-1.36 1.66-.9l6.5 4.4c.65.44.65 1.4 0 1.84l-6.5 4.4c-.72.46-1.66-.05-1.66-.9V7.1Z"/><path d="M5.5 5.8v12.4"/>',
  download: '<path d="M12 4v10.2"/><path d="m7.8 10.5 4.2 4.2 4.2-4.2"/><path d="M5 19.2h14"/>',
  migrate: '<path d="M4.5 8.5h11.8"/><path d="m13.2 5.3 3.2 3.2-3.2 3.2"/><path d="M19.5 15.5H7.7"/><path d="m10.8 18.7-3.2-3.2 3.2-3.2"/>',
  servers: '<rect x="4" y="4.5" width="16" height="4.6" rx="1.5"/><rect x="4" y="14.9" width="16" height="4.6" rx="1.5"/><path d="M7.2 6.8h.1M7.2 17.2h.1M12 6.8h4.7M12 17.2h4.7"/>',
  terracotta: '<path d="m8.2 4.9 3.8 3.8-3.8 3.8-3.8-3.8 3.8-3.8Z"/><path d="m15.8 11.5 3.8 3.8-3.8 3.8-3.8-3.8 3.8-3.8Z"/><path d="m12 8.7 2.7-2.7"/>',
  hosts: '<rect x="5" y="3.8" width="14" height="9" rx="1.8"/><path d="M8 7h.1M8 9.8h.1M11.5 7h4.7M11.5 9.8h3"/><path d="M9 15.5v4.7M15 15.5v4.7M6.5 20.2h11"/><path d="M12 15.5v-2.7"/>',
  account: '<circle cx="12" cy="8.6" r="3.4"/><path d="M5.2 20c.5-3.5 3.2-5.8 6.8-5.8s6.3 2.3 6.8 5.8"/><path d="M17.7 5.7h3.1M19.25 4.15v3.1"/>',
  skin: '<path d="M8.1 4.2h7.8l1.3 4.5-2.2.7v9.4H9v-9.4l-2.2-.7 1.3-4.5Z"/><path d="M9.5 4.2c.15 1.7 1.1 2.7 2.5 2.7s2.35-1 2.5-2.7"/>',
  logs: '<path d="M6.2 3.8h8.3l3.3 3.3v13.1H6.2V3.8Z"/><path d="M14.5 3.8v3.5h3.3"/><path d="M9 10.4h6M9 13.1h4.8M9 15.8h3.2"/><path d="m13.9 18 1.2-1.2-1.2-1.2"/>',
  toolbox: '<path d="M4.2 9.3h15.6v8.4a1.8 1.8 0 0 1-1.8 1.8H6a1.8 1.8 0 0 1-1.8-1.8V9.3Z"/><path d="M8.4 9.3V6.7c0-.9.7-1.6 1.6-1.6h4c.9 0 1.6.7 1.6 1.6v2.6"/><path d="M4.2 13.6h15.6"/><path d="M10.3 13.6h3.4v2.3h-3.4z"/>',
  settings: '<path d="M4 7h7M15 7h5M4 17h5M13 17h7"/><circle cx="13" cy="7" r="2.1"/><circle cx="11" cy="17" r="2.1"/>',
  back: '<path d="m10 5-7 7 7 7"/><path d="M3.5 12H21"/>',
  console: '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><path d="m7 9 2.5 2.4L7 13.8M12.2 14h4.6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m7 9.5 5 5 5-5"/>',
  more: '<circle cx="5.5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18.5" cy="12" r="1"/>',
  search: '<circle cx="10.8" cy="10.8" r="5.8"/><path d="m15.2 15.2 4.6 4.6"/>',
  refresh: '<path d="M19.3 8.2A8 8 0 1 0 20 14"/><path d="M20 4.2v4.6h-4.6"/>',
  undo: '<path d="M4.7 8.2 9.2 3.7l4.5 4.5"/><path d="M9.2 3.7v9.1a6.4 6.4 0 0 0 6.4 6.4h3.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  alert: '<path d="m12 3.8 8.4 15.4H3.6L12 3.8Z"/><path d="M12 9v4.3M12 16.6h.1"/>',
  check: '<path d="m5 12.2 4.4 4.4L19 6.8"/>',
  map: '<path d="m3.8 6.2 5-2.2 6.4 2.2 5-2.2v14l-5 2.2-6.4-2.2-5 2.2v-14Z"/><path d="M8.8 4v14M15.2 6.2v14"/>',
  blueprint: '<path d="M4 5.5h16v13H4z"/><path d="M4 9.2h16M8 9.2v9.3M16 9.2v9.3"/><path d="M11.2 5.5v3.7M14.2 12.2h3.6"/>',
  globe: '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.4 2.3 3.6 5 3.6 8.2s-1.2 5.9-3.6 8.2c-2.4-2.3-3.6-5-3.6-8.2s1.2-5.9 3.6-8.2Z"/>',
  package: '<path d="m12 3.2 8 4.2v9.2l-8 4.2-8-4.2V7.4l8-4.2Z"/><path d="m4.3 7.6 7.7 4 7.7-4M12 11.6v9.2"/><path d="m8.2 5.6 7.7 4"/>',
  puzzle: '<path d="M9 4.5c0-1.2 1-2 2.2-2s2.2.8 2.2 2V6h2.4c1 0 1.7.7 1.7 1.7v2.4h1.4c1.2 0 2 1 2 2.2s-.8 2.2-2 2.2h-1.4v2.8c0 1-.7 1.7-1.7 1.7h-2.8v1.2c0 1.2-.8 2-2 2s-2.2-.8-2.2-2V19H6.2c-1 0-1.7-.7-1.7-1.7v-3H3.2c-1.2 0-2-1-2-2.2s.8-2.2 2-2.2h1.3V9.5c0-1 .7-1.7 1.7-1.7H9V4.5Z"/>',
  palette: '<path d="M12 3.8a8.2 8.2 0 1 0 0 16.4c1.4 0 2.1-.8 2.1-1.8 0-.7-.3-1.2-.7-1.7-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.9-1.8h1.4c2 0 3.6-1.6 3.6-3.6 0-3.4-3.5-6.2-7.8-6.2Z"/><circle cx="7.3" cy="10" r=".9"/><circle cx="9.5" cy="6.8" r=".9"/><circle cx="13.3" cy="6.3" r=".9"/><circle cx="16.4" cy="8.8" r=".9"/>',
  landscape: '<rect x="3.5" y="5.2" width="17" height="13.6" rx="2"/><path d="m4.8 16.4 4.4-5 3.2 3.7 2.2-2.5 4.6 3.8"/><circle cx="8.2" cy="9.2" r="1.4"/>',
  translate: '<path d="M4 5.2h8.3M8.15 3.3v1.9"/><path d="M5.3 5.2c.6 4.2 2.9 6.8 6.5 8.1"/><path d="M10.7 5.2c-.5 4.2-2.5 7.1-6.1 8.7"/><path d="M13.2 20.5h7.3l-3.65-9.2-3.65 9.2Z"/><path d="M14.6 17.1h4.5"/>',
  folder: '<path d="M3.8 7.2h6l1.8 2h8.6v9.1H3.8V7.2Z"/><path d="M3.8 7.2V5.3h6.5l1.4 1.9"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="m19.5 4.5-7.4 7.4"/><path d="M19.5 14.2v4.1a1.7 1.7 0 0 1-1.7 1.7H5.7A1.7 1.7 0 0 1 4 18.3V6.7A1.7 1.7 0 0 1 5.7 5h4.1"/>',
  shield: '<path d="m12 3.4 7.2 2.7v5.6c0 4.4-2.8 7.4-7.2 8.9-4.4-1.5-7.2-4.5-7.2-8.9V6.1L12 3.4Z"/><path d="m8.8 12 2.1 2.1 4.4-4.5"/>',
  code: '<path d="m8.4 7.2-4.6 4.8 4.6 4.8M15.6 7.2l4.6 4.8-4.6 4.8M13.5 4.8l-3 14.4"/>',
  book: '<path d="M4 5.4c2.7-1.1 5.4-1.1 8 0v14c-2.6-1.1-5.3-1.1-8 0v-14Z"/><path d="M12 5.4c2.6-1.1 5.3-1.1 8 0v14c-2.7-1.1-5.4-1.1-8 0"/><path d="M7 8.2h2.5M7 11.2h2.5M14.5 8.2H17M14.5 11.2H17"/>',
  mail: '<rect x="3.5" y="5.2" width="17" height="13.6" rx="2"/><path d="m4.5 7 7.5 5.4L19.5 7"/>',
  heart: '<path d="M12 19.7S4.2 15.2 4.2 9.7A4.2 4.2 0 0 1 12 7.1a4.2 4.2 0 0 1 7.8 2.6c0 5.5-7.8 10-7.8 10Z"/>',
  star: '<path d="m12 3.9 2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.6-5 2.6 1-5.6-4.1-4 5.6-.8Z"/>',
  spark: '<path d="m12 3.5 1.7 5.1 5.1 1.7-5.1 1.7L12 17.1l-1.7-5.1-5.1-1.7 5.1-1.7L12 3.5Z"/><path d="m18.5 15.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/>',
  clock: '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.2v5.2l3.4 2"/>',
  closeSmall: '<path d="m8 8 8 8M16 8l-8 8"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
};

const NAMES = new Set(Object.keys(PATHS));

export function icon(name, size = 18, cls = '') {
  const path = PATHS[name] || PATHS.spark;
  return `<svg class="cd-icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

export function iconEl(name, size = 18, cls = '') {
  const span = document.createElement('span');
  span.className = 'cd-icon-wrap';
  span.innerHTML = icon(name, size, cls);
  return span.firstElementChild;
}

/** Fill every <span data-icon="..."> with the matching line icon. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.getAttribute('data-icon');
    if (!NAMES.has(name)) continue;
    if (el.querySelector('svg.cd-icon')) continue;
    el.innerHTML = icon(name, Number(el.getAttribute('data-icon-size')) || 18);
  }
}
