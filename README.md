# THEIA

[简体中文](README.md) | [English](README.en.md)

THEIA 是一个本地优先的个人纵向研究系统。任务图、聊天提炼、行程、人物和地图是它目前用于整理时间与证据的界面，但不是项目的最终目的。

> “THEIA 不是一个管理生活的软件，也不是一个分析聊天记录的工具。它是一个长期研究同一个对象的实验，而这个对象始终只有一个——我自己。它试图以时间为维度，将记忆、行为、情绪、关系、决策与环境连接起来，不是为了预测未来，也不是为了评价对错，而是为了尽可能完整地回答一个贯穿我人生的问题：我是如何成为今天的我的，又正在成为怎样的人。”
>
> — GPT-5.5

完整的项目目标、设计原则和决策门槛见 [项目终极目标](docs/PROJECT_VISION.md)。

它不是聊天软件插件，也不会绕过登录或解密应用数据库。THEIA 只读取你明确选择的导出文件；只有在你启动模型提炼后，选中的记录才会发送到你配置的模型服务。

> 当前源码版本：`0.4.1`。Windows x64 NSIS 安装器、便携版与源码发布包分别生成；安装器和便携版自带 Electron 与 Node.js 运行时，无需另行安装 Node.js，任务、设置、聊天归档和日志保存在 `%APPDATA%\\THEIA`。重要数据请定期备份。

## 0.4.1 更新简介

- 重叠分段产生的重复任务和人物证据会在候选入队、合并和持久化前统一去重，保留不同明确时间或地点的真实差异。
- 人物页按最近互动、资料完整度或姓名排序，支持按姓名、平台、事实、偏好、人物刻画和底稿搜索，并显示联系概览与关联任务。
- 人物刻画和行动建议更强调可验证的沟通边界、重复偏好、互动模式与尊重式建议，过滤操控、施压和无证据的情感判断。
- 对话浏览支持中文月份标签、名称搜索，并优先显示对方最近一条消息；人物证据支持展开查看全部内容。

## 0.3.0 至 0.4.0 更新简介

- 原始聊天归档升级为 append-only gzip JSONL 分段；首次迁移保留旧归档作为回滚源，后续目录更新只向本机代理提交变更记录和删除 ID，不再每次上传整份百万级数组。
- 浏览器 IndexedDB 升级为逐消息 `intelRecords` + `intelMeta`，共享状态和聊天归档分离；设置、共享状态和运行日志都有 schema 版本、迁移备份与恢复入口。
- 提取 `useSettingsSync`、`useSharedSync`、`useIntelAnalysisSelection`，并将会话时间线、候选虚拟队列拆为独立模块；共享写入使用版本冲突重试，避免多端覆盖新数据。
- 增加导入、分段、候选校验、归档、迁移、崩溃恢复、日志轮转和增量提交测试；保留原有通道并发、短退避和 502 稳定策略。
- Electron 可用系统凭据存储保护 API Key；无法使用系统凭据的纯 Node 开发模式仍保留兼容回退，并在文档中明确风险。
- 大于 1 MB 的 JSON/CSV/TXT 在 Web Worker 中解析；附件在上传前显示队列、体积、文本 token 粗估和图片/文档计费边界。
- 情报库拆为导入、分析控制器、候选队列和会话浏览组件，长时间任务/人物流程由 `useAiWorkflow` 管理暂停、恢复和重试。
- 自动人物更新以会话内容指纹为水位，只发送新增消息及每条新增消息之前最多 16 条上下文；未变化会话不会反复提交，新增证据仍与已有卡片保守合并。
- 公共地图底图、搜索源和 32–1024 MB 瓦片缓存上限可配置；界面保留 OpenStreetMap 署名并直达各服务使用政策。
- 新增 Playwright 视觉/拖拽回归、Electron 启动与 `safeStorage` 明文迁移烟测，以及 electron-builder NSIS 安装器和 GitHub 自动更新基础。

## 0.2.1 至 0.3.0 更新简介

- 固定已验证的稳定提炼基线：修复分段提示构造导致的本地零请求失败，减少私聊联合请求的固定负担，并保留连续时间线全量覆盖；502 不再通过错误的 API 模式复制请求。
- 人物证据提炼和人物归并改用配置的全局并发，最多可同时使用 64 个工作槽；每条通道保留 1–8 的独立容量，共享同一上游时仍由 origin 容量统一保护。
- 502、429、503、504、524、网络错误和超时采用 250 ms 起步、最多 2 秒的本地短退避；失败任务保留在 session 中，可在服务恢复后继续，不把长时间的上游 `Retry-After` 直接变成本地冻结。
- 新增完整的本地 API、模型请求 JSON、session 批处理、通道状态、日志字段和错误回退协议参考，便于第三方导出适配器、测试服务和问题复现。
- 发布包目录、文档和版本索引统一为 `0.3.0`，继续排除聊天、任务、人物、头像、背景、日志、配置密钥和本机运行状态。

