# CraftDeck 代码结构与文件整理

> 当前版本：**3.6.1** · 桌面端 Electron + 本地 Node HTTP 服务 + 原生 ES Module 前端

## 1. 项目结构

```text
mclauncher/
├─ desktop.mjs                 Electron 主进程：窗口、单实例锁、托盘/关闭、外部链接
├─ preload.cjs                 最小 preload：窗口控制与 openExternal 白名单 IPC
├─ package.json                版本、脚本、Electron 开发依赖
├─ icon.ico                    应用图标（exe / 任务栏 / 快捷方式）
├─ 启动器图标.png               安装包图标
├─ 启动 CraftDeck.bat           浏览器源码运行入口
│
├─ server/                     本地服务（无第三方运行时依赖）
│  ├─ server.mjs               HTTP 路由、鉴权、静态资源、SSE、启动入口
│  ├─ core/
│  │  ├─ paths.mjs             数据目录解析与目录常量
│  │  ├─ util.mjs              UUID、哈希、JSON、文件工具
│  │  ├─ store.mjs             状态持久化、迁移、令牌 safeStorage 加解密
│  │  ├─ events.mjs            进程内事件总线 → SSE
│  │  ├─ downloader.mjs        并发下载、Range 分片、SHA1、重试、取消信号
│  │  ├─ versions.mjs          Mojang 清单、继承解析、库/资源、加载器安装
│  │  ├─ launcher.mjs          JVM/游戏参数、natives、进程管理
│  │  ├─ java.mjs              Java 扫描、版本选择、内置 JRE 检测
│  │  └─ log.mjs               启动器日志
│  └─ features/
│     ├─ modrinth.mjs          Modrinth 搜索/版本/安装、mrpack / CurseForge zip
│     ├─ installed.mjs         已安装模组元数据与图标读取
│     ├─ accounts.mjs          离线 / 微软设备码 / authlib-injector
│     ├─ skins.mjs             皮肤上传、预览、LittleSkin
│     ├─ skinlibrary.mjs       LittleSkin 公共皮肤库
│     ├─ servers.mjs           服务器收藏、Server List Ping、局域网发现
│     ├─ terracotta.mjs        陶瓦联机
│     ├─ hosts.mjs             本地开服
│     ├─ translation.mjs       CFPA 汉化资源包
│     ├─ toolbox.mjs           百宝箱：内存/缓存/校验/诊断
│     ├─ update.mjs            更新检查
│     └─ feedback.mjs          反馈提交
│
├─ web/                        原生 SPA（无构建步骤）
│  ├─ index.html               CSP、侧边栏、背景层、任务条
│  ├─ css/                     base / components / pages
│  ├─ js/
│  │  ├─ app.js                路由、导航、任务条、SSE 分发、弹窗
│  │  ├─ state.js              API 封装（Token）、全局状态、外观应用
│  │  ├─ ui.js                 组件、Modal、Toast、确认框
│  │  ├─ versionicons.js       版本类型/加载器图标、随机封面规则
│  │  ├─ modnames.mjs          常用模组中文名
│  │  └─ pages/                各页面模块
│  └─ assets/
│     ├─ icon.png              品牌图标
│     ├─ instance/             方块图标 + 6 张封面 + covers/
│     └─ skins/                默认皮肤、头像、预设皮肤
│
├─ scripts/
│  ├─ build-app.mjs            解压 Electron、复制 app、生成绿色版目录
│  ├─ pack-zip.py              正斜杠 ZIP 打包
│  └─ 启动器.bat                开发辅助
│
├─ tests/
│  ├─ smoke.mjs                API 端到端冒烟
│  ├─ ui-smoke.mjs             最小 DOM 页面渲染冒烟
│  ├─ download-test.mjs        多线程 Range + SHA1 校验
│  ├─ terracotta-probe.mjs     陶瓦诊断
│  └─ dom-stub.mjs             测试用最小 DOM
│
└─ docs/
   ├─ ARCHITECTURE.md          本文件
   ├─ CONTRACT.md              后端模块契约
   ├─ UI-CONTRACT.md           前端页面契约
   └─ legacy/                  旧版说明、Java 声明
```

## 2. 运行时架构

