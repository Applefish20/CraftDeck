# CraftDeck · 我的世界启动器

**作者：Applefish** · 当前版本 **3.6.1**

一个功能完整的《Minecraft: Java Edition》第三方启动器：**桌面应用（Electron）与浏览器版双形态**，
桌面版内置 Node 运行时，解压即用，无需安装 Node.js。

> 支持 **正版（微软账户）/ 离线 / 第三方皮肤站（authlib-injector）** 登录，支持 **版本下载、模组、整合包、
> 材质光影、模组汉化、皮肤下载与装配、陶瓦联机、服务器列表与联机、一键开服、百宝箱、多线程下载、日志查看、自定义背景**。

---

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 桌面应用 | Electron 打包的 `CraftDeck.exe`，内置 Node 运行时，解压双击即用；与浏览器版共享同一套数据目录 |
| 版本下载 | Mojang 官方版本清单；**按大版本分类**（点 1.21 → 弹出 1.21.8/1.21.7…），含正式版、快照、**Beta、Alpha 远古版**；客户端、依赖库、资源文件，SHA1 校验、断点重下、实时进度 |
| 多线程下载 | 大文件自动按 Range 分段、多连接并行下载（默认 4 线程，可在设置中调 1-16）；进度显示速度与剩余时间 |
| 模组加载器 | Fabric / Quilt（官方 meta 一键安装）、Forge / NeoForge（官方安装器自动执行） |
| 模组 | Modrinth 搜索、版本筛选、必需前置依赖自动递归安装、文件 SHA1 校验；**常用模组中文名显示**（可在设置关闭） |
| 皮肤 | 上传本地皮肤、从网络地址下载、按正版用户名获取、**LittleSkin 在线皮肤库（最新/热门/经典/纤细/高清，可换一批）**、Classic/Slim 模型、正面预览；正版账户可同步到 Mojang |
| 实例内容 | 概览（版本/加载器/快捷文件夹）、设置（内存/Java/JVM/游戏参数）、Mod 管理（启用/禁用/删除）、光影与材质、账户、高级（导出启动脚本/补全文件/删除版本） |
| 整合包 | Modrinth `.mrpack` 在线/本地安装、CurseForge `.zip` 本地导入（需 API Key 才能自动下载模组）、自动创建实例并安装对应加载器 |
| 材质光影 | Modrinth 资源包 / 光影包搜索与一键安装到实例 |
| 模组汉化 | CFPA 简体中文汉化资源包等来源，一键安装；自动为实例启用 `lang:zh_cn` |
| 陶瓦联机 | 集成 [Terracotta 陶瓦联机](https://github.com/burningtnt/Terracotta)：一键下载组件、创建/加入房间、房间码、成员列表、直连地址，无需端口映射 |
| 联机 | 服务器收藏、真实 Server List Ping（在线人数/MOTD/延迟/图标）、局域网世界 UDP 扫描、一键启动并直连服务器 |
| 开服 | 原版 / Fabric / Paper / Purpur / Forge / NeoForge 服务端一键下载与启动、EULA、`server.properties` 编辑、控制台命令、日志 |
| 百宝箱 | 内存优化（GC + 缓存清理）、缓存/日志/临时文件清理、游戏文件校验修复、网络诊断、端口检测、诊断导出、**自定义直链下载**、重置设置 |
| 日志 | 启动器日志 / 游戏日志查看、自动刷新、复制、导出 |
| 账户 | 微软 OAuth 设备码登录（正版）、离线账户（离线 UUID 规则）、第三方 Yggdrasil 皮肤站（authlib-injector）、令牌刷新、**自定义头像（PNG/JPG/WebP）** |
| 个性化 | 自定义背景（本地图片上传 / 网络图片 / 渐变预设）、模糊与暗度调节、强调色、深色主题 |
| 其它 | 实例管理（多版本、独立内存/JVM 参数/账户）、启动命令预览、游戏日志控制台、Java 自动检测、下载源切换 |

## 快速开始

### 方式一：桌面应用（推荐，免安装 Node.js）

1. 解压 `CraftDeck-3.6.1-win64-full.zip` 到一个普通文件夹（不要在压缩包预览里直接运行）。
2. 双击 `CraftDeck.exe`。
3. 首次启动如遇 Windows SmartScreen，点「更多信息」→「仍要运行」。
4. 若双击无反应，运行同目录的 `启动（兼容模式）.bat`；仍不行则运行 `浏览器模式.bat`（用默认浏览器显示界面，后台服务照常运行）。

> 桌面版内置 Electron + Node 运行时，数据保存在 `%APPDATA%\CraftDeck`，与浏览器版共享存档与实例。

### 方式二：浏览器版（需要 Node.js）

> ⚠️ 请先把压缩包完整解压，不要直接在压缩包预览窗口里双击 `.bat`。

1. 安装 [Node.js](https://nodejs.org/) **18 或更高版本**。
2. 双击根目录的 `启动 CraftDeck.bat`。
3. 浏览器会自动打开 `http://127.0.0.1:25555`；若没有自动打开，请手动访问。
4. 保持黑色命令行窗口开启，关闭窗口即退出。

### 方式三：源码运行 / 自行打包

```bash
cd mclauncher
node server/server.mjs --port=25555 --open   # 浏览器版
npm run desktop                              # 需要先安装 electron
node scripts/build-app.mjs                   # 用 dist/electron.zip 生成 dist/CraftDeck-win32-x64
```

## 使用流程

1. **账户页** 添加账户：离线用户名即可开玩；正版点击「微软登录」按提示在浏览器输入设备码；第三方皮肤站填认证服务器、邮箱、密码。
2. **版本下载**：点击 `1.21` 这样的大版本卡片，在弹出的窗口里选择具体小版本（也可切换快照 / Beta / Alpha 分类），再选择实例与加载器安装。
3. 等待左下角任务进度完成，回到 **实例页** 点击「启动游戏」。
4. 需要模组/光影/汉化时，到对应页面选择实例一键安装。
5. 联机：**陶瓦联机** 创建/加入房间；或 **服务器列表** 添加服务器并「进入」；或 **开服中心** 创建本地服务器。
6. **设置 → 百宝箱**：内存优化、清理缓存、文件校验、网络诊断、端口检测、导出诊断。

## 测试

```bash
cd mclauncher
node tests/smoke.mjs         # API 端到端冒烟（账户/版本/搜索/服务器检测/设置/SSE…）
node tests/ui-smoke.mjs      # 在最小 DOM 桩中渲染全部页面，检查运行时错误
node tests/download-test.mjs # 多线程分段下载校验（下载 1.21.1 客户端并比对 SHA1）
```

开发文档：`docs/ARCHITECTURE.md`（代码结构与文件组织）、`docs/CONTRACT.md`（后端模块契约）、`docs/UI-CONTRACT.md`（前端页面契约）。

## 数据目录

默认位于 `%APPDATA%\CraftDeck`（Windows），可用环境变量 `MCL_ROOT` 覆盖：

```
CraftDeck/
├─ state.json                 配置、账户、实例、收藏的服务器
├─ launcher/shared/
│  ├─ libraries/              Maven 依赖库（所有实例共享）
│  ├─ assets/                 游戏资源（objects / indexes）
│  └─ versions/               各版本 JSON 与 client.jar
├─ instances/<id>/            实例目录
│  ├─ instance.json           实例元数据
│  └─ minecraft/              游戏目录（mods / resourcepacks / shaderpacks / saves / logs …）
├─ servers/<id>/              本地开服目录
├─ downloads/                 整合包、安装器缓存
├─ media/                     自定义背景图片
└─ logs/launcher.log          启动器日志（5MB 轮转）
```

## 技术架构

```
mclauncher/
├─ server/server.mjs              HTTP 服务、路由、静态资源、SSE
├─ server/core/
│  ├─ paths.mjs                   数据目录布局
│  ├─ util.mjs                    UUID / 哈希 / 文件工具
│  ├─ store.mjs                   状态持久化
│  ├─ events.mjs                  全局事件总线（SSE 进度推送）
│  ├─ downloader.mjs              并发下载、SHA1 校验、镜像改写、重试
│  ├─ versions.mjs                版本清单、继承解析、库/资源下载、加载器安装
│  ├─ launcher.mjs                启动参数拼装、natives 解压、游戏进程管理
│  ├─ java.mjs                    Java 扫描与版本选择
│  └─ log.mjs                     日志落盘
├─ server/features/
│  ├─ modrinth.mjs                Modrinth 搜索/安装、mrpack / CurseForge 整合包
│  ├─ accounts.mjs                离线 / 微软设备码 / authlib-injector
│  ├─ servers.mjs                 服务器列表、Server List Ping、局域网发现
│  ├─ terracotta.mjs              陶瓦联机组件下载、进程、HTTP API 轮询
│  ├─ toolbox.mjs                 百宝箱：内存/清理/校验/诊断
│  ├─ hosts.mjs                   本地开服：服务端下载、进程、属性、日志
│  └─ translation.mjs             汉化资源包
└─ web/                           单页界面（原生 ES Module，无框架）
```

### 关键实现说明

- **版本继承**：Fabric/Quilt/Forge 生成的版本 JSON 通过 `inheritsFrom` 继承原版；启动器合并库、JVM 参数与游戏参数。
- **Classpath**：`libraries/` 下按 Maven 路径组装；旧版 natives 自动解压到 `launcher/shared/natives/<version>`，并通过 `-Djava.library.path` 传入。
- **资源校验**：所有官方文件都用 SHA1 校验，已存在且校验通过的文件不会重复下载。
- **账户安全**：令牌仅保存在本机 `state.json`；对外 API 永不返回令牌；第三方登录通过 `-javaagent:authlib-injector.jar=<认证服务器>` 注入。
- **进度推送**：安装/下载/启动/开服全部通过 SSE `/api/events` 推送到界面，刷新页面不会丢失任务状态（任务在后端继续执行）。
- **零依赖**：没有 `node_modules` 也能运行；Electron 仅为可选外壳。

## HTTP API（节选）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量状态（设置、实例、账户、服务器） |
| PATCH | `/api/settings` | 修改设置 |
| GET | `/api/versions` | 版本清单 |
| POST | `/api/versions/install` | 下载指定版本 |
| POST | `/api/instances/:id/setup` | 为实例安装版本 + 加载器（异步 + SSE 进度） |
| POST | `/api/instances/:id/launch` | 启动游戏，可带 `{server:{host,port}}` 直连 |
| POST | `/api/instances/:id/kill` | 结束游戏 |
| GET | `/api/instances/:id/dryrun` | 查看启动命令 |
| GET | `/api/mods/search` | Modrinth 搜索（mod/modpack/resourcepack/shader） |
| POST | `/api/mods/install` | 安装模组（含前置依赖） |
| POST | `/api/modpacks/install` | 安装本地整合包 |
| POST | `/api/modpacks/install-project` | 在线安装 Modrinth 整合包 |
| POST | `/api/resources/install` | 安装资源包 / 光影 |
| POST | `/api/translation/auto` | 一键汉化实例 |
| GET/POST | `/api/servers` | 服务器列表 / 添加 |
| GET | `/api/servers/:id/ping` | 服务器状态检测 |
| GET | `/api/servers/lan` | 局域网世界扫描 |
| POST | `/api/hosts` | 创建并安装本地服务器 |
| POST | `/api/hosts/:id/start` / `stop` | 启动 / 停止服务器 |
| POST | `/api/accounts/offline` | 离线账户 |
| POST | `/api/accounts/microsoft/start` / `poll` | 微软设备码登录 |
| POST | `/api/accounts/thirdparty` | 第三方 Yggdrasil 登录 |
| GET | `/api/events` | SSE 事件流 |

完整契约见 `docs/CONTRACT.md` 与 `docs/UI-CONTRACT.md`；文件结构与打包说明见 `docs/ARCHITECTURE.md`。

## 常见问题

**启动游戏提示缺少 Java？**
安装 Java 21（1.20.5+ 需要 21，1.17-1.20.4 需要 17，旧版本需要 8），或在「设置 → Java」中手动指定 `java.exe` 路径。
启动器也会自动扫描 `JAVA_HOME`、`Program Files\Java`、Adoptium、Zulu、Microsoft JDK 等目录。

**正版登录失败（AADSTS700016 等）？**
默认使用开源社区公共客户端 ID；若微软调整策略，可在「设置 → 账户与登录」填入你自己的 Azure 应用 Client ID（公开客户端、允许设备码流）。
登录失败不会影响离线账户游玩。

**下载很慢 / 卡住？**
在「设置 → 下载与网络」切换下载源，或调低并发数；断点重下的临时文件会自动清理。
资源文件总量约 300-500MB，首次安装请耐心等待。

**CurseForge 整合包提示缺少文件？**
CurseForge 官方 API 需要 Key，请在设置中填入；没有 Key 时 Modrinth 整合包与直链文件不受影响。

**联机提示版本不兼容？**
「进入服务器」使用当前实例的版本；请把实例版本调整为与服务器一致（例如服务器是 1.21.1 就选 1.21.1）。

**开服后朋友连不上？**
默认监听 25565；需要路由器端口映射或使用内网穿透（如 frp / playit.gg）。局域网内可直接用「扫描局域网」发现。

**界面打不开 / 端口占用？**
启动器会自动尝试 25555 起的后续端口，请查看命令行输出的实际地址；也可 `--port=xxxx` 指定。

## 开源与致谢

本项目参考并使用了以下公开服务/项目的接口与资源（仅调用公开 API，未复制其代码）：

- **Applefish** — CraftDeck 作者、设计与开发
- [Mojang 版本清单与资源 API](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
- [Modrinth 开放 API](https://docs.modrinth.com/) — 模组 / 整合包 / 资源包搜索与下载
- [Fabric Meta](https://meta.fabricmc.net/) / [Quilt Meta](https://meta.quiltmc.org/) — 加载器安装配置
- [MinecraftForge Maven](https://maven.minecraftforge.net/) / [NeoForged Maven](https://maven.neoforged.net/) — Forge/NeoForge 安装器
- [authlib-injector](https://authlib-injector.yushi.moe/) — 第三方 Yggdrasil 登录（Blessing Skin / LittleSkin 等）
- [Terracotta 陶瓦联机](https://github.com/burningtnt/Terracotta) — 房间码联机（通过其公开 HTTP API 调用，AGPL-3.0-or-later）
- [CFPA 汉化资源包](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package) — 模组简体中文汉化
- [PaperMC](https://api.papermc.io/) / [PurpurMC](https://api.purpurmc.org/) — 服务端核心
- 界面设计参考了 HMCL、Prism Launcher、PCL2 等优秀开源/免费启动器的交互思路

## 免责声明

- 本项目仅供学习与技术研究，请支持购买正版 Minecraft。
- 第三方登录、皮肤站、镜像源等由第三方提供，可用性不受本项目控制。
- 使用第三方启动器/离线账户可能违反部分服务器规则，请自行判断。

## 许可

MIT License（示例代码可自由学习、修改与分发）。
