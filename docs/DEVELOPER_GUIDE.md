# THEIA 开发者文档

[简体中文](DEVELOPER_GUIDE.md) | [English](DEVELOPER_GUIDE.en.md)

本文面向维护、审查、二次开发和发布 THEIA 的工程人员。内容对应 `0.4.1` 源码版，以 `package-lock.json`、`server/index.mjs` 和当前实现为准，不把规划中的能力写成已经完成的能力。涉及本地 HTTP、模型请求 JSON、session 批处理和日志字段时，以 [API 协议参考](API_PROTOCOL.md) 的逐字段定义为准。

## 1. 项目定位与工程边界

THEIA 当前是单用户、本地优先的个人现实任务图应用。用户主动提供导出文件，本地前端负责解析和选择，本地 Node.js 服务负责持久化、受控媒体代理及模型转发，外部模型只接收用户主动提交的范围。工程实现必须保留时间、来源、发言方向和版本；推断不得伪装成事实；人物刻画不得把零散瞬时状态拼成确定性标签；建议不得演变为预测、评分、操控或道德裁决。

项目明确不实现：

- 绕过微信、QQ、校园平台登录；
- 提取或破解凭据；
- 解密未授权的私人数据库；
- 在后台未提示地抓取聊天或朋友圈；
- 把模型输出当作无需审核的事实数据库；
- 云端账号、多人协作和远程同步。

当前发布形态包含源码包、便携包和 electron-builder NSIS 安装器。已有本地崩溃恢复标记、schema 迁移备份、回滚脚本和 GitHub Release 更新检查；项目没有远程崩溃上报或遥测。Windows 签名是发布环境的可选步骤，本地无证书构建不会失败。聊天正文归档不加密；桌面版 API Key 使用系统凭据加密，纯 Node 开发模式有明文兼容回退。

## 2. 已锁定技术栈

下表来自当前 `package-lock.json` 和已安装依赖，而不是 `package.json` 中的 `latest` 标签。

| 层 | 技术 | 当前版本 | 用途 |
| --- | --- | --- | --- |
| 运行时 | Node.js | 验证于 24.13.0 | 本地服务、脚本、Vite、Electron 主进程 |
| 包管理 | npm | 验证于 11.18.0 | 依赖安装和脚本入口 |
| 前端 | React / React DOM | 19.2.8 | 视图、状态、交互 |
| 语言 | TypeScript | 5.8.3 | 前端及共享类型检查 |
| 构建 | Vite | 8.1.5 | 开发服务器、HMR、生产构建 |
| 桌面壳 | Electron | 43.2.0 | Windows 桌面窗口、Chromium、GPU 合成 |
| 安装/更新 | electron-builder / electron-updater | 26.15.3 / 6.8.9 | NSIS、GitHub Release 更新和可选签名 |
| UI 回归 | Playwright | 1.62.1 | 浏览器视觉/拖拽测试与 Electron smoke |
| 模型 SDK | OpenAI JS | 7.0.0 | 依赖保留；核心兼容请求当前由本地服务直接 `fetch` |
| 地图 | Leaflet | 1.9.4 | OSM 瓦片、标记、范围、拖拽 |
| 图标 | Lucide React | 1.27.0 | UI 图标 |
| 规范 | ESLint 10 / typescript-eslint 8 | 10.8.0 / 8.65.0 | 静态检查 |

实际最低 Node.js 是 `22.12.0`：Vite 8 要求 `^20.19.0 || >=22.12.0`，Electron 43 要求 `>=22.12.0`，OpenAI SDK 7 要求 `>=22.0.0`。推荐统一使用 Node.js 24 LTS，避免开发机和发布机版本漂移。

## 3. 源码结构

```text
.
├─ electron/
│  └─ main.mjs                 Electron 生命周期、GPU 参数和本地服务启动
├─ release-tools/
│  └─ package-release.mjs      生成脱敏源码发布包
├─ scripts/
│  ├─ dev.mjs                  并行启动 API 与 Vite
│  ├─ release-dev.mjs          发布布局的浏览器模式入口
│  └─ release-desktop.mjs      发布布局的桌面模式入口
├─ server/
│  ├─ index.mjs                HTTP API、模型请求、地图/头像代理、日志和快照
│  ├─ providerConfig.mjs       服务地址规范化、模型发现和模式选择
│  ├─ runtimePaths.mjs         开发/发布路径映射
│  └─ settings.mjs             INI 设置、迁移和背景保存
├─ src/
│  ├─ components/              侧栏、顶栏、任务编辑、来源和外观弹窗
│  ├─ hooks/                   shared/settings/AI workflow 状态机
│  ├─ lib/                     导入、分析计划、AI 客户端、存储、地图、天气等
│  ├─ workers/                 大型导出文件后台解析
│  ├─ views/                   任务图、行程、地图、人物、情报库、选项
│  ├─ App.tsx                  顶层状态、共享同步和跨视图编排
│  ├─ seed.ts                  无个人信息的初始示例状态
│  ├─ types.ts                 领域模型与设置类型
│  └─ styles.css               全局主题和视图样式
├─ docs/                       正式文档源
├─ release/                    发布包静态外壳、默认素材和演示数据
├─ public/                     Vite 静态资源
├─ vite.config.ts              React、API 代理和 watcher 排除
└─ package.json
```

