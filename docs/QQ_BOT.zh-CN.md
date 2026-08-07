# HYPERION QQ Bot 接口

QQ Bot 是一个可选的本地入口，不是第二份数据存储。Bot 进程位于 HYPERION 旁的
`IRIS` 仓库，通过官方 `@tencent-connect/qqbot-nodejs` 连接 QQ 开放平台；
HYPERION 服务端仍只监听 `127.0.0.1`。Bot 没有读取原始归档文件的权限，也不应调用
`/api/sync/snapshot`。

## 数据边界

| 数据 | Bot 是否可见 | 说明 |
| --- | --- | --- |
| 任务列表 | 是，摘要 | 仅包含 id、标题、时间、状态；不返回聊天原文。 |
| 人物列表 | 是，摘要 | 返回名称、最后观察时间、人物刻画截断文本和计数。 |
| 日记 | 写入 | 写入 append-only 归档，`conversationId` 固定为 `self-journal`。 |
| 每日状态 | 写入 | 更新 `dailyCheckins`，同时写入一条状态快照归档记录。 |
| SELENE | 只读摘要 | 仅返回事件数、平台推断统计、最近事件的时间和标题；不返回坐标、路径和原始 values。 |
| AI 通道 | 只读状态 | 返回调度器和每个通道的占用，不返回 URL、模型密钥或请求正文。 |

## 接口协议

所有响应均为 UTF-8 JSON，并带 `Cache-Control: no-store`。错误响应格式为：

```json
{
  "error": "可读的错误说明"
}
```

### `GET /api/bot/summary`

返回轻量概览：

```json
{
  "generatedAt": "2026-08-06T12:00:00.000Z",
  "profileName": "我",
  "activeQuestCount": 3,
  "completedQuestCount": 9,
  "peopleCount": 12,
  "journalCheckInCount": 4,
  "archiveRecordCount": 357,
  "archiveConversationCount": 33,
  "archiveUpdatedAt": "2026-08-06T11:59:00.000Z"
}
```

### `GET /api/bot/quests`

最多返回 30 个 `active` 或 `available` 任务：

```json
{
  "items": [
    { "id": "q-1", "title": "确认返校日期", "dueAt": null, "startAt": "2026-09-01", "status": "active" }
  ]
}
```

### `POST /api/bot/quests/:id/complete`

请求体可以是空对象 `{}`。服务端在锁内读取最新任务并设置 `status: "done"`，同时
保留原状态到 `previousStatus`，避免 Bot 与桌面端并发时覆盖新编辑。

### `GET /api/bot/people?q=`

按人物名称或刻画文本过滤，默认最多 40 项，带查询时最多 20 项：

```json
{
  "items": [
    {
      "id": "p-1",
      "name": "示例人物",
      "lastObservedAt": "2026-08-05T10:00:00.000Z",
      "portrait": "...",
      "factCount": 4,
      "preferenceCount": 2
    }
  ]
}
```

### `POST /api/bot/journal`

请求：

```json
{ "content": "今天把导出数据重新整理了一遍。" }
```

服务端生成唯一 id、UTC `capturedAt`、`speakerRole: "self"`，并调用
`saveSharedIntelDelta({ upserts: [record], deleteIds: [] })`。不会读取、拼接或重写
整个 158MB 归档。

### `POST /api/bot/check-in`

可选字段：

```json
{
  "mood": 3,
  "sleepHours": 7.5,
  "medication": "reduced",
  "alcohol": "low",
  "mainFocus": "写代码",
  "note": "晚上有点累"
}
```

状态字段只能是 `mood: 1..5`、`sleepHours: 0..24`、
`medication: yes | no | reduced | unknown`、`alcohol: none | low | high | unknown`。
同一日期使用稳定 id `self-checkin-YYYY-MM-DD` 幂等更新；同时生成同 id 的自我分析归档行。
此更新在 `sharedStateWriteQueue` 和共享状态文件锁内完成。

### `GET /api/bot/selene`

只读返回粗粒度摘要。`latestEvents` 不包含 `location`、`locationConsent`、`sourceFile`
或未过滤的 `values`。平台统计仅在 SELENE 导入路径带有 `android`/`windows` 时分类，否则记为
`unknown`，绝不猜测设备平台。

### `GET /api/bot/ai`

只返回 `queueDepth`、`activeRequests`、`effectiveMaxConcurrency`、`availableCapacity`，
以及通道的显示名、启用状态、运行状态和占用。API URL、凭据、模型输入输出不会离开本机。

## 认证与首次绑定

HYPERION Bot API 只在 `127.0.0.1` 提供，QQ 开放平台凭据只在 Bot 的 `.env` 中读取。
Bot 事件处理只接受 C2C 私聊，群聊一律忽略。推荐设置 `QQBOT_OWNER_OPENID`；旧部署的
`OWNER_OPENID`/`OWNER_QQ` 仅为迁移兼容。如果没有设置 owner，Bot 启动后第一条 C2C 消息
会绑定为 owner，并将最近的 `replyTarget` 写入被忽略的 `.bot-state.json`。不要在公开环境
中启用无 owner 的首次绑定。

## 任务完成通知

可以从本机运行：

```powershell
Set-Location (Resolve-Path '..\..\IRIS')
npm run notify -- "HYPERION 与 SELENE 的本地集成已完成。"
```

已绑定时通知使用 QQ C2C 主动消息接口，不启动长连接，也不读取 HYPERION 数据。尚未绑定时
命令会把通知保存在被忽略的本地 `.bot-state.json`，第一条可信 C2C 消息绑定目标后立即发送。
QQ 平台的主动消息时间窗口由平台决定；发送失败不会修改 HYPERION 状态，待发送通知会保留到下次可信消息。
