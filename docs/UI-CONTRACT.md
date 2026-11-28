# CraftDeck 前端页面模块契约

> 本文件是 `web/js/pages/*.js` 的编写规范。主代理已完成 `web/index.html`、`web/css/*.css`、`web/js/{ui,state}.js`、`web/js/app.js`。
> 页面模块只允许使用这些已有的工具与样式类，不要新增 CSS 文件（如需少量样式，用 `el.style` 或在现有 class 上组合）。

## 页面模块格式

```js
export default {
  async render(view, ctx) { ... },        // view = <section class="viewport"> 内的容器元素；ctx = { route, param, refresh() }
  destroy() { ... },                      // 可选：清理定时器 / 事件监听
};
```

- 页面由 `app.js` 通过 `history` hash 路由调度；`view` 已清空。
- **必须** 使用 `import { h, fmtBytes, ... } from '../ui.js'` 构造 DOM（禁止 innerHTML 拼接不可信内容，文本一律走 `h`）。
- 状态通过 `import { state, api, ... } from '../state.js'`；数据变更后调用 `ctx.refresh()` 重新渲染当前页，或局部更新 DOM。
- 顶栏 / 导航 / 账户切换由 `app.js` 负责，页面内不要重复实现。
- 所有面向用户的文案使用简体中文。

## 可用工具（web/js/ui.js）

`$, $$, h(tag, attrs, children), frag, esc, fmtBytes, fmtNum, fmtDate, fmtRelative, fmtDuration, fmtAgo, gradientFor, cleanMotd, toast({kind,title,message}), toastOk(title,msg), toastErr(title,msg), toastWarn, modal({title, body, actions:[{label, kind:'primary'|'danger'|'', onClick}], wide, footer}), confirmDialog({title,message,okText,danger}) → Promise<bool>, promptDialog({title,label,value,placeholder,okText,multiline}) → Promise<string|null>, emptyState({icon,title,sub,action}), loadingBlock(text), skeletonCards(n), iconImg(url, fallback, cls), badge(text, kind), switchEl(checked, onChange, label), rangeRow({min,max,step,value,suffix,onChange,format}), tabs(items, active, onPick), sectionTitle(title, right), kvList(pairs), progressBar(pct, cls), debounce(fn, ms), copyText(text), timeGreeting, loaderLabel(loader), avatarEl(account, size), downloadJson(name,obj)`

## 可用样式类（web/css/*.css）

布局：`page`, `home`, `panel`, `panel-head`, `panel-title`, `card pad hover`, `section-title`, `row`, `col`, `grow`, `spacer`, `grid`（无，自己用 style grid）。
按钮：`btn`, `btn-primary`, `btn-ghost`, `btn-danger`, `btn-ok`, `btn-sm`, `btn-lg`, `btn-block`, `icon-btn`。
表单：`field`, `label`, `hint`, `input`, `select`, `textarea`, `input-group`, `check`, `switch`, `search-bar`, `filter-bar`, `chip-row`, `chip`, `range-row`。
展示：`badge accent/ok/warn/err/violet`, `dot on/off`, `progress`+`i`, `tabs`/`tab`, `list`/`list-item`/`li-main`/`li-title`/`li-sub`, `kv`, `callout info/warn/err/ok`, `empty`, `skeleton`, `loading-inline`, `modal`。
业务：`hero`, `hero-icon`, `hero-main`, `hero-title`, `hero-meta`, `hero-sub`, `hero-actions`, `hero-launch`, `stats-row`, `stat-card`, `inst-grid`, `inst-card`, `inst-banner`, `inst-body`, `inst-icon`, `inst-info`, `inst-name`, `inst-ver`, `inst-actions`, `inst-running`, `inst-more`, `account-hero`, `acct-grid`, `acct-card`, `acct-type`, `ver-layout`, `ver-list`, `ver-row`, `ver-id`, `ver-date`, `ver-side`, `mod-grid`, `mod-card`, `mod-icon`, `mod-main`, `mod-title`, `mod-desc`, `mod-meta`, `mod-foot`, `pack-grid`, `pack-card`, `pack-cover`, `pack-body`, `pack-name`, `pack-desc`, `srv-grid`, `srv-card`, `srv-icon`, `srv-main`, `srv-name`, `srv-addr`, `srv-motd`, `srv-players`, `ping-bar`, `ping-bars good/mid/bad`, `host-card`, `host-head`, `host-log`, `trans-hero`, `pack-mini`, `settings-grid`, `setting-row`/`sr-label`/`sr-desc`/`sr-control`, `bg-picker`, `bg-thumb`, `range-row`, `launch-dock`, `task-list`, `task-item`, `version-picker`, `vp-filters`, `vp-list`, `detail-list`, `detail-item`.

