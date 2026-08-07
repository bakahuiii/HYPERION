# HYPERION

[简体中文](README.md) | [English](README.en.md)

HYPERION 是一个本地优先的个人现实任务图工具。它将聊天记录与主动记录整理为可审核的任务、行程、人物和地点信息，并保留可追溯的原始来源。

HYPERION 启动时会自动管理本机 MNEMO 微信适配器。保持本机微信桌面版已登录后，MNEMO 仅在本机检测当前账号数据库、创建只读快照并持续把增量记录交给 HYPERION；不需要 GUI、目录授权或手工密钥捕获，也不联网发送密钥、正文或头像。没有可用微信数据库时会静默等待，只有归档或批次数据异常才会显示错误。只有在你启动模型提炼后，选中的归档记录才会发送到你配置的模型服务。

> 当前源码版本：`0.6.0`。Windows x64 NSIS 安装器、便携版与源码发布包分别生成；安装器和便携版自带 Electron 与 Node.js 运行时，无需另行安装 Node.js，任务、设置、聊天归档和日志保存在 `%APPDATA%\\HYPERION`。重要数据请定期备份。

## 更新日志

**0.6.0**

- 新增 MNEMO 本机微信持续归档：HYPERION 启动、管理和监控独立 sidecar，无需重复手工导入；稳定消息 ID 让重启和重放保持幂等。
- 会话导出统一按“备注优先、昵称回退”命名为 `备注或昵称/备注或昵称.json`；本地头像由 HYPERION 内容寻址缓存并经签名校验后提供。
- 增量写入会触发已有的会话级分析水位检查，下一轮自动分析只携带新消息与有限上下文。

**0.5.0**

- 新增手动日记、每日状态快照和 AI 对话导入；选中“自我”提炼后，可生成带原文来源的长期自我观察。
- 大型聊天归档改为可校验的追加式 gzip JSONL 分段，并加入恢复、分页浏览和大文件解析优化。
- 补齐多通道会话调度、模型工作流可观测性与回归测试；建立多模型裁决的数据契约基础，尚未启用实际多模型并发裁决。

完整历史见 [更新报告](docs/RELEASE_NOTES.md)。

## 界面预览

<p align="center">
  <img src="docs/screenshots/task-atlas.png" alt="HYPERION 可缩放任务图界面" width="100%">
</p>
<p align="center"><sub>可缩放、可平移并支持拖拽归类的任务图</sub></p>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/intel-workbench.png" alt="HYPERION 情报库与模型提炼工作台"><br><sub>聊天归档与模型提炼工作台</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/appearance-customization.png" alt="HYPERION 界面外观自定义"><br><sub>主题、头像与全局背景自定义</sub></td>
  </tr>
</table>

## 能做什么

- 自动检测本机微信数据库，并管理 MNEMO 的静默增量归档、按联系人备注/昵称的可读会话文件和 HYPERION 本地头像缓存；只需保持本机微信已登录。
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

也可以双击 `启动桌面版.cmd`。脚本会结束由当前项目启动的旧 HYPERION 实例和占用本地 API 端口的旧进程，再启动新的桌面窗口。

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

NSIS 安装器和自带运行时的便携版不需要 Node.js，也不用执行 `npm install`。安装版可从开始菜单或桌面快捷方式启动；可变数据位于 `%APPDATA%\HYPERION\`。

源码发布包用于审查和自定义。第一次使用时，在发布包的 `app` 目录打开 PowerShell：

```powershell
npm install
```

安装完成后回到发布包根目录，双击：

- `启动 HYPERION 桌面版.cmd`：推荐，独立窗口，支持 GPU 加速。
- `启动 HYPERION 浏览器版.cmd`：启动本地服务后，在 Chrome/Edge 中使用。

发布包用户应优先阅读 [用户手册](docs/USER_GUIDE.md)。

## 第一次使用

1. 打开“选项”，先设置显示名称、头像、主题和全局背景。
2. 在“模型通道池”填入 API 根地址和 API Key，并点击检测模型列表；单条 API 受限时可再添加独立通道。
3. 选择用于结构化输出的对话模型，保留 API 模式为“自动”即可。
4. 登录本机微信并保持 HYPERION 运行；MNEMO 会自动检测数据库并写入统一归档。
5. 打开会话，检查时间、发言人以及“你/对方”方向是否正确。
6. 用严格时间范围做第一次模型提炼，先看候选和人物卡，再扩大范围。
7. 候选确认后生成任务；不合适的候选要选择原因后忽略，磨合记录会影响后续提示。

微信持续归档的首次设置、状态接口和异常处理见 [MNEMO 集成](docs/MNEMO.md)。情报库的外部 JSON/CSV/TXT 与目录导入目前已停用。

模型通道与使用说明见 [用户手册](docs/USER_GUIDE.md)。[聊天导出格式](docs/CHAT_EXPORT_FORMAT.md) 仅保留为历史兼容参考，当前没有对应的手动导入界面。

## 数据如何流动

```text
本机微信数据库 -> MNEMO 只读快照 -> HYPERION 自有不可变 outbox
                                           |
                                           v
                         原始归档（gzip JSONL 分段 / IndexedDB v2）
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

