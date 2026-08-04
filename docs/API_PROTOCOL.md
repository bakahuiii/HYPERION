# THEIA 本地 API 与模型协议参考

本文是 THEIA `0.4.0` 的协议级参考，面向前端、桌面壳、第三方导出适配器、测试服务和二次开发者。它描述的是当前 `server/index.mjs` 和 `src/lib/aiClient.ts` 的实际行为，不是未来规划。

协议有两个边界：

1. THEIA 本地 HTTP API 只监听 `127.0.0.1`，供浏览器、Electron renderer 和开发脚本使用。
2. 本地服务再把经过校验的模型请求转发到用户配置的 OpenAI-compatible 服务。外部服务不会直接访问 THEIA 的本地文件。

本地 API 没有用户认证，不能暴露到局域网或公网。设置接口可能向本机界面返回解密后的 API Key；打包桌面版的静态存储使用 Electron `safeStorage`，纯 Node 开发模式可能回退为 INI 明文。

## 1. 基本约定

### 1.1 地址、请求和响应

默认地址为 `http://127.0.0.1:8787`，可由 `AI_PORT` 修改。浏览器开发服务器通常把 `/api/*` 代理到该地址；Electron 会在同一进程启动它。

除图片和瓦片接口外，接口使用：

```http
Content-Type: application/json
Accept: application/json
Cache-Control: no-store
```

成功响应直接返回 JSON。错误响应统一为：

```json
{
  "error": "可读的错误说明",
  "retry_after": 2,
  "metadata": {
    "provider": {
      "channelId": "channel-1",
      "attemptCount": 1
    }
  }
}
```

`retry_after` 是给本地客户端的秒数提示，服务端会把它限制在本地短退避范围内；上游原始值仍只写入诊断元数据。不要把 `metadata.provider.attempts` 当作稳定的数据库 schema，调试字段可以随版本扩展。

### 1.2 限制

| 限制 | 当前值 | 说明 |
| --- | ---: | --- |
| 本地 JSON body | 256 MiB | 包括聊天记录和附件 |
| 单请求附件数 | 4 | 任务第一段发送，后续段不重复发送 |
| 单附件大小 | 8 MiB | 按 base64/JSON body 前的服务端限制计算 |
| 上游请求超时 | 90 秒 | 环境变量 `AI_PROVIDER_TIMEOUT_MS` 可调，范围 15-180 秒 |
| session 单次 enqueue | 40 个 job | 超过时客户端自动拆页 |
| session 结果页 | 120 条 | `ack-v1` 模式下结果在确认前保留 |
| AI 全局并发 | 1-64 | `normalizeAiConcurrency` 归一化 |
| 单通道并发 | 1-8 | 通道配置的 `maxConcurrency` |

这些是传输限制，不代表模型上下文窗口。长会话必须先由客户端按时间线分段。

## 2. 通道池协议

### 2.1 通道配置对象

创建或更新通道时可提交以下对象。`key` 和地址只应通过 loopback 发送，不要写入公开日志或 issue。

```json
{
  "id": "channel-1",
  "name": "主中转",
  "url": "https://relay.example/v1",
  "key": "sk-example",
  "model": "gpt-5.6-sol",
  "apiMode": "auto",
  "enabled": true,
  "maxConcurrency": 8,
  "primary": true
}
```

地址会被规范化：空路径补 `/v1`，去掉 query/hash，远程地址必须是 HTTPS；只有 `localhost` 或 `127.0.0.1` 允许 HTTP。`apiMode` 只能是 `auto`、`responses` 或 `chat-completions`。

### 2.2 `GET /api/ai/status`

返回完整通道池状态。Key 默认只返回 `keyHint`；设置接口仅在 loopback 上为编辑返回可用 Key。

