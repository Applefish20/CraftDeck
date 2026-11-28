import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(here, '..');            // CraftDeck/server
export const APP_ROOT = path.resolve(SERVER_DIR, '..');        // CraftDeck
export const WEB_DIR = path.join(APP_ROOT, 'web');

/**
 * Launcher data root. Resolution order:
 *  1. MCL_ROOT env var
 *  2. %APPDATA%/CraftDeck (Windows) / ~/.config/CraftDeck
 * Kept outside the app folder so updates never wipe user data.
 */
export function resolveRoot() {
  if (process.env.MCL_ROOT) return path.resolve(process.env.MCL_ROOT);
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'CraftDeck');
}

export const ROOT = resolveRoot();
export const CORE_DIR = path.join(ROOT, 'launcher');
export const SHARED_DIR = path.join(CORE_DIR, 'shared');        // libraries + assets shared by all versions
export const LIBRARIES_DIR = path.join(SHARED_DIR, 'libraries');
export const ASSETS_DIR = path.join(SHARED_DIR, 'assets');
export const INDEXES_DIR = path.join(ASSETS_DIR, 'indexes');
export const OBJECTS_DIR = path.join(ASSETS_DIR, 'objects');
export const VERSIONS_DIR = path.join(SHARED_DIR, 'versions');
// 便携版把游戏实例单独放在 minecraft/ 下，其余启动器数据在 log/ 下。
export const INSTANCES_DIR = process.env.MCL_INSTANCES
  ? path.resolve(process.env.MCL_INSTANCES)
  : path.join(ROOT, 'instances');
export const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
export const MEDIA_DIR = path.join(ROOT, 'media');
export const LOGS_DIR = path.join(ROOT, 'logs');
export const STATE_FILE = path.join(ROOT, 'state.json');
export const CACHE_DIR = path.join(ROOT, 'cache');

export function instanceDir(id) {
  return path.join(INSTANCES_DIR, id);
}

export function instanceGameDir(id) {
  // .minecraft-like directory that the game itself sees
  return path.join(instanceDir(id), 'minecraft');
}

export function instanceMetaFile(id) {
  return path.join(instanceDir(id), 'instance.json');
}

export function versionDir(versionId) {
  return path.join(VERSIONS_DIR, versionId);
}

export function versionJsonFile(versionId) {
  return path.join(versionDir(versionId), versionId + '.json');
}

export function versionJarFile(versionId) {
  return path.join(versionDir(versionId), versionId + '.jar');
}

export function versionJsonFileInGame(id) {
  return path.join(instanceGameDir(id), 'versions');
}

/** Java `-Djava.library.path` native extraction dir for a given instance+version. */
export function nativesDirFor(versionId) {
  return path.join(SHARED_DIR, 'natives', versionId);
}

export function ensureLayout() {
  for (const d of [ROOT, CORE_DIR, SHARED_DIR, LIBRARIES_DIR, ASSETS_DIR, INDEXES_DIR, OBJECTS_DIR,
    VERSIONS_DIR, INSTANCES_DIR, DOWNLOADS_DIR, MEDIA_DIR, LOGS_DIR, CACHE_DIR, path.join(SHARED_DIR, 'natives')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function javaDownloadDir() {
  return path.join(ROOT, 'runtimes');
}
