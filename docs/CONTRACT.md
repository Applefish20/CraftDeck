# CraftDeck 启动器 — 内部模块契约（v1）

本项目为 **零第三方依赖** 的 Node.js 启动器：`node server/server.mjs` 启动本地 HTTP 服务并托管 `web/` 单页界面，
可选 `npm run desktop` 用 Electron 包壳。所有模块使用 ESM（`.mjs`）。

数据根目录（`ROOT`）默认 `%APPDATA%/CraftDeck`，可用环境变量 `MCL_ROOT` 覆盖。

```
ROOT/
  state.json                 全局配置/账户/实例/服务器
  launcher/shared/libraries/ Maven 库
  launcher/shared/assets/    objects/indexes
  launcher/shared/versions/  <id>/<id>.json + <id>.jar
  instances/<id>/            instance.json + minecraft/(mods,resourcepacks,shaderpacks,saves,logs...)
  downloads/                 下载缓存、安装器
  media/                     自定义背景等媒体
  logs/                      启动器日志
```

## 共享模块（已实现，直接 import）

`server/core/util.mjs`
`isWin, isMac, isLinux, sleep, uid(prefix), ensureDir, ensureDirSync, exists, existsSync, readJson, readJsonSync, writeJson(file,obj), writeJsonSync, readText, sizeOf, rmrf, sha1(buf), sha256(buf), md5(buf), offlineUuid(name), formatBytes(n), formatDuration(ms), safeFileName(name), safeId(name), compareVersions(a,b), hostOsName(), hostArch(), jsonBody(req)`

`server/core/paths.mjs`
`ROOT, CORE_DIR, SHARED_DIR, LIBRARIES_DIR, ASSETS_DIR, INDEXES_DIR, OBJECTS_DIR, VERSIONS_DIR, INSTANCES_DIR, DOWNLOADS_DIR, MEDIA_DIR, LOGS_DIR, CACHE_DIR, STATE_FILE, APP_ROOT, WEB_DIR, instanceDir(id), instanceGameDir(id), instanceMetaFile(id), versionDir(vid), versionJsonFile(vid), versionJarFile(vid), nativesDirFor(vid), ensureLayout()`

`server/core/downloader.mjs`
- `downloadFile(url, dest, { sha1, size, source, retries, onProgress, signal })` → `{path, bytes, cached, sha1}`
- `downloadBatch(tasks, { concurrency, onProgress, signal, source })` → `{total, done, failed, errors}`，task = `{url, dest, sha1, size}`
- `fetchJson(url, { timeoutMs, retries, headers, method, body, source })`
- `fetchRaw(url, { timeoutMs })` → string（XML 等）
- `verifySha1(file, sha1)`、`mirrorUrl(url, source)`、`mavenPathFor(name)`、`libraryLocalPath(name)`、`assetObjectPath(hash)`

`server/core/store.mjs`
`store`（单例）：`store.state, store.settings, store.instances, store.getInstance(id), store.addInstance(obj), store.updateInstance(id, patch), store.removeInstance(id), store.accounts, store.getAccount(id), store.addAccount(obj), store.updateAccount(id, pat), store.removeAccount(id), store.servers, store.addServer, store.updateServer, store.removeServer, store.hosts, store.addHost, store.updateHost, store.removeHost, store.updateSettings(patch), store.publicState(), store.save()`
`resolveInstance(id)`：缺失时回退到最近实例；`instanceById(id)`。

`server/core/events.mjs`
`bus.emitEvent(evt)`, `bus.progress({taskId, scope, label, done, total, bytes, totalBytes, phase, finished, ok, error})`,
`bus.log(level, message, extra)`, `bus.notify(kind, title, message, extra)`, `bus.task(taskId, scope, label, total)` → `{update, done, fail}`
事件通过 SSE `/api/events` 推送，前端按 `type` 分发：`progress` | `log` | `notify` | `install` | `launch` | `host`。

## 路由注册接口

每个 feature 模块导出：

```js
export function register(router, ctx) { router.get(path, handler); router.post(path, handler); ... }
```

- `path` 可含 `:param` 占位（如 `/api/mods/install/:id` 不支持，请用 body），`ctx.params` 为解析后的参数。
- handler 签名 `async (req, res, ctx) => {}`，`ctx = { params, query, instance, state, store, body() }`
  - `ctx.body()` → 解析 JSON body（已做大小限制）
  - `ctx.instance` → 当路径含 `:instanceId` 时自动注入实例对象（找不到为 null）