```json
{
  "configured": true,
  "primaryProviderId": "channel-1",
  "configuredChannelCount": 2,
  "totalMaxConcurrency": 16,
  "channels": [
    {
      "id": "channel-1",
      "name": "主中转",
      "enabled": true,
      "configured": true,
      "baseUrl": "https://relay.example/v1",
      "model": "gpt-5.6-sol",
      "apiMode": "auto",
      "maxConcurrency": 8,
      "models": ["gpt-5.6-sol"],
      "runtime": {
        "status": "ready",
        "activeRequests": 6,
        "configuredMaxConcurrency": 8,
        "effectiveMaxConcurrency": 8,
        "availableSlots": 2,
        "cooldownRemainingMs": 0,
        "successfulRequests": 120,
        "failedRequests": 2,
        "consecutiveFailures": 0
      }
    }
  ],
  "scheduler": {
    "queueDepth": 0,
    "activeRequests": 6,
    "availableCapacity": 10,
    "totalMaxConcurrency": 16,
    "effectiveMaxConcurrency": 16,
    "sharedOriginCount": 1,
    "coolingDownChannelCount": 0,
    "sharedOrigins": [
      {
        "key": "https://relay.example/v1",
        "channelIds": ["channel-1", "channel-2"],
        "activeRequests": 6,
        "configuredMaxConcurrency": 16,
        "effectiveMaxConcurrency": 16,
        "availableCapacity": 10,
        "cooldownRemainingMs": 0
      }
    ]
  }
}
```

`configured` 表示至少有一条启用且有有效 Key 的通道，不只看主通道。`effectiveMaxConcurrency` 可能因运行时自适应限制低于配置值；成功释放后会逐步恢复。多个通道指向同一地址时，`sharedOrigins` 是共同上游的实际容量视图。

### 2.3 通道 CRUD

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| `GET` | `/api/ai/channels` 或 `/api/ai/providers` | 完整池状态 |
| `POST` | `/api/ai/channels` | 创建通道并返回池状态，连接变化时探测模型 |
| `PUT/PATCH` | `/api/ai/channels/:id` | 更新通道；可以包含 `enabled`、`primary`、`refreshModels` |
| `POST` | `/api/ai/channels/:id` | 兼容 UI 的更新/刷新模型别名 |
| `DELETE` | `/api/ai/channels/:id` | 删除通道，至少保留一个配置槽 |
| `POST` | `/api/ai/config` | 旧单通道配置兼容入口 |
| `DELETE` | `/api/ai/config` | 重置旧单通道配置 |

所有 mutation 成功后都返回完整 pool status，前端不需要再猜测容量。

### 2.4 `POST /api/ai/models`

请求：

```json
{
  "_type": "newapi_channel_conn",
  "url": "https://relay.example/v1",
  "key": "sk-example"
}
```

响应：

```json
{
  "baseUrl": "https://relay.example/v1",
  "models": ["gpt-5.6-sol", "gpt-4.1-mini"]
}
```

服务端请求上游 `GET <baseUrl>/models`，读取 `data[].id`。403、401、空列表和地址错误会转成可读错误；模型探测失败不会覆盖已保存的明确模型 ID。

## 3. 模型提炼请求

### 3.1 请求 envelope

`POST /api/ai/analyze` 处理一个会话段。一个 HTTP 请求只对应一个语义会话段；不同会话由客户端并发提交。

最小完整示例：

```json
{
  "conversation": {
    "id": "direct-linxiao",
    "name": "林晓",
    "kind": "direct",
    "totalRecords": 2,
    "recordCount": 2,
    "segmentIndex": 1,
    "segmentCount": 1,
    "coreRecordCount": 2,
    "overlapRecordCount": 0,
    "coreRecordIndexes": ["1", "2"],
    "historical": false
  },
  "records": [
    {
      "id": "msg-001",
      "formattedTime": "2026-07-28 18:30:00",
      "type": "text",
      "content": "周六下午去图书馆讨论开学材料，可以吗？",
      "senderDisplayName": "林晓",
      "speakerRole": "other"
    },
    {
      "id": "msg-002",
      "formattedTime": "2026-07-28 18:31:12",
      "type": "text",
      "content": "可以，三点在东门见。",
      "senderDisplayName": "你",
      "speakerRole": "self"
    }
  ],
  "attachments": [],
  "settings": {
    "mode": "balanced",
    "instructions": "只保留对用户有实际行动价值的事项。",
    "recencyPolicy": "balanced",
    "promptInstructions": {
      "task": "优先识别明确的约定、截止日期、需要用户执行的事项。"
    },
    "feedback": [
      {
        "title": "旧候选",
        "description": "示例任务",
        "decision": "dismissed",
        "reason": "not-actionable",
        "sourceCapturedAt": "2026-07-20 12:00:00"
      }
    ]
  }
}
```

字段规则：