`App.tsx` 仍保留领域状态和任务图编排；共享同步位于 `useSharedSync.ts`，通用设置位于 `useSettingsSync.ts`。任务/人物串联、暂停检查点、恢复、失败重试和定时运行位于 `useAiWorkflow.ts`，不得把跨分钟请求闭包重新绑定到渲染时的旧 `data`。`IntelView.tsx` 只编排 `ArchivePanel`、`AnalysisPanel`、`CandidateQueue` 和 `ConversationBrowser`；时间线选择由 `useIntelAnalysisSelection.ts` 负责。

导入器以 1 MiB 为前后台分界：小文件直接调用 `parseIntelFileContent`，大文件通过 module Worker `workers/intelParser.worker.ts` 解析。File 由 structured clone 传入 Worker，结果仍经过同一套 ID、时间、会话和头像规则，Node 测试环境没有 Worker 时自动走直接路径。

### 3.1 大归档存储边界

`server/archiveStore.mjs` 是本机原始聊天归档的写入边界。它按 segment 顺序重放得到内存索引，但磁盘写入只追加一个 gzip JSONL segment：首段 `kind=snapshot`，增量段 `kind=delta`。每段首行是：

```json
{"schema":"theia-intel-archive/v1","schemaVersion":1,"kind":"delta","updatedAt":"2026-08-04T00:00:00.001Z","sourceFingerprint":"sha256:..."}
```

后续行只能是 `{ "op": "upsert", "item": {...} }` 或 `{ "op": "delete", "id": "..." }`。服务端在 `expectedUpdatedAt` 不匹配时返回 409，不能盲写。`/api/sync/intel/delta` 只接受 `upserts`、`deleteIds`、`sourceFingerprint` 和可选 `expectedUpdatedAt`。前端只有在已建立签名基线且变更量较小时使用 delta；否则使用全量 snapshot 兼容路径。

本地浏览器缓存不是归档的权威副本。IndexedDB v2 的 `intelRecords` 以 `id` 为 keyPath，`intelMeta` 保存 `updatedAt/sourceFingerprint/recordCount/schemaVersion`；迁移时旧 `snapshots` 只读不删除，第一次成功写入后再懒升级。

## 4. 运行拓扑

### 4.1 浏览器开发模式

`npm run dev` 执行 `scripts/dev.mjs`，启动两个子进程：

```text
Node local API     127.0.0.1:8787
Vite web server    127.0.0.1:5173（占用时由 Vite 选择其他端口）
```

Vite 把 `/api/*` 代理到 `127.0.0.1:8787`。任一子进程退出时，脚本终止另一个进程；SIGINT/SIGTERM 最多等待 5 秒后强制结束。

### 4.2 Electron 模式

`npm run desktop` 直接运行 `electron/main.mjs`。主进程：

1. 在 `app.ready` 前配置 GPU 或软件渲染参数；
2. 设置独立 `userData` 和 `sessionData` 路径；
3. 获取 Electron 单实例锁；
4. 写入桌面 PID 标记；
5. 在进程内启动本地 API；若 8787 已被兼容开发会话占用则复用；
6. 通过 Vite programmatic API 启动页面服务器；
7. 创建 1600×900、最小 1280×720、16:9 的 BrowserWindow；
8. 禁用菜单、Alt/F10 菜单呼出、Node integration，启用 context isolation 和 sandbox；
9. 退出时关闭 Vite/API 并清理属于当前 PID 的标记。

单实例锁只约束使用同一个 Electron profile 的实例。发布启动器还会读取该发布目录的 `data/runtime/desktop.pid`，只停止对应 Electron 进程。

### 4.3 GPU 策略

默认参数：

```text
enable-gpu-rasterization
enable-zero-copy
enable-features=CanvasOopRasterization
```

设置 `THEIA_SOFTWARE_RENDERING=1` 后调用 `app.disableHardwareAcceleration()`，并追加 `disable-gpu`、`disable-gpu-compositing`、`in-process-gpu`。任务图拖拽用 `requestAnimationFrame` 合并 DOM 写入；Leaflet 使用 `preferCanvas: true`。不要为规避个别驱动错误默认关闭所有用户的 GPU。

## 5. 领域模型

核心类型在 `src/types.ts`。

### 5.1 `IntelItem`

一条本地归档记录，关键字段包括：

- `id`：稳定导入 ID；
- `content` / `summary`：完整消息正文和显示摘要；
- `source`：微信导出、QQ 导出、朋友圈导出、校园平台或本地文件；
- `conversationId` / `conversationName` / `conversationKind`：会话边界；
- `capturedAt`：消息自身时间，不能用文件修改时间代替；
- `speaker` / `speakerRole`：显示名称与 `self | other | unknown`；
- `messageType`：导出器提供的消息类型；
- `avatarUrl`：消息、发言人或 session 中的头像地址；
- `status`：`new | processed | reviewed`。