- 返回 JSON 用 `res.json(obj, status=200)`；
- 也可以直接 `return obj`（框架自动 JSON 化）；
- 错误：`throw new Error('中文错误信息')` → 框架返回 `{ok:false,error}` 400/500。
- 静态文件由 server.mjs 处理。

`ctx` 中还提供 `ctx.app = { ROOT, paths, bus, store, launcher, versions, auth, ... }`，但模块应只依赖自己 import 的东西，避免循环依赖。

## 各 feature 模块接口（由子代理实现）

### `server/features/modrinth.mjs`

```js
export async function search({ query='', type='mod', gameVersion='', loader='', index='relevance', offset=0, limit=20, categories=[] })
// → { hits: [...raw], total_hits, offset, limit }   （type: mod|modpack|resourcepack|shader|datapack）
export async function project(idOrSlug)          // → raw project JSON
export async function versions(idOrSlug, { gameVersion, loader, featured } = {}) // → raw version[]
export async function installMod({ projectId, versionId, instanceId, gameVersion, loader, taskId, withDependencies=true })
// → { installed: [{projectId, title, filename, versionId, path}], skipped: [], failed: [] }
export async function installResource({ projectId, versionId, instanceId, kind, gameVersion, taskId })
// kind: 'resourcepack' | 'shader'  → 装入 minecraft/resourcepacks|shaderpacks
export async function installModpackFromFile({ filePath, instanceId, taskId, onInstanceCreated })
// 支持 .mrpack(Modrinth) 与 CurseForge .zip；返回 { instanceId, name, files, overrides, loader }
export async function inspectModpack(filePath)   // 读取元数据（不安装）→ { format, name, versionId, loader, summary, icon }
export function register(router, ctx)
```

路由：

- `GET /api/mods/search?query=&type=mod&gameVersion=&loader=&offset=&limit=&index=`
- `GET /api/mods/project/:id`
- `GET /api/mods/versions/:id?gameVersion=&loader=`
- `POST /api/mods/install` `{projectId, versionId?, instanceId, gameVersion, loader, withDependencies}`
- `POST /api/resources/install` `{projectId, versionId?, instanceId, kind}`（resourcepack / shader）
- `POST /api/modpacks/inspect` `{path}` 或 multipart 上传（上传请用 `POST /api/modpacks/upload`）
- `POST /api/modpacks/install` `{path?, instanceId?, name?}`（也接受已上传文件路径）
- `POST /api/modpacks/upload`（raw body，`x-filename` 头携带文件名）→ `{path, meta}`

依赖解析：Modrinth version.dependencies 中 `dependency_type === 'required'` 的 project_id 递归安装（去重、深度 ≤ 8）。
文件一致性：下载后用 sha1 校验；文件名用 `files[0].filename`；重复安装覆盖同名文件。

### `server/features/accounts.mjs`

```js
export async function createOffline({ username, skinModel='classic' })     // → account
export async function beginMicrosoftLogin()   // 设备码流程，返回 { userCode, verificationUri, expiresIn, deviceCode }，后台轮询
export async function pollMicrosoftLogin(deviceCode) // 内部使用；结果通过 bus 事件 'ms-login' 推送
export async function completeMicrosoft(deviceCode)  // → account（失败抛错）
export async function loginThirdParty({ authServer, username, password, skinModel }) // authlib-injector（Yggdrasil）
export async function refreshAccount(accountId)  // → account（刷新 token，失败抛错）
export async function ensureValid(account)       // → account（必要时刷新）
export async function authlibJvmArgs(account)    // → { args: [...], authServer }  无第三方账户时 args=[]
export async function fetchProfile(account)      // → { name, id, skinUrl, capeUrl, model }
export function register(router, ctx)
```

路由：

- `GET  /api/accounts`
- `POST /api/accounts/offline` `{username, skinModel}`
- `POST /api/accounts/microsoft/start` → `{userCode, verificationUri, expiresIn}`
- `POST /api/accounts/microsoft/poll` `{deviceCode}` → `{status:'pending'|'ok'|'error', account?}`
- `POST /api/accounts/thirdparty` `{authServer, username, password, skinModel}`
- `POST /api/accounts/:id/refresh`
- `DELETE /api/accounts/:id`
- `GET  /api/accounts/:id/skin` → PNG（可 302 到外链）