开发工作区为了兼容历史版本，仍使用根目录下的 `.hyperion-*` 文件。发布包启用清晰的运行时布局：

```text
HYPERION-release/
  app/                       应用源码、依赖清单和运行脚本
  assets/img/
    backgrounds/             用户上传的全局背景
    avatars/                 远程缓存及 MNEMO 本地捕获的联系人头像
  data/
    state.json               任务、人物、地点、候选和任务图布局
    chat-archive/             append-only gzip JSONL 归档段
    chat-archive.json.gz      旧版原始聊天归档，只作为迁移/回滚源
    chat-archive.meta.json    归档 schema、水位、段数和消息计数
    mnemo-inbox/              MNEMO 写入、HYPERION 读取的不可变批次
    mnemo-export/             可读会话副本，按备注或昵称命名
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

原始聊天归档现在以 `chat-archive/`（开发目录为 `.hyperion-intel-store/`）中的 gzip JSONL segment 保存，读取时仍兼容旧 gzip/JSON。首次迁移建立 snapshot segment，并保留旧文件作为回滚源；小规模目录更新追加 delta，不再重写完整归档。达到 24 个 segment 后自动压实为新 snapshot。

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
| `npm run test:unpacked-smoke` | 验证已生成的 `win-unpacked/HYPERION.exe` 可以独立启动 |
| `npm run build` | TypeScript 项目构建检查并生成 `dist/` |
| `npm run lint` | 执行 ESLint |
| `npm run preview` | 预览 Vite 构建产物；涉及 API 的功能仍需本地服务 |
| `npm run dev:release` | 在发布布局中启动浏览器版 |
| `npm run desktop:release` | 在发布布局中启动桌面版 |
| `npm run release:index` | 扫描工作根目录中的版本产物，更新发布索引与 SHA-256 清单 |

发布工具：

```powershell
node release-tools/package-release.mjs ..\staging\v0.6.0\HYPERION-release-0.6.0
npm run dist:exe -- ..\staging\v0.6.0\HYPERION-0.6.0-portable
npm run release:index
```

打包器拒绝覆盖已有目录，也不会复制聊天、设置、密钥、日志、头像缓存、背景历史、浏览器资料、`node_modules`、`dist` 或 Git 元数据。

## 文档索引

- [更新报告](docs/RELEASE_NOTES.md)：当前版本重点、兼容性、已知限制与验证结果。
- [用户手册](docs/USER_GUIDE.md)：面向第一次接触命令行和本地模型工具的用户。
- [开发者文档](docs/DEVELOPER_GUIDE.md)：技术栈、模块边界、状态流、模型流水线、API、性能和发布。
- [API 协议参考](docs/API_PROTOCOL.md)：本地 HTTP、模型请求 JSON、session 批处理、通道状态、日志和错误回退的逐字段说明。
- [聊天导出格式](docs/CHAT_EXPORT_FORMAT.md)：推荐 JSON/CSV/TXT 字段、目录结构、发言方向和头像规则。
- [MNEMO 集成](docs/MNEMO.md)：微信本机持续归档、命名规则、头像存储、状态与排错。
- [故障排查](docs/TROUBLESHOOTING.md)：启动、端口、GPU、导入、0 候选、502/403、地图和数据恢复。
- [隐私与数据](docs/PRIVACY_AND_DATA.md)：文件敏感等级、模型传输、备份、迁移和问题报告脱敏。
- [版本管理](docs/VERSIONING.md)：工作目录布局、语义化版本、发布步骤、校验、标签和回滚规范。

## 重要边界

- 任务和人物结论来自概率模型，必须由用户审核；HYPERION 不能保证没有遗漏或误判。
- 发言方向无法从导出字段可靠确定时，应用会标记为未知；不要靠昵称猜测“你”和“对方”。
- 地图、天气、在线语录和头像地址依赖第三方公共服务，可能受限流、网络或地区影响。
- 自动增量提炼需要应用保持打开。可选择按时间、按新增消息数或两者任一条件触发；首次全库提炼后，后续只提交有变化的会话和必要上下文。
- 当前没有加密数据库。保护 Windows 账户、磁盘和备份介质是用户责任。
- 当前通过版本化 schema、迁移前备份和离线回滚脚本兼容旧状态与归档；跨大版本升级前仍须备份整个运行时目录。

MNEMO 只处理当前 Windows 用户已登录的本机微信账号数据；它不绕过登录、不采集其他账号、不发送密钥，也不提供远程抓取能力。