### 5.2 `AiTaskCandidate`

模型输出的审核中间态，保留标题、描述、开始/截止时间、地点及精度、人物名称、引用消息、行动建议、模型、创建时间和 `pending | created | dismissed` 状态。候选没有对用户展示的“置信度”；程序只执行可解释的过期和执行者校验。

### 5.3 `Quest`

正式任务包含状态、地点、人物、开始/截止、信息源时间、父任务、来源、引用、建议、任务种类、任务图分类和排序。完成任务时保存 `previousStatus`，取消完成后恢复，而不是一律变成 active；父任务解锁的子任务通过 `unlockedByParent` 追踪。

### 5.4 `Person`

人物卡不是联系人表。它由私聊会话和可引用证据构成，包含头像、事实缓冲、偏好信号、建议、画像、会话 ID、引用 ID、最早/最近可核实时间、平台和模型。`peopleModelVersion` 当前为 5；旧版可核验版本 3/4 会在读取时归一化，无法核验的旧人物卡会被清空而不是盲目迁移。

### 5.5 `Place`

地点包含名称、分类、经纬度、备注、`exact | approximate` 精度和可选半径。近似地点同时渲染半透明圆。

## 6. 状态所有权与持久化

THEIA 刻意把大对象和频繁编辑对象分开。

```text
AppData（React 内存）
  ├─ 轻量状态 -> localStorage 缓存 -> shared state JSON
  ├─ 原始 intel -> IndexedDB 缓存 -> gzip chat archive
  └─ profile/appearance/AI settings -> settings.ini
```

### 6.1 浏览器缓存

- localStorage key：`theia-atlas-data-v1`。保存 `AppData` 但强制把 `intel` 写为空数组，避免超大同步阻塞。
- IndexedDB `theia-data/snapshots/intel`：保存原始 `IntelItem[]`。
- IndexedDB `theia-automation/handles/export-directory`：保存 File System Access API 目录句柄。

浏览器缓存是性能和恢复辅助，不是跨浏览器共享的唯一真相。

### 6.2 本地共享文件

开发布局：

| 内容 | 路径 |
| --- | --- |
| 轻量快照 | `.theia-shared-state.json` |
| 原始归档 | `.theia-shared-intel.json.gz`（兼容读取旧 JSON） |
| 通用设置 | `.theia-settings.ini` |
| 摘要日志 | `.theia-ai-debug.log` |
| 工作日志 | `.theia-task-logs/` |
| 头像缓存 | `.theia-avatar-cache/` |
| 背景 | `.theia-backgrounds/` |
| Electron profile | `.theia-user-data/` |

发布布局由 `THEIA_RELEASE_LAYOUT=1` 和 `THEIA_RUNTIME_ROOT` 激活：

| 内容 | 路径 |
| --- | --- |
| 轻量快照 | `data/state.json` |
| 原始归档 | `data/chat-archive/*.jsonl.gz`（旧 `chat-archive.json.gz` 保留作迁移/回滚源） |
| 通用设置 | `data/settings.ini` |
| 摘要日志 | `logs/ai-debug.jsonl` |
| 工作日志 | `logs/tasks/` |
| 头像缓存 | `assets/img/avatars/` |
| 背景 | `assets/img/backgrounds/` |
| Electron profile | `data/electron/` |
| PID | `data/runtime/desktop.pid` |

### 6.3 写入一致性

- JSON 采用同目录 `.tmp` 写入后 `rename` 的原子替换策略。
- shared state 写入通过进程内 Promise queue 串行化，避免桌面与浏览器同时复用临时文件。
- 快照带 `updatedAt`；渲染器轮询元数据，避免旧页面关闭时覆盖更新快照。
- 原始聊天从 shared state 中剥离；读取旧快照时兼容迁移内嵌 `intel`，之后不再随 UI 状态反复写入。
- 设置以 URL 编码的 INI v4 保存，允许提示词包含换行和 `=`；旧 v2/v3/legacy provider 会在读取时迁移。v4 增加地图服务配置和桌面凭据引用。

这不是事务数据库。若未来支持多用户、后台写入或多进程并发，应迁移到 SQLite，并为 schema、事务和备份建立正式层。

## 7. 导入流水线

入口为 `src/lib/importer.ts` 和 `src/lib/directorySync.ts`。

### 7.1 文件发现

- 扩展名：JSON、CSV、TXT；
- 最大 20,000 文件；
- 最大深度 24；
- 单文件最大 50 MB；
- 签名：导入器版本 + 路径 + 文件大小 + `lastModified`；
- 当前签名版本：`session-avatar-v1`。

一个分类文件夹下一层被视为会话身份。例如 `私聊/A/data/messages.json` 与 `私聊/A/media/index.json` 都归入 `私聊/A`，不会被误算成两个会话。

### 7.2 JSON

递归遍历对象/数组，继承上层时间、发言人、头像、类型和方向上下文。记录层找到正文后停止继续把其子字段重复当作消息。没有识别到结构化消息时，最后才把 JSON 扁平化为文本行，这种降级模式不保证方向和时间。