- `conversation.recordCount` 必须等于本段 `records.length`；`totalRecords` 可以大于本段长度。
- `segmentIndex` 从 1 开始且不大于 `segmentCount`。
- `coreRecordIndexes` 是本段数组的 1-based 索引。只有核心记录可以直接支撑新任务，overlap 只用于消解指代。
- 每条记录必须有稳定 `id` 和非空 `content`。模型实际看到的顺序化压缩行是 `[序号, formattedTime, type, content, senderDisplayName, speakerRole]`，不是带长键名的对象。
- `speakerRole` 只能是 `self`、`other`、`unknown`。未知方向不会被昵称猜测覆盖。
- 第一段可以带最多 4 个附件；客户端后续段发送空数组，避免重复 token 和重复上传。

### 3.2 任务响应

内置批处理默认发送 `workflows: { "tasks": true, "people": false }`，人物证据随后走第 3.3 节的宽窗口 `/api/ai/people`。协议仍保留 `workflows.people=true` 的联合模式，供兼容客户端在一次私聊请求中同时获取任务和人物；联合模式不是内置批处理的默认路径。

```json
{
  "model": "gpt-5.6-sol",
  "apiModeUsed": "responses",
  "candidates": [
    {
      "title": "周六在东门见面讨论开学材料",
      "description": "林晓提出周六下午去图书馆讨论开学材料，你确认三点在东门见面。",
      "startAt": "2026-08-01 15:00",
      "dueAt": null,
      "sourceIds": ["msg-001", "msg-002"],
      "people": ["林晓"],
      "place": "图书馆东门",
      "locationPrecision": "approximate",
      "locationRadiusMeters": 500,
      "tags": [],
      "guidance": ["提前确认图书馆开放时间。"],
      "actionOwner": "self"
    }
  ],
  "people": [],
  "peopleIncluded": true,
  "receivedRecordCount": 2,
  "metadata": {
    "provider": {
      "channelId": "channel-1",
      "queueWaitMs": 3,
      "attemptCount": 1,
      "fallbackCount": 0,
      "providerUsage": null
    }
  }
}
```

`peopleIncluded: true` 表示联合人物 schema 已被服务端处理，不代表一定找到了人物。客户端仍会本地检查：候选必须是 `actionOwner=self`、source ID 必须存在、证据必须能证明用户是执行者、日期和短时事项必须通过过期策略。

任务中间态没有“置信度”字段。不要在适配器中重新加入伪精确置信度；应用使用来源、时间、执行者和用户审核决定是否进入正式任务。

### 3.3 人物证据响应

`POST /api/ai/people` 使用相同 envelope，但 `settings.promptInstructions.people` 生效，响应只需要。内置人物计划使用最多 320 条核心记录/24,000 字符，并在相邻段之间保留最多 16 条/3,000 字符上下文；任务计划使用 48 条/4,000 字符核心记录和 6 条/1,000 字符 overlap。两种计划都不抽样核心消息，overlap 只用于理解上下文，不计入覆盖数量：

```json
{
  "model": "gpt-5.6-sol",
  "apiModeUsed": "responses",
  "people": [
    {
      "name": "林晓",
      "facts": [
        {
          "text": "经常讨论开学材料和图书馆安排",
          "sourceIds": ["msg-001"],
          "quote": "周六下午去图书馆讨论开学材料"
        }
      ],
      "preferences": []
    }
  ],
  "receivedRecordCount": 2
}
```

模型不能把 self 消息当作对方事实。客户端会要求 quote 是对方原文的连续子串，并且 source ID 来自当前段；不满足时整条 claim 不进入人物证据缓冲。

### 3.4 人物归并请求

归并不是重新上传聊天。它只提交已经由本地验证过的 claim：

```json
{
  "person": {
    "name": "林晓",
    "evidence": [
      {
        "id": "claim-a1",
        "kind": "fact",
        "text": "经常讨论开学材料和图书馆安排",
        "quote": "周六下午去图书馆讨论开学材料",
        "sourceIds": ["msg-001"],
        "evidenceStrength": "single",
        "category": "interaction",
        "stability": "single",
        "importanceScore": 7,
        "portraitEligible": true,
        "firstObservedAt": "2026-07-28 18:30:00",
        "lastObservedAt": "2026-07-28 18:30:00"
      }
    ],
    "facts": ["经常讨论开学材料和图书馆安排"],
    "preferences": [],
    "advice": [],
    "portrait": null,
    "profileNotes": null
  },
  "settings": {
    "promptInstructions": {
      "peopleMerge": "只写能够由 claimIds 支撑的自然人物刻画。"
    }
  }
}
```

