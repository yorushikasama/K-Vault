# 前端模块地图

> 无构建步骤：所有模块都是按序加载的普通 `<script>`，靠全局对象通信。
> 改动任何加载顺序前，先读本文与 `test/frontend-assets-contract.test.js`——
> 顺序约束由 CI 契约测试钉死。

## 页面 → 模块加载链

| 页面 | 本地脚本（按序） |
| --- | --- |
| index（上传首页） | theme-core → theme-effects(defer) → icons-subset → icons → kv-shared → upload-media → upload-image → upload-app |
| admin（文件工作台） | theme-core → theme-effects(defer) → icons-subset → icons → admin-shared → kv-shared → admin-tokens → admin-ui-design → admin-app |
| admin-imgtc（旧图床） | theme-core → theme-effects(defer) → icons-subset → icons → admin-shared → kv-shared → admin-imgtc-app |
| gallery / video | … → kv-shared → 各自 app |
| preview | theme-core → kv-shared → preview-parsers → preview-app → icons |
| admin-waterfall | theme-core → kv-shared → 内联脚本 |
| login / block-img / whitelist-on | theme-core（+ icons）；不依赖共享模块 |

## 共享层

| 文件 | 全局对象 | 职责 |
| --- | --- | --- |
| `kv-shared.js` | `window.KVShared` | 全站工具：escapeHtml / formatSize / copyToClipboard / downloadFile / normalizeFolderPath / ensureAuth / buildPreviewTarget / formatLink / fileIconOf / storageTypeOf / STORAGE_LABELS / STORAGE_TARGETS / toast。被 7 个页面加载；不依赖 Vue。 |
| `app-shell.css` | （无） | 全站统一应用外壳（品牌 + 四页标签导航 + 工具区），取值走 `--ui-*` token，夜间模式无需覆盖块。四页共用、标记逐字相同；tab 高亮靠 `aria-current="page"`。 |
| `admin-shared.js` | `window.KVAdminShared` | 两个后台页逐字相同的 Vue methods/computed/watch（29 项，名单钉在 `scripts/extract-admin-shared.cjs` 的 SHARED_NAMES）。往这里加方法前先确认两页 data 字段同名同义。 |
| `icons.js` / `icons-subset.js` | `window.KVIcons` / `window.lucide` | 图标渲染。`kv-icon` Vue 组件由 icons.js 注册——**动态图标一律用 `<kv-icon :name>`**，不要写 `<i :class>`（lucide 只认 `data-lucide`，class 图标没有渲染机制，FontAwesome 移除后曾批量变空白）。 |

## 页面应用模块

| 文件 | 挂载的全局 | 职责 |
| --- | --- | --- |
| `upload-app.js` | `new Vue` | 上传队列调度、任务生命周期、本地历史、对话框焦点管理 |
| `upload-media.js` | `window.KVUploadMedia.methods` | 视频/URL 转存管线（分享链接判定、解析、清晰度选择、等待计时） |
| `upload-image.js` | `window.KVUploadImage.methods` | 浏览器内图片压缩管线（格式探测、参数持久化、Canvas 压缩、逐项预处理） |
| `admin-app.js` | `new Vue` | 文件工作台装配：列表作用域缓存、目录树、拖拽、批量操作、视图切换 |
| `admin-tokens.js` | `window.KVAdminTokens.methods` | API Token 的创建/轮换/启停/删除 |
| `admin-ui-design.js` | `window.KVAdminUiDesign.methods` | 前端 UI 设计设置面板（含面板模板） |
| `admin-imgtc-app.js` | `new Vue` | 旧版图床管理页应用 |
| `gallery-app.js` | `new Vue` | 图库页应用 |
| `preview-app.js` | IIFE | 预览器的渲染调度与 DOM 构建 |
| `preview-parsers.js` | `window.KVPreviewParsers` | 纯解析器（ZIP/TAR/OpenXML/CSV/邮件/JSON），零 DOM 耦合，可独立测试 |
| `theme-core.js` / `theme-effects.js` | `window.ThemeManager` / `window.UIDesignManager` | 主题切换与 `--ui-*` token 的运行时来源 |

## 铁律

1. **icons.js 必须先于任何 `new Vue` / 应用脚本加载**：它用 `Vue.mixin` 注册渲染钩子，
   只作用于之后创建的实例。顺序反了，条件渲染里的图标永久空白（gallery / admin-imgtc 都踩过）。
   契约测试按页面逐一校验此顺序。
2. **页面不内联应用逻辑**：`new Vue` 只允许出现在根级 app 文件里（契约测试）；
   页面模板里的 `style="` 属性同样禁止（样式进 CSS 文件并使用 token）。
3. **共享方法收口以「逐字相同」为前提**：实现已经分岔的方法（如 `calculatePageSize`、
   `updateStats`）不合并；要合并必须先确认差异是 bug（如 `checkBrokenFiles` 旧版崩溃）
   而非真实需求。
4. **改 CSS/JS 后跑 `npm run assets:stamp`**：内容哈希版本串不更新，用户会拿一年强缓存
   的旧资源；`assets:check` 在 CI 拦截遗忘。
5. **本地验证**：`npm start`（wrangler dev，登录 admin/123）+ 浏览器逐页看控制台；
   `npm run shared:check` / `css:check` / `assets:check` / `npx mocha test/frontend-assets-contract.test.js`。