### 7.3 CSV

内置支持带引号、逗号和 CRLF 的简易 CSV 解析器。首行必须能映射正文列；否则降级为 TXT 行解析。它不是通用 RFC 4180 库，复杂编码、嵌套换行和超大 CSV 应先转换为推荐 JSON。

### 7.4 TXT

识别以完整年份开头的时间戳，并支持 `发言人: 内容`。没有完整年份的 `07-29 01:48` 无法独立确定年份，推荐导出器补全年份。

### 7.5 时间和方向

时间支持秒/毫秒 epoch、`YYYY-MM-DD HH:mm:ss`、中文年月日等。无法解析时保持空字符串；文件修改时间绝不替代聊天时间。

方向优先使用导出器字段：`isSelf`/`isSend` 等布尔值、direction 枚举，或 `selfId === senderId`。昵称不是可靠方向证据。字段映射及示例见 [聊天导出格式](CHAT_EXPORT_FORMAT.md)。

## 8. 会话计划与超长上下文

`src/lib/conversationAnalysis.ts` 先按 `conversationId` 分组。缺失会话 ID 的旧记录按“平台 + 月份”组成显式 legacy 桶，避免把几十万条记录拼成一个伪会话。

### 8.1 排序

会话内按 `capturedAt` 升序。无效时间排在有效时间后，并在模型提示中明确不可推断相对日期。

### 8.2 动态字符预算

每条估算大小：

```text
max(96, content.length + capturedAt.length + speaker.length + type.length + 72)
```

父会话预算使用对数曲线：

```text
scale  = log2(max(2, totalEstimatedChars / 55,000))
budget = clamp(round(48,000 / max(1, scale)), 14,000, 34,000)
```

长会话因此产生更多、较小的请求，避免固定“最多 180 条”这类与实际 token 无关的上限。

### 8.3 连续覆盖与重叠

核心区间顺序覆盖所有记录。每个非首段向前附带最多 24 条且最多约 4,000 字符。模型只允许从本段 `coreRecordIndexes` 生成任务，重叠记录只提供指代和语义连续性。统计中的 `recordCount` 只累计核心消息，不重复计算 overlap。

### 8.4 时间优先级

最近 3/7/14/30/60/120/365 天分别获得递减相关性。核心最后时间早于 61 天的段标记 `historical`，仍会处理人物和长期事实，但任务提示只允许明确未完成、仍有效或未来日期事项。所有最近段先于历史段执行。

“全量覆盖”应理解为每条所选消息都进入某个核心段，不应描述成“整个会话一定只有一次 HTTP 请求”。

## 9. 模型任务流水线

### 9.1 本地客户端

`src/lib/aiClient.ts` 将 `ConversationAnalysisJob` 转换为请求，保留：

- 会话 ID、名称、类型和父会话总记录数；
- 段号、段总数、核心记录索引、历史标记；
- 每条记录的原始 ID、时间、类型、正文、发言人和方向；
- AI 模式、时效策略、自定义提示和最近磨合记录；
- 第一段附件。

单次失败最多尝试 5 次。可重试类别是 408、409、425、429、5xx、网络 `TypeError` 和常见 gateway/timeout 文本。退避以几百毫秒开始，尊重服务端 `retry_after`，可由 AbortSignal 中断。

### 9.2 本地服务校验

`server/index.mjs` 限制：

- HTTP JSON body 最大 256 MB；
- 至少一条记录；
- 会话声明的段记录数必须与实际一致；
- 核心索引必须位于本段范围；
- 最多 4 个附件；
- 每个附件不超过 8 MB；
- 每条必须有 ID 和非空正文。

模型输入把每条记录压缩为：

```json
["RecordRef", "formattedTime", "type", "content", "senderDisplayName", "speakerRole"]
```

短 `RecordRef` 减少重复长 ID 和 JSON 键名的 token 开销。模型响应返回引用号后，服务端恢复原始 ID。

### 9.3 提示词层次

服务端构建提示包含三层：

1. 不可被用户覆盖的硬约束：执行者、时间、引用、历史段、核心段、JSON contract；
2. 应用设置：模式、时效策略、候选磨合反馈；
3. 用户可编辑的任务补充指令。

四个可编辑框分别进入任务提炼、人物提取、人物归并和任务建议。它们不能修改 schema 或撤销硬约束。

### 9.4 结构化输出

任务 schema 要求：`title`、`description`、`startAt`、`dueAt`、`sourceIds`、`people`、`place`、`locationPrecision`、`locationRadiusMeters`、`tags`、`guidance`、`actionOwner`。未知标量用 null，未知数组用 `[]`，`actionOwner` 必须为 `self`。

私聊请求携带 `workflows: { tasks: true, people: true }`，联合 schema 返回 `candidates`、`people` 和 `peopleIncluded`。`peopleIncluded` 表示服务端是否成功解析了人物工作流，与 `people.length` 无关；合法的空人物结果仍是 `true`。群聊 schema 只返回 `candidates`。