```text
Electron 主进程
  ├─ 单实例锁（固定 %APPDATA%\CraftDeck\electron 作为 userData）
  ├─ 启动本地 HTTP 服务（127.0.0.1 + 随机端口）
  └─ BrowserWindow 加载 http://127.0.0.1:<port>/?t=<一次性 Token>
          │
          ▼
本地 Node HTTP 服务
  ├─ /api/*           Token 鉴权（X-CraftDeck-Token 或 ?t=）
  ├─ /api/events      SSE 进度/日志/通知
  ├─ /media/*         背景图
  └─ 静态资源         web/
          │
          ▼
server/core + server/features
  ├─ Mojang / Modrinth / Fabric / Forge / LittleSkin / Terracotta
  └─ 数据目录 %APPDATA%\CraftDeck
```

### 安全边界

- 本地 API 默认启用随机 Token，静态页面本身可读，但 API 需要 Token。
- `<img>` 无法带自定义头，因此头像、皮肤、模组图标、封面图等只读图片接口单独放行。
- 账户令牌写入 `state.json` 前用 Electron `safeStorage`（DPAPI）加密。
- CSP 限制脚本仅 `self`，图片允许 `data:` / `blob:` / `https:`。
- 单实例锁固定在统一 userData，避免不同启动参数绕过。

## 3. 数据目录

```text
%APPDATA%\CraftDeck/
├─ state.json              设置、账户、实例、服务器、统计
├─ electron/               Electron 缓存 + 单实例锁
├─ launcher/shared/
│  ├─ libraries/           Maven 依赖
│  ├─ assets/              objects / indexes
│  ├─ versions/            版本 JSON + client.jar
│  └─ natives/             解压后的 natives
├─ instances/<id>/
│  ├─ instance.json
│  └─ minecraft/           mods / resourcepacks / shaderpacks / saves / logs
├─ downloads/              整合包、安装器、仅下载文件
├─ media/                  自定义背景图
├─ logs/                   启动器日志
└─ servers/                本地开服目录
```

## 4. 完整包结构

```text
CraftDeck-3.6.1/
├─ CraftDeck.exe
├─ 启动 CraftDeck.bat
├─ 启动器图标.png
├─ app/                     server + web + desktop + package.json
├─ resources/app/runtime/   jre8 / jre21 / jre25
├─ locales/                 zh-CN.pak / en-US.pak
└─ licenses/                LICENSE + LICENSES.chromium.html
```

## 5. 开发与验证

```bash
cd mclauncher
node server/server.mjs --port=25555 --open    # 浏览器调试
node tests/smoke.mjs                          # API 冒烟
node tests/ui-smoke.mjs                       # 页面渲染冒烟
node tests/download-test.mjs                  # 多线程下载校验（联网）
node scripts/build-app.mjs                    # 生成绿色版
```

打包顺序：

1. `build-app.mjs` 解压 Electron 并复制 `server/`、`web/`、`desktop.mjs`、`preload.cjs`、`icon.ico`。
2. 复制内置 JRE 到 `resources/app/runtime`。
3. 移动 `LICENSE` / `LICENSES.chromium.html` 到 `licenses/`，仅保留 `zh-CN.pak` / `en-US.pak`。
4. `rcedit` 写入 exe 图标与 3.6.1 版本信息。
5. `pack-zip.py` 生成 `CraftDeck-3.6.1-win64-full.zip`。

## 6. 代码约定

- 后端只用 Node 内置模块，保持零运行时依赖。
- 前端不引入框架，页面模块以 `export default { render, destroy }` 暴露。
- API 返回统一 `{ ok: true, ... }` 或 `{ ok: false, error }`。
- 下载任务通过 `bus.progress` 推送，任务条和 SSE 共用同一个 `taskId`。
- 新增功能优先放在 `server/features/*.mjs`，不要继续膨胀 `server.mjs`。
- 静态资源按用途分目录：实例图标/封面在 `web/assets/instance`，皮肤在 `web/assets/skins`。

## 7. 已知边界

- 更新功能为“检查 + 下载更新包”，不静默替换 exe。
- CurseForge 在线下载源已移除；本地 CurseForge 整合包 `.zip` 仍可导入。
- 完整包约 300 MB，主要是 jre8 / jre21 / jre25 三套运行时。
- 桌面文件夹本身不设置自定义图标；只有 exe/快捷方式使用启动器图标。