## 页面清单与职责

### `web/js/pages/resources.js` — 材质与光影（主代理负责：**不要写**）

### `web/js/pages/translation.js` — 汉化
- 顶部 `trans-hero`：标题「模组汉化」+ 说明 + 当前实例选择 + 「一键汉化当前实例」按钮（调用 `POST /api/translation/auto {instanceId}`，成功后 toast + 显示结果，失败 toastErr）。
- 汉化包列表（`GET /api/translation/packs`）：每个 `pack-mini` 显示名称、来源 badge、描述、适配版本、推荐标记；右侧「安装到当前实例」按钮（`POST /api/translation/install {packId, instanceId}`）。
- 无实例时提示先在「实例」页创建实例，并禁用按钮。
- 安装期间按钮 loading，完成后刷新列表或提示。

### `web/js/pages/hosts.js` — 开服中心
- 顶部两个卡片：Java 运行时（`GET /api/java`：显示路径/版本，可「重新检测」）；本机信息（`GET /api/system`：CPU 核数、内存、平台）。
- 服务器列表（`GET /api/hosts` + `state.hosts`）：`host-card`，显示名称、类型、版本、端口、状态（`running`/`stopped`/`installing`）、内存；按钮：启动/停止、打开控制台（`GET /api/hosts/:id/logs?tail=200` 弹窗 + 5 秒轮询）、属性（`GET/PUT /api/hosts/:id/properties` 表单编辑 key=value 文本域）、删除（confirm）。
- 新建服务器：`modal` 表单：名称、游戏版本（用 `GET /api/versions` 取 releases，默认最新）、服务端类型（vanilla / fabric / paper / forge / neoforge / purpur，用 tabs 或 select）、端口（默认 25565）、内存（512-16384，range 或 input）、MOTD、最大玩家数、正版验证开关、EULA 同意开关。提交 `POST /api/hosts`（可能耗时 1-3 分钟，按钮显示「正在下载服务端…」，期间用 SSE `host`/`progress` 事件显示进度条和日志，完成后刷新）。
- 实时日志：订阅 `state` 的 `host` 事件（`import { subscribe } from '../state.js'`，事件 `{type:'host', evt:{hostId, line}}`），过滤当前 hostId 追加到对应 `host-log`。

### `web/js/pages/accounts.js` — 账户
- 当前账户大卡片 `account-hero`：头像（`avatarEl(account,'xl')`，`account.skinUrl` 可能没有；可先用 `/api/accounts/:id/skin` 作为 img src 并 onerror 回退）、名称、类型 badge（正版/离线/第三方）、UUID、登录时间。
- 账户列表 `acct-grid`：点击切换默认账户（`PATCH /api/settings {lastAccountId}` 然后 `ctx.refresh()`），显示「使用中」标记；每张卡有删除按钮。
- 三种登录方式（三张卡片/按钮）：
  1. 离线账户：`promptDialog` 输入用户名（3-16 位字母数字下划线），`POST /api/accounts/offline {username}`。
  2. 微软正版：`POST /api/accounts/microsoft/start` → 返回 `{userCode, verificationUri, expiresIn}`；弹窗显示大号 userCode + 「复制」+「打开登录页面」（`window.open(verificationUri)`），然后每 5 秒 `POST /api/accounts/microsoft/poll {deviceCode}`，`status==='pending'` 继续，`'ok'` 关闭弹窗刷新，错误则显示错误。注意：`deviceCode` 是不透明字符串，原样传回。
  3. 第三方账户（LittleSkin / 自建皮肤站）：表单：认证服务器地址（默认 `https://littleskin.cn/api/yggdrasil`，提供常用预设下拉：LittleSkin、Blessing Skin 默认、自定义）、邮箱、密码、皮肤模型（classic/slim）；`POST /api/accounts/thirdparty {authServer, username, password, skinModel}`。
- 每个账户可点「刷新」调 `POST /api/accounts/:id/refresh`（微软/第三方令牌），失败提示。
- 说明文案：正版登录使用微软 OAuth 设备码流程，令牌仅保存在本机。

### `web/js/pages/resources.js` — 材质与光影（主代理负责：**不要写**）
