# THEIA 故障排查手册

本手册按“现象 -> 判断 -> 处理 -> 日志证据”组织。先用最小范围复现，不要在 30 万条记录上反复试错。

## 1. 先收集这五项信息

在报告问题前记录：

1. 运行方式：源码/发布包，桌面版/浏览器版。
2. `node --version` 和 `npm --version`。
3. 操作发生在哪个页面、哪个会话、哪个时间范围。
4. UI 工作浮窗和终端最后一条有意义错误。
5. `logs/ai-debug.jsonl` 与对应 `logs/tasks/*.jsonl.gz` 的事件名，但分享前必须脱敏。

不要公开 API Key、真实聊天、头像 URL、精确位置或 `settings.ini`。

## 2. 安装问题

### `npm` 或 `node` 不是命令

Node.js 没安装或新 PATH 尚未进入当前终端。安装 Node.js 22.12+（推荐 24 LTS），关闭所有终端后重新打开，再运行：

```powershell
node --version
npm --version
```

### `npm install` 报 engine 不支持

Node 版本太旧。Node 20 即使能安装部分包，也不满足 Electron 43/OpenAI SDK 7。升级到 Node 22.12+，在项目目录重新运行 `npm install`。

### 下载慢或中断

先检查 npm registry 和网络，不要立刻删除已下载内容。`npm install` 会使用缓存并恢复未完成依赖。若组织网络使用镜像，确认镜像可信、包含 Electron 二进制且没有篡改 lockfile。发布验收应使用 `npm ci` 复现锁文件。

### `EPERM`、`EBUSY` 或文件被占用

关闭 THEIA、Vite、编辑器中正在扫描 `node_modules` 的插件和可能锁文件的杀毒软件窗口，再重试。不要用管理员权限作为第一反应；先确认是哪一个进程持有路径。

## 3. 启动问题

### `Lock file can not be created! Error code: 32`

Electron profile 正被另一实例使用。发布版用根目录启动脚本结束该发布目录的旧 PID。若仍失败：

1. 关闭所有 THEIA 窗口。
2. 在任务管理器确认没有对应 Electron 进程。
3. 确认没有同时从两个终端启动同一发布目录。
4. 退出后备份并删除仅该发布目录的 `data/runtime/desktop.pid`；不要删除整个用户目录。

### `Port 5173 is in use`

Vite 会自动选择下一个空闲端口，通常不是错误。桌面主进程读取 Vite 实际 URL。浏览器版应打开终端最终显示的新地址，不要固守 5173。

### 8787 被占用或 `/api/*` 失败

8787 是本地 API。源码启动脚本会清理属于当前项目的旧 Node/Electron listener；发布启动器只处理当前发布目录。检查：

```powershell
netstat -ano -p tcp | Select-String ':8787'
```

确认 PID 后用任务管理器识别进程。不要盲目结束所有 Node 进程，它们可能属于其他开发项目。

### Vite `EBUSY ... Cookies` watcher 错误

当前 `vite.config.ts` 已排除 `.theia-user-data/**` 和 `data/electron/**`。如果仍出现，确认运行的是新版本配置，并且 `THEIA_RUNTIME_ROOT` 没有错误指向源码树内未被排除的其他 Chromium profile。

### Electron cache `Unable to create cache`

通常是旧实例仍持有 profile、目录权限不足或杀毒软件锁定。先关闭旧实例，用项目/发布启动器重新打开。当前 Electron 设置独立 userData/sessionData；不要给两个发布副本配置同一个 `THEIA_RUNTIME_ROOT`。

## 4. 窗口、GPU 和卡顿

### 黑屏、花屏或 GPU process 崩溃

更新显卡驱动。临时用软件渲染验证：

```cmd
set THEIA_SOFTWARE_RENDERING=1
启动 THEIA 桌面版.cmd
```

若软件渲染正常，问题多半在 Chromium/驱动。软件模式任务图和地图会更卡，不应长期作为性能方案。

### 任务图拖拽卡

1. 确认没有开启软件渲染。
2. 关闭大模糊背景和轻微视差。
3. 重置任务图缩放。
4. 检查任务数量；数百个节点同时围绕主题会增加布局开销。
5. 打开 DevTools Performance，区分 React commit、layout、paint 和 JSON 持久化。