归并 response schema 是引用式的：

```json
{
  "factClaimIds": ["claim-a1"],
  "preferenceClaimIds": [],
  "portraitBlocks": [
    {
      "text": "林晓会主动讨论开学材料，也愿意把见面安排落实到具体时间和地点。",
      "claimIds": ["claim-a1"],
      "reason": "interaction"
    }
  ],
  "advice": [],
  "coverageNote": null,
  "profileNotesUsed": false
}
```

服务端只接受 registry 中存在且 `portraitEligible !== false` 的 claim ID；`temporary` 和 `filler` 永远不能进入 portrait 或 advice。`coverageNote` 是元数据，不能混进 portrait 正文。这样比生成自由文本后再做模糊匹配更容易发现幻觉。

### 3.5 任务建议

`POST /api/ai/task-guidance`：

```json
{
  "quest": {
    "title": "周六在东门见面讨论开学材料",
    "description": "确认三点在图书馆东门见面。",
    "startAt": "2026-08-01 15:00",
    "dueAt": null
  },
  "place": {
    "name": "图书馆东门",
    "note": "从南门进入",
    "precision": "approximate",
    "lat": 31.2304,
    "lng": 121.4737
  },
  "people": [
    {
      "name": "林晓",
      "facts": ["经常讨论开学材料"],
      "preferences": [],
      "advice": [],
      "portrait": null,
      "profileNotes": null,
      "profileNotesUsed": false
    }
  ],
  "weather": null,
  "settings": {
    "promptInstructions": {
      "taskGuidance": "建议必须具体、可执行，不能凭空补充人物信息。"
    }
  }
}
```

响应最多 4 条：`{"model":"...","apiModeUsed":"responses","guidance":["..."]}`。天气只由前端在目标日期为今天至未来 16 天且地点有坐标时提供；服务端不会自行猜测天气。

## 4. 本地 session 批处理协议

浏览器保持的长连接数量有限，因此批量提炼默认使用服务端驻留 session，而不是把 40 个请求绑在同一个 HTTP response 上。

### 4.1 创建

```http
POST /api/ai/sessions
{}
```

```json
{
  "id": "a3d7f8c0-...",
  "maxEnqueue": 40
}
```

服务端 session 默认存活 30 分钟。客户端结束后应 `DELETE /api/ai/sessions/:id`，取消排队和 in-flight job。

### 4.2 入队

```http
POST /api/ai/sessions/:id/enqueue
```

```json
{
  "requests": [
    {
      "id": 1,
      "workflow": "tasks",
      "payload": { "conversation": {}, "records": [], "attachments": [], "settings": {} }
    },
    {
      "id": 2,
      "workflow": "people",
      "payload": { "conversation": {}, "records": [], "attachments": [], "settings": {} }
    }
  ]
}
```

实际 payload 必须满足第 3 节的验证规则；上例只展示 envelope。响应包含 `acceptedIds`、`queued`、`inFlight` 和 `pending`。同一 session 内 job ID 不得重复。

### 4.3 轮询与确认

```http
GET /api/ai/sessions/:id/results?protocol=ack-v1&ack=1,2
```

响应：

```json
{
  "results": [
    { "id": 1, "ok": true, "result": { "model": "..." } },
    { "id": 2, "ok": false, "status": 502, "error": "上游网关错误", "retryAfter": 1 }
  ],
  "queued": 18,
  "inFlight": 20,
  "pending": 38
}
```

`ack-v1` 的语义是：客户端成功收到一页后，在下一次请求的 `ack` 查询参数中确认这些 ID；没有确认的结果会重复返回。这样短暂的 ECONNRESET、页面节流或 renderer 重启不会让已完成 job 永久丢失。旧客户端不带 `protocol=ack-v1` 时，读取会消费结果页，不应与新客户端混用同一个 session。

## 5. 上游 OpenAI-compatible 协议

本地代理为每次请求申请一个通道 lease，然后向该通道的规范化地址发送：

| 本地 API 模式 | 上游路径 | 结构化参数 |
| --- | --- | --- |
| `responses` | `<baseURL>/responses` | `text.format` JSON Schema |
| `chat-completions` | `<baseURL>/chat/completions` | `response_format.json_schema` |
| 模型发现 | `<baseURL>/models` | `data[].id` |

