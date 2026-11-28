/** 版本图标规则：加载器优先，其次版本类型，最后普通草方块。 */
export const ICON_VERSION_GRASS = '/assets/instance/grass-block.webp';
export const ICON_VERSION_COMMAND = '/assets/instance/command.webp';
export const ICON_VERSION_TEST = '/assets/instance/test.webp';
export const ICON_VERSION_BARRIER = '/assets/instance/barrier.webp';
export const ICON_VERSION_COBBLE = '/assets/instance/cobblestone.webp';
const COVERS = [
  ...Array.from({ length: 6 }, (_, i) => `/assets/instance/covers/cover-${i + 1}.webp`),
  ...['autumn', 'coral', 'village', 'end', 'stronghold', 'night', 'plains', 'monument', 'mottled', 'end-outer', 'desert', 'cherry']
    .map((key) => `/assets/backgrounds/${key}.webp`),
];

function hashSeed(seed) {
  const s = String(seed || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function coverForSeed(seed) {
  return COVERS[hashSeed(seed) % COVERS.length];
}

const LOADER_ICONS = {
  fabric: '/assets/instance/fabric-cut.webp',
  quilt: '/assets/instance/fabric-cut.webp',
  forge: '/assets/instance/forge-cut.webp',
  neoforge: '/assets/instance/neoforge-cut.webp',
};

export function isCutoutIcon(src) {
  return /(?:fabric|forge|neoforge)-cut\.webp/i.test(String(src || ''));
}

const FUN_VERSIONS = new Set([
  '25w14craftmine', '24w14potato', '23w13a_or_b', '22w13oneblockatatime',
  '20w14infinite', '3D Shareware v1.34', '1.RV-Pre1', '15w14a',
]);

export function iconForVersion(versionId, type, loader) {
  const ld = String(loader || '').toLowerCase();
  if (LOADER_ICONS[ld]) return LOADER_ICONS[ld];
  if (type === 'old_alpha') return ICON_VERSION_COBBLE;
  if (type === 'old_beta') return ICON_VERSION_BARRIER;
  if (type === 'snapshot') return FUN_VERSIONS.has(String(versionId)) ? ICON_VERSION_TEST : ICON_VERSION_COMMAND;
  return ICON_VERSION_GRASS;
}

export function iconForInstance(inst, versions = []) {
  if (inst.icon) return inst.icon;
  // 整合包优先使用整合包原始图片；没有图片时按加载器/版本类型给一个默认图标。
  if (inst.mrpackName) {
    if (inst.modpackIcon) return inst.modpackIcon;
    const meta = versions.find((v) => v.id === inst.versionId);
    return iconForVersion(inst.versionId, meta?.type, inst.loader?.type);
  }
  if (inst.modpackIcon) return inst.modpackIcon;
  const meta = versions.find((v) => v.id === inst.versionId);
  return iconForVersion(inst.versionId, meta?.type, inst.loader?.type);
}

/** 手动安装的版本随机分配一张渲染图作封面；整合包只用它自己的封面。 */
export function coverForInstance(inst) {
  if (inst.cover) return inst.cover;
  if (inst.mrpackName) return inst.modpackIcon || coverForSeed(inst.id || inst.name);
  return coverForSeed(inst.id || inst.versionId || inst.name);
}