不要把所有卡顿都归因于 GPU。`state.json` 过大、每次状态更新序列化、超长人物列表和日志写入也可能造成主线程停顿。

### 侧边出现滚动条或窗口比例异常

桌面最小尺寸 1280×720，并设置 16:9。Windows 显示缩放过高时，实际 CSS viewport 可能不足。先将窗口最大化或把系统缩放临时降到 125%；再检查是否有系统字体覆盖导致控件增高。

## 5. 数据没有保存

### 重启后任务或人物消失

发布版检查：

```text
data/state.json
data/chat-archive.json.gz
data/settings.ini
```

在“选项 -> 数据与存储”确认应用显示的 workspace 是当前发布目录，而不是另一个复制件。常见原因：

- 从源码和发布目录分别启动，实际用了两套数据；
- `THEIA_RUNTIME_ROOT` 指向别处；
- 目录只读或被同步软件占用；
- 关闭窗口时另一个旧页面写回旧快照；
- JSON 写入时磁盘满或杀毒软件锁 `.tmp`。

先复制整个运行时目录做备份，再检查 JSON 是否有效。不要在没有备份时手工修复大文件。

### 浏览器版和桌面版不同步

确认它们从同一发布根目录启动并访问同一 8787 API。浏览器地址如果来自另一份源码的 Vite，会看到不同数据。等待至少一个保存防抖周期，再刷新；仍不一致时查看 `/api/storage/overview` 对应的 workspace 路径。

### `write ECONNRESET` 出现在 `/api/sync/snapshot`

渲染器或本地 API 在写快照期间关闭/重启。偶发一次不一定丢数据；反复出现说明 8787 进程崩溃、被启动脚本反复杀掉或 JSON 过大。检查终端错误和 `state.json` 大小，确认原始 `intel` 没被重新塞进轻量快照。

## 6. 目录和导入问题

### 只能检测到少量会话

检查目录层次。THEIA 以 `私聊/A` 或 `群聊/B` 为会话，不以每个 JSON 文件为会话。若所有文件都位于 `私聊/` 根下，它们可能共享不正确边界。推荐一个会话一个子文件夹。

其他限制：单文件 50 MB、最多 20,000 文件、深度 24、只支持 JSON/CSV/TXT。被跳过文件不会自动变成会话。

### 记录数、会话数、上下文数看不懂

- 记录数：唯一原始消息数。
- 会话数：按 `conversationId` 分组后的聊天数量；无 ID 旧数据按平台+月份形成 legacy 桶。
- 分段/工作单元数：模型请求数，超长会话可对应多个连续段；它不是额外聊天，也不会重复计入核心记录。
- overlap：相邻段为理解上下文重复携带的少量消息，不算新的原始记录。

### 重新扫描得到 0 新记录

如果文件路径、大小、修改时间和导入器版本没变，这是正常去重。若确实新增了消息但导出工具没有更新文件修改时间，先让导出器正确写文件元数据，或重新导出到新文件名。

### 时间都为空或错一年

导出只有 `07-29` 而没有年份，或 timestamp 单位错误。检查原始 JSON。10 位数按秒、13 位数按毫秒；不要把 Excel 序列号或纳秒直接放到 timestamp。

### “你”和“对方”颠倒

这是输入结构问题，优先级高于提示词。检查 `isSelf`、direction，或 selfId/senderId。不要通过改昵称和提示词来猜。错误方向会导致邀请、承诺和人物偏好全部反转。

## 7. 模型通道问题

### 模型列表仍显示默认 OpenAI 地址

确认输入框已真正保存，并查看 `data/settings.ini` 的 `[provider] url`。地址值在 INI 中 URL encode 是正常的。浏览器和桌面版应指向同一 settings 文件。

### 401

Key 无效、过期、复制了空格，或 Key 属于另一个平台。不要把 Key 发到日志或聊天中验证；在服务商控制台重新生成并最小权限配置。

### 403 `Your request was blocked`

常见原因：