Responses API 使用 `text.format` JSON schema；Chat Completions 使用 `response_format: json_schema`。兼容通道返回明确的 schema 400/422 时降级为 `json_object`，随后仍在本地规范化和验证。

任务-only 输出上限 3,000 tokens；任务+人物联合输出 3,200；人物证据接口 2,400；人物归并 1,800；任务建议 1,200。

### 9.5 API 模式回退

`auto` 先请求 `<base>/responses`。只有 404、405、415、501，或 400/422 正文明确说明 Responses endpoint/structured output 不受支持时，才改用 `<base>/chat/completions`。502、503、504、超时和网络错误不会在同一个服务内复制大请求到另一种 API 模式，而是让通道进入冷却并交给客户端重试。明确选择 responses/chat-completions 时不跨模式回退。

### 9.6 候选本地校验

前端恢复引用后验证：

- 所有 source ID 必须对应输入记录；
- 执行者必须是 self；
- 明显将对方邀请反写成“你请对方”会被拒绝；
- 快递、取件等短时事项没有未来目标时间时，按 2/4/7 天策略过期；
- 报名、投稿、问卷等无截止事项按 14/30/60 天策略过期；
- 有明确未来时间的任务不因消息较旧自动删除。

这里没有伪精确“置信度”。丢弃原因会转为可查看、可删除的磨合记录。

### 9.7 多通道调度

`withProviderChannel()` 为分析、旧人物、人物归并和任务建议统一申请通道 lease。调度队列按以下规则工作：

1. 只考虑 `enabled`、有 API Key 且配置有效的通道；
2. 排除达到 `maxConcurrency` 或仍在冷却的通道；
3. 优先选择 `activeRequests / maxConcurrency` 最低的通道；
4. 负载相同时按最久未选中、主通道、稳定 ID 的顺序打破平局；
5. 完成后释放槽位并唤醒 FIFO 等待队列。

429、502、503、504、524、网络错误和超时只增加当前通道及其共享 origin 的失败计数，并触发 250 ms 起步、最多 2 秒的指数冷却。客户端随后重试 `/api/ai/analyze` 时会重新申请 lease，因此可能切到另一通道；服务端不会把一个请求广播到所有通道，也不会把上游的长 `Retry-After` 原样变成本地长时间冻结。`/api/ai/status` 的顶层 `configured` 表示“至少一条启用且有效的通道存在”，不能只反映主通道。

## 10. 人物流水线

人物分析只处理 `conversationKind === direct` 的会话。导入后先建立目录核验的占位卡，避免长模型任务期间人物列表完全为空；丰富事实必须通过模型并引用原消息。

### 10.1 请求策略

- 使用与任务相同的连续会话分段；
- 本地默认任务路径把 `workflows.people` 设为 `false`，先用任务分段处理；随后使用 `/api/ai/people` 的宽窗口人物路径，避免任务 schema 和人物 schema 互相挤占上下文预算；
- `/api/ai/analyze` 仍支持兼容客户端对 `kind=direct` 设置 `workflows.people=true`，此时服务端返回 `peopleIncluded` 和联合 schema；这不是当前内置批处理的默认策略；
- 不同会话按用户设置并行，同一会话的片段保持串行；
- 每个结果必须引用本段实际记录；
- 记录方向为 self 时只可用于关系上下文，不可当成对方事实；
- 同名人物只有在会话 ID 或证据重叠时合并，不只靠名称合并。

### 10.2 归并

人物 facts 是最多 48 条的内部证据缓冲，UI 主要显示收敛后的 portrait/preferences/advice。自动更新有三层增量边界：会话 fingerprint 只选择已发生变化的私聊；`incrementalConversationRecords` 只提交新增消息及每条新增消息之前最多 16 条上下文；`mergePersonEvidence` 按已核验 claim/source 去重，只有 evidence signature 改变才失效并重新生成 portrait。归并仍读取该人物的完整已核验证据，以免局部文本覆盖旧画像，但不会重发原始聊天；请求期间新写入的证据会使旧响应失效并重新排队。每个人最多自动重试 3 次，避免无限归并循环。

### 10.3 头像

导入器先从消息、sender/profile/contact/userInfo、顶层 session 等位置找头像。前端把远程 URL 改写到 `/api/media/avatar`。服务端仅允许 QQ/微信图床域名及其受控重定向，最多 3 次重定向、12 秒、受支持图片 MIME 和大小限制；成功后按 URL SHA-256 缓存图片与元数据。

未知网站头像不会由代理任意抓取，这是 SSRF 防护的一部分。上传的用户头像复用背景资产接口，不走远程头像白名单。

## 11. 任务建议刷新

任务建议上下文由任务字段、关联人物事实/偏好/画像、地点和可选天气组成。天气仅在任务目标日期是今天至未来 16 天且有坐标时，通过 Open-Meteo 获取。

应用为任务和关联人物生成稳定 evidence signature。人物事实或任务的时间/地点发生实质变化后，签名变化；后台 effect 以 10 分钟节流周期尝试刷新建议。没有关联人物、没有模型通道或请求失败时不会破坏旧建议。用户也可在任务图中手动生成。