## 0.1.0 至 0.2.1 更新简介

- 从源码预览发展为本地优先的桌面与浏览器双端工具：导入聊天记录后，可统一管理任务图、行程、人物、地点和可追溯的原始证据。
- 提炼改为按会话时间线处理，支持严格时间范围、过期事项过滤、候选审核、人物事实与任务建议，避免把聊天的发言方向混淆。
- 增加开源地图搜索、标记编辑、人物头像、可缩放任务图、外观与背景自定义，以及浏览器和桌面端数据同步。
- 引入多 API 通道池和会话级并发调度：不同会话可占满健康通道，同一会话仍按时间顺序分段，降低重复 token 消耗并隔离 502、限流和超时故障。
- 新增通道利用率、按任务时间戳日志、批量清理和暂停/恢复提炼；关闭后可从已完成对话继续，不再保存重复的“已生成候选”临时归档。

完整变化、升级注意事项和验证结果见 [更新报告](docs/RELEASE_NOTES.md)。模型 JSON、通道池和本地 HTTP 协议见 [API 协议参考](docs/API_PROTOCOL.md)。

## 界面预览

<p align="center">
  <img src="docs/screenshots/task-atlas.png" alt="THEIA 可缩放任务图界面" width="100%">
</p>
<p align="center"><sub>可缩放、可平移并支持拖拽归类的任务图</sub></p>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/intel-workbench.png" alt="THEIA 情报库与模型提炼工作台"><br><sub>情报接入与模型提炼工作台</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/appearance-customization.png" alt="THEIA 界面外观自定义"><br><sub>主题、头像与全局背景自定义</sub></td>
  </tr>
</table>

## 能做什么

- 递归扫描导出目录，识别 JSON、CSV、TXT，并按会话归档和去重。
- 保留原始消息正文、时间、发言人、发言方向、消息类型、平台、会话和头像 URL。
- 按“最后聊天时间”筛选整段会话，或用“严格时间”只提交指定时间段内的消息。
- 对超长会话做连续分段，覆盖全部记录，并在相邻段之间保留少量上下文重叠；不会用固定消息条数随机抽样。
- 支持配置多条独立模型 API 通道，按每条容量对不同会话负载均衡；某条通道限流、网关失败或超时时，其他通道可继续工作。
- 任务和人物采用不同的稳定分段策略：任务请求保持小而快，人物证据使用更宽的时间窗口；协议仍支持兼容客户端在私聊中联合返回两类结果。
- 将模型结果先放入候选审核队列，支持编辑、选择、批量生成、忽略和磨合反馈。
- 同步生成有证据引用的人物卡，缓存导出记录中可访问的头像，并按关系信号排序。
- 用可缩放、可平移、可拖拽归类的任务图展示任务；任务完成状态与行程保持一致。
- 使用开源地图底图和公共地理搜索，支持搜索、选点、拖动、编辑、删除和近似范围。
- 可在选项中切换 OSM DE、OSM Standard 或 HOT 底图，选择自动/Nominatim/Photon 搜索，并限制本机瓦片缓存容量。
- 根据关联人物、任务时间、地点及未来 16 天内可用天气生成行动建议。
- 将大聊天归档、轻量界面状态、INI 设置、图片和日志分开保存，降低大数据量下的同步开销。
- 桌面版默认启用 Chromium GPU 合成；也提供软件渲染故障回退。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | 发布启动器面向 Windows 10/11 x64；源码可自行适配其他桌面系统 |
| Node.js | 最低 `22.12.0`，推荐 Node.js 24 LTS x64；当前验证版本为 `24.13.0` |
| npm | 随受支持的 Node.js 安装，当前验证版本为 `11.18.0` |
| 磁盘 | 建议至少预留 1 GB 安装依赖；聊天、图片和日志另计 |
| 内存 | 建议 8 GB 以上；数十万条聊天记录建议 16 GB 以上 |
| 浏览器 | 浏览器模式推荐最新版 Chrome 或 Edge；目录连接依赖 File System Access API |
| 网络 | 首次安装依赖需要；地图、地点搜索、在线语录、远程头像、天气和模型服务需要 |
| 模型服务 | 可选；使用模型提炼时需要 OpenAI 风格的兼容 API 和有效 API Key |

不要只看“Node 20 LTS 或更高”。当前依赖中的 Electron 43 和 OpenAI JavaScript SDK 7 要求 Node.js 22，因此 `22.12.0` 才是本项目的实际最低版本。