`auto` 首次优先 Responses。只有 404、405、415、501，或 400/422 明确表示不支持 Responses/structured output 时才切换 Chat Completions；普通 502、503、504、超时和网络错误不会复制大请求到另一协议。成功的 auto 模式会按通道记忆，减少重复探测。

服务端为上游请求设置：

```http
Authorization: Bearer <channel.apiKey>
Content-Type: application/json
Accept: application/json
```

上游失败时只标记当前通道和其共享 origin。429、502、503、504、524、超时和网络错误使用 250 ms 起步、最多 2 秒的本地短退避；`Retry-After: 60` 不会让本地队列冻结 60 秒。客户端最多进行 5 次可重试尝试，新的尝试会重新申请通道。

## 6. 同步、设置和资源 API

### 6.1 轻量状态与原始归档

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/sync/snapshot` | 读取任务、人物、地点、候选等轻量状态 |
| `POST` | `/api/sync/snapshot` | 带 `expectedUpdatedAt` 原子写入；成功只返回新时间戳 |
| `GET` | `/api/sync/meta` | 读取状态时间和归档计数 |
| `GET` | `/api/sync/intel/meta` | 读取 gzip 原始归档元数据 |
| `GET` | `/api/sync/intel` | 读取完整原始归档 |
| `POST` | `/api/sync/intel` | 压缩、加锁并原子写入原始归档 |
| `POST` | `/api/sync/intel/delta` | 追加 upsert/delete 操作，不上传未变化消息 |

快照请求示例：

```json
{
  "expectedUpdatedAt": "2026-08-04T12:00:00.000Z",
  "data": {
    "profile": { "name": "旅人" },
    "quests": [],
    "people": [],
    "places": [],
    "aiCandidates": [],
    "archive": { "version": 1, "messageCount": 0, "conversationCount": 0 }
  }
}
```

原始 `intel` 不应放回 `data`，也不应进入 shared snapshot。冲突返回 409，并带 `currentUpdatedAt`；客户端应重新读取、三方合并后重试。

增量归档请求：

```json
{
  "expectedUpdatedAt": "2026-08-04T12:00:00.000Z",
  "sourceFingerprint": "sha256:directory-fingerprint",
  "upserts": [
    { "id": "message-42", "conversationId": "direct:A", "capturedAt": "2026-08-04T11:00:00Z", "content": "updated" }
  ],
  "deleteIds": ["message-17"]
}
```

服务端会先校验水位，再把操作写入 `theia-intel-archive/v1` 的 gzip JSONL delta segment。`upserts` 中的记录按稳定 `id` 覆盖，`deleteIds` 在 upsert 前执行；同一请求同时更新时以 upsert 为准。首次迁移、未知基线或大规模替换不应调用此接口，客户端会自动回退全量 snapshot。

### 6.2 设置

`GET/POST /api/settings` 读写 profile、appearance、AI settings；POST 未携带的 `mapSettings` 会保留，不会被界面设置保存覆盖。模型提示词四个字段为：`task`、`people`、`peopleMerge`、`taskGuidance`。设置文件使用 URL 编码的 INI v4；调用方不要手写 INI 覆盖整个文件，优先使用接口以保留迁移、凭据引用和归一化规则。

`GET /api/storage/overview` 除 `workspace/entries` 外返回：

```json
{
  "health": {
    "sharedState": { "schema": "theia-shared-state/v1", "schemaVersion": 1, "migration": { "state": "ready", "migrated": false }, "rollbackBackups": [] },
    "archive": { "schema": "theia-intel-archive/v1", "schemaVersion": 1, "storageEngine": "append-only-jsonl-gzip", "recordCount": 273713, "segmentCount": 3, "updatedAt": "2026-08-04T12:00:00.000Z", "migration": { "state": "ready", "migrated": false } },
    "recovery": { "uncleanShutdownDetected": false },
    "rollbackCommand": "npm run data:rollback -- --latest"
  }
}
```

这只是元数据接口，不返回聊天正文、Key 或任务日志内容。回滚没有开放 HTTP 写接口；必须关闭应用后从本机命令行执行，避免运行中的 renderer 把旧状态立刻覆盖。

### 6.3 地图、头像和背景

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/settings/background` | 保存不超过 20 MiB 的 data URL 资产 |
| `GET` | `/api/settings/background/:id` | 读取本地背景/头像资产 |
| `GET` | `/api/media/avatar?src=` | 受白名单限制的 QQ/微信头像代理和缓存 |
| `GET` | `/api/map/tiles/:z/:x/:y.png` | 公共 OSM 瓦片代理，z 0-19 |
| `GET` | `/api/map/search?q=&provider=` | 公共地理搜索，provider 为 balanced/nominatim/photon |
| `GET` | `/api/map/config` | 地图设置、可选服务、署名、policy URL 和使用说明 |
| `POST` | `/api/map/config` | 保存 tileProvider/searchProvider/cacheMaxMb |
| `GET` | `/api/quote` | 在线语录，失败时离线回退 |