## 12. 地图、搜索与在线资源

### 12.1 底图

Leaflet 请求本地 `/api/map/tiles/{z}/{x}/{y}.png?provider=&cacheMaxMb=`。服务端验证 z 0-19、x/y 边界、provider 白名单和 32–1024 MiB 缓存范围。可选底图：

1. `tile.openstreetmap.de`
2. `tile.openstreetmap.org`
3. `a.tile.openstreetmap.fr/hot`

所选源优先，失败后才尝试其他白名单源。瓦片以扁平安全文件名写入 `mapTileCacheDirectoryPath`；每次写入通过同一串行维护队列按 mtime 淘汰旧文件，容量由 INI `[map].cacheMaxMb` 决定。只允许交互式访问，不实现批量预取；UI 始终显示 OpenStreetMap attribution，并提供各服务政策链接。

### 12.2 地理搜索

`/api/map/search?q=&provider=` 至少两个字符、最多 180 字符。`balanced` 并行查询 Nominatim、Photon、ArcGIS World Geocoder、Wikidata 和 Open-Meteo，采用最先返回的有效结果；`nominatim`/`photon` 只调用指定服务。每个提供者约 7 秒超时，最终最多返回 12 条去重坐标。

`GET/POST /api/map/config` 读取或保存 `tileProvider`、`searchProvider`、`cacheMaxMb`。响应还包含可展示的 provider 名称、policy URL、attribution 和 usageNotice；POST 只返回归一化后的三项设置。

只有搜索词发送给第三方；任务标题、人物和地点备注不发送。公共服务无 SLA，应保留手动选点。

### 12.3 在线语录

`/api/quote` 请求 Hitokoto，5 秒失败后使用内置三条离线句库。它不影响核心任务功能。

## 13. 本地 HTTP API