- 填的是网站首页，不是 API 根地址；
- Cloudflare/WAF 阻止当前网络或请求体；
- Key 没有读取模型或调用该模型权限；
- 中转禁止 `/v1/models`；
- 请求内容触发服务商策略。

先用模型探测区分 `/models` 403 与分析 403。若只有分析被拦，选择一个虚构短会话复现；真实内容不应通过不可信第三方绕过安全策略。

### 404/405/422

兼容通道可能不支持 Responses 或 JSON Schema。API 模式设为自动后，THEIA 会在允许错误上回退 Chat Completions，并在 schema 400/422 时再回退 `json_object`。若明确模式仍报错，改为通道实际支持的模式。

### 429

频率或配额限制。THEIA 会最多重试 5 次并尊重 `retry_after`，故障通道会单独冷却，但不会无限轰炸服务。先降低该通道的“并发容量”；若服务商允许，也可以添加一条真正独立的 API 通道分担不同会话。多个 Key 若属于同一账户、同一中转或同一上游，通常仍共享额度。

### 502/503/504

这是中转/上游 gateway 错误。超长单请求是常见诱因，但上游过载也会影响短请求。

处理顺序：

1. 选一个会话 + 严格时间 + 100 条以内做健康检查。
2. 查看 task log 中 `segmentIndex/segmentCount`、recordCount 和请求大小。
3. 确认当前代码已启用 14k-34k 字符动态分段。
4. 查看通道池是否把故障通道标成冷却，并确认其他通道仍有可用槽位。
5. 如果错误明确表示 endpoint/schema 不受支持，自动模式应回退到 Chat Completions；普通 gateway 502 不应复制同一大请求做模式回退。
6. 等待服务恢复，或在服务商规则允许时增加另一条独立 API 通道。

不要把“所有消息都覆盖”误改回“单个无限大请求”。

### 添加多条通道后仍然没有提速

按顺序检查：

1. 每条通道是否都显示“可用”，而不是未配置、停用或冷却；
2. 全局“并发会话”是否大于 1，并且不小于希望使用的池容量；
3. 每条“通道并发容量”是否符合服务商允许值；
4. 当前是否只有一个超长会话——同一会话的片段为保证时间线只能串行；
5. 多个 Key 是否实际共享同一服务商账户级限流；
6. `/api/ai/status` 中 `scheduler.activeRequests` 是否同时分布在多个 channel runtime。

不要为了追求数字盲目把并发拉到 32。并发超过通道池实际容量只会在本机排队；超过服务商限额会增加 429/502，反而更慢。

### Chromium `ssl_client_socket_impl ... net_error -100`

`-100` 表示连接被关闭一类底层网络失败，常见于地图、头像或其他 HTTPS 资源，不一定是模型请求。结合出现时间和本地 task log 判断。连续大量出现时检查代理软件、证书拦截、系统时间和目标域名可达性。

## 8. 0 候选问题

UI 的“0 候选”不是单一故障码。依次看：

1. `rawCandidates`：模型是否返回了任何候选。
2. `acceptedCandidateCount`：本地校验后剩多少。
3. dismissed reason：是否过期或执行者错误。
4. task log response：模型是否返回空数组、无效 JSON 或引用了不存在的消息。
5. 输入 records：时间、方向和正文是否可靠。

### 模型原始返回就是空

可能范围内确实没有仍需行动事项。用一段你明确知道包含未来约定的虚构会话验证。检查用户自定义提示词有没有写成“只保留极少数”或互相冲突。

### 原始有候选但最后为 0

候选被本地过期/ownership 校验移除，或 sourceIds 无法恢复。查看摘要日志和 task log，确认模型引用的是 `RecordRef` 字符串，而不是随意生成 ID。

### 旧快递、旧投稿仍出现

确认消息时间可解析，候选没有错误的未来 `startAt/dueAt`。时效策略 strict/balanced/broad 只在无未来目标时间时使用 2/4/7 天或 14/30/60 天窗口。

### 应有任务被漏掉

先在单一会话严格时间复现；确认安排确实要求“你”行动，而不是对方自己的计划；检查它是否出现在 overlap 而不在当前 core（应在相邻核心段产生）；最后再调整“任务提炼”自定义提示和磨合记录。