微软登录：`https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`（scope `XboxLive.signin offline_access`，client_id 取 `store.settings.microsoftClientId`）
→ `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`
→ XBL `https://user.auth.xboxlive.com/user/authenticate`
→ XSTS `https://xsts.auth.xboxlive.com/xsts/authorize`（RelyingParty `rp://api.minecraftservices.com/`）
→ `https://api.minecraftservices.com/authentication/login_with_xbox`
→ `https://api.minecraftservices.com/minecraft/profile`
成功后 `store.addAccount({type:'microsoft', username, uuid, accessToken, refreshToken, expiresAt, ...})` 并 `bus.notify('success','登录成功', username)`。
注意：MS 账户若 API 返回错误（无游戏所有权等）给出中文提示。

第三方账户：先 `GET {authServer}` 获取 `signature_publickey` 与 `authentication-server`；
Yggdrasil `POST /authserver/authenticate {agent:{name:'Minecraft',version:1}, username, password, requestUser:true}` →
保存 `accessToken/clientToken/selectedProfile(uuid,name)`；authlib-injector jar 下载到 `ROOT/launcher/authlib-injector.jar`，
`-javaagent:<jar>=<authServer>`；`refreshAccount` 调 `/authserver/refresh`。

### `server/features/servers.mjs`

```js
export async function ping(address, port=25565, timeoutMs=5000)
// → { online:true, version:{name,protocol}, players:{online,max,sample}, motd, icon, latencyMs }
// 离线 → { online:false, error, latencyMs }
export async function scanLan(timeoutMs=4000)   // UDP 4445 广播 [MOTD]..[/MOTD][AD]port[/AD] → [{motd, port, address}]
export function register(router, ctx)
```

路由：

- `GET  /api/servers`（列表）
- `POST /api/servers` `{name, address, port?}`
- `PATCH /api/servers/:id`、`DELETE /api/servers/:id`
- `GET  /api/servers/:id/ping` → ping 结果（并把结果写入 `entry.lastStatus`）
- `GET  /api/servers/ping?address=&port=` → 直接 ping
- `GET  /api/servers/lan` → `{ worlds: [...] }`

### `server/features/hosts.mjs`（开服）

```js
export async function createHost({ name, gameVersion, type='vanilla', port=25565, memoryMb=2048, motd, maxPlayers=20, eula=true, onlineMode=true, seed })
export function startHost(id) / stopHost(id) / hostStatus(id) / deleteHost(id)
export function register(router, ctx)
```

路由：

- `GET  /api/hosts`、`POST /api/hosts`、`DELETE /api/hosts/:id`
- `POST /api/hosts/:id/start`、`POST /api/hosts/:id/stop`
- `GET  /api/hosts/:id/logs?tail=200`
- `GET  /api/hosts/:id/properties`、`PUT /api/hosts/:id/properties` `{properties:{...}}`
- `POST /api/hosts/:id/command` `{command}`（写入 stdin）
- `GET  /api/java` → 已安装 Java 列表 `[{path, version, major, vendor}]`

服端类型：`vanilla`（Mojang server.jar）、`fabric`（fabric-installer server）、`forge`（forge installer `--installServer`）、`neoforge`、`paper`（PaperMC API v2）。
下载到 `ROOT/servers/<id>/`，写 `server.properties`、`eula.txt`，`bus` 推送 `host` 事件（`{hostId, line}`）。

### `server/features/translation.mjs`

```js
export async function listPacks()
// → [{ id, name, description, type:'mod'|'resourcepack', source, gameVersions:[], url, homepage, recommended }]
export async function installPack({ packId, instanceId })
// → { path, name, gameVersions }   下载 zip 到 instance/minecraft/resourcepacks/
export async function autoTranslate({ instanceId, gameVersion })
// 扫描实例 mods 目录，若存在未汉化 mod，安装推荐汉化包 → { installed, packs:[...] , reason }
export function register(router, ctx)
```

路由：`GET /api/translation/packs`、`POST /api/translation/install` `{packId, instanceId}`、`POST /api/translation/auto` `{instanceId}`

汉化来源（全部为公开资源，任一不可达要优雅降级）：
- CFPA 简体中文汉化资源包（GitHub `CFPAOrg/Minecraft-Mod-Language-Package` releases）
- `VM汉化组` 汉化资源包（`VMTranslationPack` GitHub releases，可选）
- Modrinth 上的汉化模组/资源包搜索（`project_type:resourcepack` 且 query 含 `汉化`/`Chinese`）

## 后端核心（主代理实现，勿修改）

`server/core/{util,paths,downloader,events,store}.mjs` + `server/core/{versions,launcher,java}.mjs` + `server/server.mjs`。