服务只监听 `127.0.0.1`，默认端口 8787；CORS 仅允许 localhost/127.0.0.1 的 HTTP(S) origin。所有 JSON 响应使用 UTF-8 和 `cache-control: no-store`，图片路由单独设置缓存。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/ai/status` | 返回可编辑通道池、每通道运行状态和调度容量 |
| GET/POST | `/api/ai/channels` | 列出通道或创建新通道；`/providers` 是等价别名 |
| POST/PUT/PATCH | `/api/ai/channels/:id` | 更新、启停、设主通道或刷新模型列表 |
| DELETE | `/api/ai/channels/:id` | 删除一条通道；至少保留一个配置槽 |
| POST | `/api/ai/config` | 兼容旧客户端：更新当前主通道 |
| DELETE | `/api/ai/config` | 兼容旧客户端：重置当前主通道 |
| POST | `/api/ai/models` | 只探测模型列表 |
| POST | `/api/ai/analyze` | 分析一个会话段；私聊可联合返回任务与人物 |
| POST | `/api/ai/people` | 旧兼容路径：单独分析一个人物会话段 |
| POST | `/api/ai/people/merge` | 收敛已核验人物笔记 |
| POST | `/api/ai/task-guidance` | 生成或刷新任务建议 |
| GET/POST | `/api/settings` | 读取/保存 profile、appearance、AI settings |
| POST | `/api/settings/background` | 保存不超过 20 MB 的图片资产 |
| GET | `/api/settings/background/:id` | 读取已保存背景/用户头像 |
| GET | `/api/sync/snapshot` | 读取轻量共享快照 |
| POST | `/api/sync/snapshot` | 原子保存轻量共享快照 |
| GET | `/api/sync/meta` | 读取快照时间和归档消息数 |
| GET | `/api/storage/overview` | 返回运行时数据路径、大小和条目数 |
| GET | `/api/media/avatar?src=` | 白名单代理并缓存 QQ/微信头像 |
| GET | `/api/map/tiles/:z/:x/:y.png` | 代理公共 OSM 瓦片 |
| GET | `/api/map/search?q=` | 多源公共地理搜索 |
| GET | `/api/quote` | 在线语录及离线回退 |

本 API 未设计为局域网或公网服务。不要将 8787 反向代理到外网；它没有用户认证，并且设置 API 可向本机界面返回已解密 Key 供编辑。

## 14. 日志与可观测性

### 14.1 摘要日志

`ai-debug.jsonl` 每行一个 JSON，记录时间、事件、会话/段、记录数量、模式、耗时、候选统计和错误。它有意排除正文、附件 data URL、请求头和 Key，适合先做管线定位。

### 14.2 工作单元日志

`logs/tasks/YYYYMMDD-HHmmss-mmm-kind-label-digest.jsonl.gz` 记录：

1. schema `theia-task-log/v1`、开始时间、kind 和完整本地请求；
2. 完成、失败或回退事件；
3. 模型解析结果及错误细节。

文件名带本地时间、工作类型、清理后的会话标签和随机摘要。Key/token/authorization 字段会替换为 `[redacted]`，data URL 附件正文替换为大小说明；聊天正文仍然保留，因此工作日志是高敏感数据。

### 14.3 诊断顺序

1. UI 工作摘要：确认卡在哪个会话/段/人物阶段；
2. `ai-debug.jsonl`：确认请求是否到达本地服务、是否重试/回退；
3. 对应 task log：核对输入方向、时间、核心索引和模型原始返回；
4. 终端 stderr：看 Node、Vite、Electron、TLS 和端口错误；
5. 必要时对单一会话 + 严格时间复现。

## 15. 设置和模型配置

INI v4 分为 `[meta]`、`[profile]`、`[appearance]`、`[ai]`、`[map]`、兼容主通道 `[provider]` 和通道池 `[providers]`。`[providers] channels` 保存通道数组，`primaryId` 保存主通道；桌面版通道只写 `credentialRef`，密钥密文放在凭据容器。所有值 URL encode，JSON 子对象再整体编码。写入前做长度、枚举、URL 和数值归一化。

启动优先级：已有 INI > 一次性迁移 legacy provider > 环境变量默认值。环境变量：

```text
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENAI_API_MODE=auto|responses|chat-completions
AI_PORT=8787
THEIA_RELEASE_LAYOUT=1
THEIA_RUNTIME_ROOT=<release-root>
THEIA_SOFTWARE_RENDERING=1
```

打包 Electron 的本地服务运行在主进程，可调用 `safeStorage`：INI 保存 `credentialRef`，密文写入 `credentials.json`。纯 Node 开发/浏览器入口没有 Electron 后端时保留 INI 明文回退。测试和日志不得输出任一形态的 Key。

## 16. 性能策略

- 原始 intel 不进入 localStorage 和 shared UI snapshot。
- 会话计划按字符而不是消息条数切分，避免短消息和巨型消息使用同一上限。
- 最近段优先，用户可更快看到有价值候选。
- 默认任务与人物分离上传：任务使用小分段，人物使用宽窗口；仅兼容客户端显式请求联合 schema 时才复用一次上游输入。
- 客户端全局并发范围 1–64；服务端再按每通道 1–8 的容量和共享 origin 容量限流。增加独立通道可以提高不同会话吞吐，但同一会话片段仍串行。人物证据提炼和人物归并现在使用同一全局并发配置，不再固定为 4 或 8。
- 任务分段默认最多 48 条核心记录或约 4,000 个紧凑行字符，并保留最多 6 条/1,000 字符 overlap；人物分段默认最多 320 条或约 24,000 个字符，并保留最多 16 条/3,000 字符 overlap。核心记录完整覆盖，overlap 不重复计入进度。
- 任务提示的固定前缀保持稳定，动态日期、分段元数据、反馈和记录放在尾部，方便支持 prompt cache 的模型复用前缀。
- 人物聊天浮窗和人物列表使用虚拟窗口，避免一次渲染数万 DOM 节点。
- 任务图拖拽、缩放和平移尽量通过 rAF 和 CSS transform 写入，结束时才提交 React 状态。
- Leaflet 使用 canvas 偏好；Electron 默认 GPU 加速。
- 大于 1 MiB 的 JSON/CSV/TXT 通过 module Web Worker 解析，避免 `JSON.parse`、CSV 扫描和消息归一化长时间占用 renderer。
- 快照写入和设置写入分别有 250 ms、350 ms 防抖。
- 头像首次发现时预取并落本地缓存，降低人物页首次打开抖动。

继续优化前应先用 Chrome Performance/Memory profile 找热点。当前 Worker 阈值应通过大文件基准调整；不要为了小文件盲目创建 Worker。大对象 stringify、React 顶层状态更新和超长日志写入仍比图标渲染更值得测量。

## 17. 开发、检查与构建

安装：

```powershell
npm install
```

建议日常命令：

```powershell
npm run dev
npm run desktop
npm run lint
npm run build
npm run test:e2e
npm run test:desktop-smoke
node --check server/index.mjs
node --check electron/main.mjs
```

`npm run build` 先执行 `tsc -b`，再运行 Vite build。`npm test` 覆盖 importer、会话分段、候选校验、浏览器存储、append-only archive、schema 迁移/回滚、崩溃恢复/日志轮转和通道池；所有集成测试使用一次性 `THEIA_RUNTIME_ROOT`，不读取本机聊天、INI 或真实 API Key。

`npm run test:e2e` 使用 Playwright 和隔离 API/Vite 端口，验证任务图视觉基线、缩放、主题拖拽、拖拽后无文本选择、地图设置和存储健康 UI。Windows 有 Edge 时直接使用系统 Edge，否则使用 Playwright 安装的 Chromium。`npm run test:desktop-smoke` 启动源码 Electron，验证首页、独立 runtime、`safeStorage` 明文 Key 迁移和无明文落盘。生成 unpacked 目录后，`npm run test:unpacked-smoke` 会实际启动打包后的 `THEIA.exe`。不要把视觉快照自动更新当作通过；必须人工查看图片后再提交。

仍建议补充的测试：

- 人物证据引用校验与同名会话隔离；
- provider URL 规范化和 API 模式回退；
- 地图搜索结果 bounds/precision/radius。

## 18. 发布流程

### 18.1 发布前清单

1. 确认 `package.json` 版本和 release notes。
2. 运行 test、lint、build 和 Node syntax check。
3. 用虚构数据启动桌面版与浏览器版。
4. 验证模型配置、单一会话、停止/重试、人物阶段、任务生成、地图和重启持久化。
5. 搜索真实昵称、API Key、服务域名、绝对用户路径和聊天片段。
6. 确认发布模板只含通用 SVG/示例。
7. 选择一个不存在的目标目录运行打包器。

### 18.2 打包器

```powershell
node release-tools/package-release.mjs ..\staging\v0.4.1\THEIA-release-0.4.1
```

打包器要求目标在源码目录之外且不存在，避免误覆盖。它复制必要源码、锁文件、发布文档、默认资源和虚构示例，并生成 `RELEASE_MANIFEST.json`。明确排除：

- 聊天归档、任务、人物、地点和候选；
- API Key 与模型通道设置；
- Electron/浏览器 profile；
- 摘要日志和完整任务日志；
- 下载头像和用户背景；
- `node_modules`、`dist`、Git 元数据和 npm cache。

发布后在目标目录运行 `npm --prefix app install` 和一次 build。若压缩为 ZIP，应记录文件大小和 SHA-256；不要覆盖旧 ZIP 后仍沿用旧校验值。

### 18.3 Windows 安装器、签名与更新

标准安装器：

```powershell
npm run dist:installer
```

electron-builder 输出到 `release-bin/installer/`，使用 `asar` 和 Windows x64 NSIS assisted installer；允许选择安装目录，创建桌面/开始菜单快捷方式，卸载默认不删除 `%APPDATA%\THEIA`。构建优先复用 `node_modules/electron/dist` 中已由 npm 安装的同版本 Electron，避免重复下载大型运行时；NSIS 工具链首次仍从 electron-builder 官方 GitHub Release 获取并校验固定 SHA-256。`npm run dist:unpacked` 只生成 unpacked 目录，适合发布前烟测。原有 `npm run dist:exe` 便携构建继续保留，两条路线不能混用更新元数据。

正式签名构建在干净 CI 中注入：

```text
CSC_LINK=<base64、HTTPS URL 或证书文件路径>
CSC_KEY_PASSWORD=<证书密码>
GH_TOKEN=<仅发布 GitHub Release 时使用>
```

仓库不保存 PFX、密码或 token。`win.forceCodeSigning=false` 只为本地开发保留未签名构建能力；公开发行应把“缺少签名”作为 CI 失败条件。GitHub publisher 固定为 `bakahuiii/THEIA`。electron-builder 生成 `app-update.yml` 和 `latest.yml`；Electron 仅在 packaged 且存在 `app-update.yml` 时调用 electron-updater。更新下载后询问立即重启，选择稍后则在正常退出时安装。

自动更新不能替代数据 schema 回滚。应用升级前仍应备份 runtime；应用二进制可回退，但新版本已经迁移过的数据必须通过 `migrations/` 和 `npm run data:rollback` 单独处理。

## 19. 修改数据结构时的规则

1. 先更新 `src/types.ts`。
2. 更新 `seed.ts` 的中性默认值。
3. 在 `storage.ts` 明确旧字段的归一化或丢弃策略。
4. 检查 shared snapshot 是否应包含该字段；原始大数据不能重新塞回 snapshot。
5. 更新 server settings 或 runtime path（如涉及）。
6. 更新任务/人物日志 schema 或保持向后兼容。
7. 添加/更新文档路径表与隐私等级。
8. 用重启、桌面/浏览器互通和旧数据样本验证。

不要用 `JSON.parse(JSON.stringify(...))` 无意识地吞掉日期、undefined 或超大数据，也不要在异步模型回调中直接读取闭包中的旧 `data`；跨分钟任务应读取 `dataRef.current` 或使用函数式 state update。

## 20. 已知风险与后续优先级

`0.4.1` 在 `0.4.0` 的存储与可靠性基础上，增加了重叠分段安全去重、以人为中心的人物搜索与排序、联系概览、来源感知的对话预览和受约束的人际建议。仍需继续处理：

- 将 `App.tsx` 中人物归并、任务建议和领域 reducer 继续拆成可单测模块；
- 为地图缓存加入命中率/清理统计和显式“清空地图缓存”；
- 增加 macOS/Linux 安装验证，以及 CI 中的 Windows EV/OV 证书签名和发布审批；
- 为附件识别增加每个文件的运行状态、失败重试和真实 provider usage 回填；
- 在百万级实际数据上建立导入耗时、内存峰值、归档 compaction 和恢复时间基准。

THEIA 仍是单用户本地应用，不承诺无上限规模、任意导出格式、任何公共服务 SLA 或所有 OpenAI 兼容中转完全一致。新增协议必须继续保留 0.3.0 的并发、2 秒本地退避和 502 请求稳定基线。