## 快速开始

### 从源码工作区启动

在项目根目录打开 PowerShell：

```powershell
npm install
npm run desktop
```

也可以双击 `启动桌面版.cmd`。脚本会结束由当前项目启动的旧 THEIA 实例和占用本地 API 端口的旧进程，再启动新的桌面窗口。

浏览器开发模式：

```powershell
npm run dev
```

然后打开终端显示的本地地址，通常为 `http://127.0.0.1:5173/`。不要直接双击 `index.html`，因为设置、模型、地图代理和共享存储需要本地 Node.js 服务。

开发检查与发行构建：

```powershell
npm test
npm run test:e2e
npm run test:desktop-smoke
npm run dist:installer
```

`dist:installer` 生成 Windows x64 NSIS 安装器；无签名证书时允许本地未签名构建。正式发行应通过 `CSC_LINK` / `CSC_KEY_PASSWORD` 注入 Windows 代码签名证书，并使用 `GH_TOKEN` 发布 GitHub 更新元数据。

### 从安装器、便携版或源码发布包启动

NSIS 安装器和自带运行时的便携版不需要 Node.js，也不用执行 `npm install`。安装版可从开始菜单或桌面快捷方式启动；可变数据位于 `%APPDATA%\THEIA\`。

源码发布包用于审查和自定义。第一次使用时，在发布包的 `app` 目录打开 PowerShell：

```powershell
npm install
```

安装完成后回到发布包根目录，双击：

- `启动 THEIA 桌面版.cmd`：推荐，独立窗口，支持 GPU 加速。
- `启动 THEIA 浏览器版.cmd`：启动本地服务后，在 Chrome/Edge 中使用。

发布包用户应优先阅读 [用户手册](docs/USER_GUIDE.md)。

## 第一次使用

1. 打开“选项”，先设置显示名称、头像、主题和全局背景。
2. 在“模型通道池”填入 API 根地址和 API Key，并点击检测模型列表；单条 API 受限时可再添加独立通道。
3. 选择用于结构化输出的对话模型，保留 API 模式为“自动”即可。
4. 在“情报库”导入少量示例或自己的一个私聊会话。
5. 打开会话，检查时间、发言人以及“你/对方”方向是否正确。
6. 用严格时间范围做第一次模型提炼，先看候选和人物卡，再扩大范围。
7. 候选确认后生成任务；不合适的候选要选择原因后忽略，磨合记录会影响后续提示。

模型通道与导入格式的完整说明见 [用户手册](docs/USER_GUIDE.md) 和 [聊天导出格式](docs/CHAT_EXPORT_FORMAT.md)。

## 数据如何流动

```text
用户主动导出的 JSON / CSV / TXT
                |
                v
      浏览器内本地解析与去重
                |
                +----> 原始归档（gzip JSONL 分段 / IndexedDB v2）
                |
                v
      用户选择会话、范围并启动提炼
                |
                v
       127.0.0.1:8787 本地代理
                |
                v
          用户配置的模型服务
                |
                v
       候选任务 + 人物证据 + 建议
                |
                v
       用户审核后写入任务和人物状态