## 9. 人物问题

### 任务完成后人物还是少

人物阶段在任务阶段后，并发为 2。观察全局工作浮窗是否仍显示人物进度。关闭或停止会保留已完成卡片，但剩余私聊不会凭空生成。

### 私聊有 2 万条但人物没有事实

检查：

- 会话是否标为 direct；
- speakerRole 是否能区分 self/other；
- 模型 people response 是否引用有效 RecordRef；
- 偏好是否来自对方原话，而非你的发言；
- `peopleModelVersion` 是否被旧数据重置；
- task log 中 people 请求/响应是否为空。

本地占位卡可以存在但没有丰富画像，这通常意味着模型证据未通过校验，不应降低验证标准来“填满卡片”。

### 头像只有少数显示

头像需要：

1. JSON 中确实有 URL 或 data image；
2. importer 能从消息/发言人/session 找到；
3. 远程主机属于允许的 QQ/微信图床；
4. URL 未过期且无需 Cookie；
5. TLS、MIME、大小和重定向校验通过。

检查 `assets/img/avatars/` 是否产生 hash 图片和 `.json` 元数据。缓存为空不一定是导入失败，也可能是远程 URL 已失效。

### 人物画像胡说或过度猜测

打开对应原始聊天和引用 ID；查看 people task log；恢复默认“人物证据”和“人物归并”提示；删除错误人物卡后只用单一私聊重跑。不要允许无引用自由作文。单次正面表达应写成弱信号，不应升级成稳定习惯或性格。

## 10. 地图问题

### 底图不显示

本地 API 会代理 `tile.openstreetmap.de` 和 `a.tile.openstreetmap.fr/hot`。检查浏览器 Network 中 `/api/map/tiles/...` 状态，以及终端是否提示上游 TLS/超时。公共服务可能被地区网络阻断或限流。

### 搜索不到任何地点

搜索至少两个字符，尝试“城市 + 区 + 完整地点名”。服务端会顺序尝试 Nominatim、Photon、ArcGIS、Wikidata 和 Open-Meteo geocoding。若全失败，使用手动选点；不要让任务创建依赖搜索一定成功。

### 选点后地图放大错位

确认地图容器没有被弹窗移动到另一个 stacking context，切换视图后调用 `invalidateSize`。当前实现用 `setView(..., animate:false)` 后在下一帧 invalidate，修改布局时需保留这一逻辑。

### 拖动点后没有保存

选中的点才可拖动。拖动只产生 coordinate draft，必须在右侧编辑器点击保存。取消会恢复旧坐标。

## 11. 日志阅读示例

摘要日志每行是一个 JSON 对象：

```json
{"at":"2026-07-30T01:20:30.000Z","event":"analysis-start","conversation":"示例会话","segmentIndex":1,"segmentCount":3,"recordCount":240}
```

工作日志第一行：

```json
{"schema":"theia-task-log/v1","startedAt":"...","kind":"task-analysis","request":{"conversation":{},"records":[]}}
```

后续行记录 completed/failed/fallback 等事件。排查时核对同一文件内：

- request records 数与 conversation.recordCount；
- coreRecordIndexes 是否有效；
- direction stats 是否大量 unknown；
- provider mode 是否回退；
- raw response 是否符合 JSON；
- sourceIds 是否来自输入。

## 12. 安全恢复原则

- 修改或删除前复制整个相关目录。
- 不使用 `git reset --hard`、批量删除根目录或不明确的通配符恢复用户数据。
- JSON 损坏时保留原件，复制后再修复。
- 删除 `data/electron/` 只会重置桌面 Chromium profile，不等于删除任务；但必须在退出应用后进行。
- 删除 `data/state.json` 会丢失任务、人物、地点和候选；删除 `data/chat-archive.json.gz` 会丢失原始聊天来源。
- API Key 泄露时不能靠删除日志补救，应立即在服务商处吊销并重发。

若仍不能定位，使用完全虚构的最小 JSON 复现，并只分享去标识化后的日志结构。这样既能调试，又不会把真实聊天和密钥交给第三方。
