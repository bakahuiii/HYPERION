# THEIA

THEIA 是一个本地优先的个人现实任务图工具。它把你主动导出的微信、QQ、校园平台等记录整理成可审核的候选任务，并在同一个界面中管理任务图、行程、地点、人物和原始来源。

这是 THEIA `0.4.2` 源码发布包，不是免安装 EXE。第一次使用需要安装 Node.js 和项目依赖。发布包不包含任何真实聊天、任务、人物、API Key、头像缓存、个人设置或内部规划文档。

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

## 最快启动

### 第一步：安装 Node.js

安装 Windows x64 的 Node.js 24 LTS。最低可用版本是 `22.12.0`；Node.js 20 不满足当前 Electron 和模型 SDK 的依赖要求。

安装后打开 PowerShell 并检查：

```powershell
node --version
npm --version
```

### 第二步：安装 THEIA 依赖

进入本发布包的 `app` 文件夹，在空白处按住 Shift 并点击右键，选择“在终端中打开”，然后运行：

```powershell
npm install
```

首次下载需要网络，并会创建较大的 `app/node_modules/` 目录。命令完成且返回提示符后再继续。

### 第三步：启动

回到发布包根目录，双击：

- `启动 THEIA 桌面版.cmd`：推荐，独立 16:9 窗口并默认使用 GPU 加速。
- `启动 THEIA 浏览器版.cmd`：启动本地服务后，用 Chrome/Edge 打开终端显示的地址。

不要直接双击 `app/index.html`，因为设置、模型、共享数据、地图和头像需要本地 Node.js 服务。

## 第一次进入后

1. 打开“选项”，设置名称、用户头像、主题和全局背景。
2. 需要模型功能时，在“模型通道”填写 API 根地址和明文 API Key，检测并选择模型。
3. 在“情报库”先导入 `data/examples/` 中的虚构示例，确认流程能运行。
4. 再导入自己的一个私聊会话，检查时间、发言人和“你/对方”方向。
5. 用“严格时间”模式和短时间范围做第一次模型提炼。
6. 审核候选任务，确认执行者、时间和来源后再生成正式任务。
7. 等待任务阶段之后的人物提炼完成；右侧工作浮窗会显示独立进度。

没有模型 Key 时仍可导入/浏览聊天、手动创建任务、编辑行程和地图点。模型候选、人物画像和建议需要你配置的兼容模型服务。

## 目录说明

```text
THEIA-release/
├─ app/                       应用源码、锁文件和运行脚本
├─ assets/img/
│  ├─ backgrounds/           运行后上传的全局背景
│  └─ avatars/               运行后缓存的联系人头像
├─ data/
│  ├─ examples/              完全虚构的导入示例
│  ├─ state.json             运行后生成：任务、人物、地点和候选
│  ├─ chat-archive.json.gz   运行后生成：gzip 压缩的原始聊天归档
│  └─ settings.ini           运行后生成：外观、提示词和明文 API Key
├─ logs/
│  ├─ ai-debug.jsonl         运行后生成：不含正文的管线摘要
│  └─ tasks/                 运行后生成：完整模型工作日志
├─ docs/                     完整文档
├─ 启动 THEIA 桌面版.cmd
└─ 启动 THEIA 浏览器版.cmd
```

`data/`、`logs/` 和 `assets/img/avatars/` 都可能含私密信息。不要把运行后的发布目录直接发给别人或上传到公共仓库。

## 网络与隐私

THEIA 不绕过登录、不解密私人数据库，也不自行抓取微信、QQ 或校园平台。它只处理你主动选择或授权的导出文件。

- 启动任务/人物提炼时，所选记录会发送到你配置的模型服务。
- 主动启用自动提炼后，最短间隔为 24 小时，且当前需要页面保持打开。
- 打开地图会请求公共 OSM 瓦片；搜索只发送你输入的地点关键词。
- 有未来日期和坐标的任务建议可能查询 Open-Meteo 天气。
- 导出记录中的 QQ/微信头像 URL 可能由本地代理下载并缓存。
- API Key 按当前设计明文写入 `data/settings.ini`。

使用第三方中转前，请确认其数据保留和隐私政策。完整说明见 [隐私与数据](docs/PRIVACY_AND_DATA.md)。

## 0.3.0 重点

- 已验证的多通道稳定提炼基线：人物证据和归并使用全局并发，最多 64 个工作槽；单通道容量为 1–8，共享上游会统一计数。
- 连续会话分段覆盖全部核心消息；502、429、503、504、524、网络错误和超时使用最多 2 秒本地短退避并保留可重试工作。
- 本地服务、上游 Responses/Chat Completions、模型请求 JSON、批处理 session、日志和存储协议都有逐字段文档。

## 文档入口

- [用户手册](docs/USER_GUIDE.md)：从安装、首次配置、导入、范围选择、模型提炼到备份恢复的逐步说明。
- [开发者文档](docs/DEVELOPER_GUIDE.md)：技术栈、架构、数据模型、分段算法、本地 API、性能和发布流程。
- [API 协议参考](docs/API_PROTOCOL.md)：本地 HTTP、模型请求 JSON、session 批处理、通道状态、日志和回退规则。
- [聊天导出格式](docs/CHAT_EXPORT_FORMAT.md)：推荐目录、JSON/CSV/TXT 字段、时间、方向和头像规则。
- [故障排查](docs/TROUBLESHOOTING.md)：端口、Electron、GPU、502/403、0 候选、人物、头像、地图和恢复。
- [隐私与数据](docs/PRIVACY_AND_DATA.md)：敏感文件、外部请求、日志、备份、删除和发布脱敏。
- [发布说明](docs/RELEASE_NOTES.md)：当前版本状态和限制。

## 重要限制

- 模型可能遗漏、误读或总结错误，候选和人物结论必须人工审核。
- 发言方向无法从导出字段确认时，THEIA 会保留 unknown，不会安全地靠昵称猜测。
- 超长会话会连续分段覆盖全部消息，而不是塞进一个无限大的请求；第三方服务仍可能限流或返回 502。
- 地图和搜索使用公共服务，没有可用性保证，必须保留手动选点。
- 当前没有数据库加密、正式 schema 迁移、签名安装器和自动更新。

重要数据请在关闭 THEIA 后备份 `data/`、`assets/img/` 和需要保留的 `logs/`。