```

模型密钥只通过 loopback API 交给本地服务。打包桌面版优先使用 Electron `safeStorage` 加密后写入 `credentials.json`，INI 只保存 `credentialRef`；纯 Node/浏览器开发模式无法使用 Electron 凭据后端时会回退为 INI 明文兼容。无论哪种模式，都应把整个运行时 `data/` 当作敏感数据保护。

## 开发与发布目录

开发工作区为了兼容历史版本，仍使用根目录下的 `.theia-*` 文件。发布包启用清晰的运行时布局：

```text
THEIA-release/
  app/                       应用源码、依赖清单和运行脚本
  assets/img/
    backgrounds/             用户上传的全局背景
    avatars/                 从导出记录下载的联系人头像缓存
  data/
    state.json               任务、人物、地点、候选和任务图布局
    chat-archive/             append-only gzip JSONL 归档段
    chat-archive.json.gz      旧版原始聊天归档，只作为迁移/回滚源
    chat-archive.meta.json    归档 schema、水位、段数和消息计数
    settings.ini             名称、外观、提示词、模型地址和 credentialRef
    credentials.json         桌面版 safeStorage 加密密钥容器
    migrations/              schema 迁移前备份
    electron/                桌面版 Chromium 数据
    runtime/desktop.pid      运行中的桌面实例标记
    examples/                完全虚构的导入示例
  logs/
    ai-debug.jsonl           不含正文的管线摘要日志
    tasks/*.jsonl.gz         按工作单元记录的压缩模型输入/输出日志
  docs/                      用户、开发者、格式、隐私和排错文档
```

工作单元日志可能包含完整聊天正文；`data/`、`logs/`、`assets/img/avatars/` 都不应公开上传。

### 存储压缩与迁移

原始聊天归档现在以 `chat-archive/`（开发目录为 `.theia-intel-store/`）中的 gzip JSONL segment 保存，读取时仍兼容旧 gzip/JSON。首次迁移建立 snapshot segment，并保留旧文件作为回滚源；小规模目录更新追加 delta，不再重写完整归档。达到 24 个 segment 后自动压实为新 snapshot。

已完成的任务日志会压缩为 `*.jsonl.gz`；服务启动时会继续整理超过 10 分钟的旧日志。调试摘要日志限制为约 8 MB，并保留最多 3 个轮转文件，避免长期运行无限增长。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时启动本地 API 与 Vite 浏览器开发服务器 |
| `npm run dev:web` | 只启动 Vite；需要另行启动 API |
| `npm run dev:api` | 只启动 `127.0.0.1:8787` 本地 API |
| `npm run desktop` | 启动 Electron、本地 API 和 Vite |
| `npm test` | 运行 importer、分段、候选、存储、迁移、恢复、前端工具和本地假服务回归；不调用真实模型 |
| `npm run test:e2e` | 运行任务图、拖拽、地图设置和存储健康视觉回归 |
| `npm run test:desktop-smoke` | 用隔离 runtime 验证 Electron 启动和 safeStorage 凭据迁移 |
| `npm run test:unpacked-smoke` | 验证已生成的 `win-unpacked/THEIA.exe` 可以独立启动 |
| `npm run build` | TypeScript 项目构建检查并生成 `dist/` |
| `npm run lint` | 执行 ESLint |
| `npm run preview` | 预览 Vite 构建产物；涉及 API 的功能仍需本地服务 |
| `npm run dev:release` | 在发布布局中启动浏览器版 |
| `npm run desktop:release` | 在发布布局中启动桌面版 |
| `npm run release:index` | 扫描工作根目录中的版本产物，更新发布索引与 SHA-256 清单 |

发布工具：

```powershell
node release-tools/package-release.mjs ..\staging\v0.4.1\THEIA-release-0.4.1
npm run dist:exe -- ..\staging\v0.4.1\THEIA-0.4.1-portable
npm run release:index
```

打包器拒绝覆盖已有目录，也不会复制聊天、设置、密钥、日志、头像缓存、背景历史、浏览器资料、`node_modules`、`dist` 或 Git 元数据。

## 文档索引

- [项目终极目标](docs/PROJECT_VISION.md)（[中英双语 Word 版](docs/THEIA_PROJECT_VISION_BILINGUAL.docx)）：THEIA 为什么存在，以及所有功能和架构必须服务的长期问题。
- [更新报告](docs/RELEASE_NOTES.md)：当前版本重点、兼容性、已知限制与验证结果。
- [用户手册](docs/USER_GUIDE.md)：面向第一次接触命令行和本地模型工具的用户。
- [开发者文档](docs/DEVELOPER_GUIDE.md)：技术栈、模块边界、状态流、模型流水线、API、性能和发布。
- [API 协议参考](docs/API_PROTOCOL.md)：本地 HTTP、模型请求 JSON、session 批处理、通道状态、日志和错误回退的逐字段说明。
- [聊天导出格式](docs/CHAT_EXPORT_FORMAT.md)：推荐 JSON/CSV/TXT 字段、目录结构、发言方向和头像规则。
- [故障排查](docs/TROUBLESHOOTING.md)：启动、端口、GPU、导入、0 候选、502/403、地图和数据恢复。
- [隐私与数据](docs/PRIVACY_AND_DATA.md)：文件敏感等级、模型传输、备份、迁移和问题报告脱敏。
- [版本管理](docs/VERSIONING.md)：工作目录布局、语义化版本、发布步骤、校验、标签和回滚规范。

## 重要边界

- 任务和人物结论来自概率模型，必须由用户审核；THEIA 不能保证没有遗漏或误判。
- 发言方向无法从导出字段可靠确定时，应用会标记为未知；不要靠昵称猜测“你”和“对方”。
- 地图、天气、在线语录和头像地址依赖第三方公共服务，可能受限流、网络或地区影响。
- 自动提炼的最短间隔是 24 小时，且当前需要应用页面保持打开；它不是系统后台服务。
- 当前没有加密数据库。保护 Windows 账户、磁盘和备份介质是用户责任。
- 当前通过版本化 schema、迁移前备份和离线回滚脚本兼容旧状态与归档；跨大版本升级前仍须备份整个运行时目录。

本项目只支持用户授权的导出数据，不提供绕过登录、盗取凭据、解密私人数据库或未授权抓取能力。