瓦片请求查询参数：`provider=osm-de|osm-standard|osm-hot`，`cacheMaxMb=32..1024`。服务端验证 z/x/y 和 host 白名单，把瓦片写入有界本地缓存，并用 `x-theia-map-cache: hit|miss` 标记命中。所选源失败时可尝试其他白名单 OSM 源。不得用此接口实现批量预取或离线抓图。

地图配置 POST：

```json
{ "tileProvider": "osm-de", "searchProvider": "balanced", "cacheMaxMb": 128 }
```

这些公共服务没有 SLA。地图搜索只发送搜索词，不发送任务正文、人物或聊天内容；头像代理拒绝不在白名单内的远程域名。客户端必须展示响应中的 attribution，并让用户可以查看 provider policy URL。

## 7. 领域 ID 与数据约束

- `IntelItem.id` 必须在导入后稳定；候选 `sourceIds` 和人物 claim `sourceIds` 只能引用实际归档记录。
- `speakerRole=self` 表示用户，`other` 表示对话方，`unknown` 不能用于确认执行者。
- `Quest.status` 为 `available | active | done | locked`；取消完成要恢复 `previousStatus`。
- `PersonEvidence.category` 为 `identity | background | preference | habit | boundary | interaction | skill | temporary | filler`。temporary/filler 保留用于审计，但不进入 portrait。
- `PersonEvidence.id` 是本地稳定 claim ID；人物归并只选择 ID，不接受模型自由替换事实。
- `archive` 只保存计数和来源指纹，不保存聊天正文。

扩展字段时优先增加可选字段，保留旧字段的读取能力；改变必填字段、枚举或响应语义时应提升协议版本并更新本文。

## 8. 日志协议

### 8.1 摘要日志

`logs/ai-debug.jsonl` 一行一个事件。常见事件：

```text
request_started
request_succeeded
request_failed
conversation_retry_scheduled
people_segment_started
people_segment_succeeded
people_segment_failed
people_merge_started
people_merge_succeeded
people_merge_failed
people_merge_aborted
people_run_completed
```

摘要事件可以包含 `conversationId`、`conversationName`、`personName`、`recordCount`、`coreRecordCount`、`segmentIndex`、`workflowConcurrency`、`providerChannelId`、`providerQueueWaitMs`、`providerAttemptCount`、`durationMs`、`status` 和统计数量，但不应包含聊天正文、附件 data URL、Authorization 或 API Key。

### 8.2 工作日志

`logs/tasks/*.jsonl.gz` 是高敏感日志，可能包含完整模型 prompt、原始 records 和模型响应，用于复现单个任务。文件名带时间戳、工作类型、清理后的会话标签和 digest。发布包不会复制它们；共享日志前必须删除正文、头像 data URL、Key 和绝对路径。

## 9. 调试与兼容测试

推荐顺序：

1. 查看 UI 的人物/任务浮窗，确认是本地排队、上传、上游还是归并阶段；
2. 查看 `ai-debug.jsonl` 的 `providerAttemptCount`、通道 ID、排队时间和 HTTP 状态；
3. 对照 task log 的 `request`、`response` 和 `metadata.provider.attempts`；
4. 用单一会话 + 严格时间范围复现；
5. 使用 `npm test` 的 loopback 假服务验证，不要把真实 Key 写进测试 fixture。

协议改动至少应覆盖：

- Responses 与 Chat Completions 的 schema 形状；
- session 入队、轮询、ack、断线重连和取消；
- 多通道负载均衡、共享 origin 容量、短冷却和备用通道；
- `receivedRecordCount` 与 source ID 引用校验；
- 旧的单通道 `/api/ai/config` 兼容入口；
- gzip 归档和 snapshot 409 冲突。

当前版本验证命令：

```powershell
npm test
npm run lint
npm run build
node --check server/index.mjs
node --check electron/main.mjs
```
