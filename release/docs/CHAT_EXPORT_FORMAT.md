# HYPERION 聊天导出格式

本文说明如何把第三方导出工具的结果整理成 HYPERION 能可靠解析的格式。最重要的不是“JSON 能打开”，而是每条消息都能保留会话边界、时间、正文、发言人和发言方向。

## 1. 推荐目录结构

一个文件夹表示一个会话，并在上层明确标注私聊或群聊：

```text
聊天导出/
├─ 私聊/
│  ├─ 林晓/
│  │  ├─ messages-2026-06.json
│  │  └─ messages-2026-07.json
│  └─ 周然/
│     └─ messages.json
└─ 群聊/
   └─ 班级通知群/
      └─ messages.json
```

分类文件夹关键词不区分大小写：

| 会话类型 | 可识别关键词 |
| --- | --- |
| 私聊 | `私聊`、`单聊`、`好友`、`friend`、`direct`、`personal` |
| 群聊 | `群聊`、`群组`、`群消息`、`group`、`groups`、`chatroom` |

HYPERION 使用分类文件夹下一层作为会话身份。不要把所有人的 JSON 直接放在同一个 `私聊/` 目录，也不要把同一个人的每个月放成同级会话文件夹。

## 2. 最佳 JSON 结构

推荐每个会话文件包含 session 和 messages：

```json
{
  "session": {
    "id": "demo-contact-001",
    "displayName": "林晓",
    "avatar": "https://example.invalid/avatar/demo.png",
    "kind": "direct"
  },
  "messages": [
    {
      "formattedTime": "2026-07-28 18:30:00",
      "type": "text",
      "content": "周六下午去图书馆讨论开学材料，可以吗？",
      "senderDisplayName": "林晓",
      "senderId": "contact-001",
      "selfId": "me-001",
      "isSelf": false,
      "avatar": "https://example.invalid/avatar/demo.png"
    },
    {
      "formattedTime": "2026-07-28 18:31:12",
      "type": "text",
      "content": "可以，三点在东门见。",
      "senderDisplayName": "示例用户",
      "senderId": "me-001",
      "selfId": "me-001",
      "isSelf": true
    }
  ]
}
```

`example.invalid` 永远不会联网，仅用于说明。实际头像 URL 必须来自你的合法导出。

## 3. 字段映射

字段名会先转为小写，并移除下划线、空格和连字符。因此 `sender_display_name`、`sender-display-name` 和 `senderDisplayName` 都映射为同一规范键。

### 3.1 正文

支持：

```text
content, text, message, msg, body, messageContent, msgContent
```

正文必须是字符串，去掉首尾空白后至少两个字符。对象、数组或二进制不会直接当作正文。图片消息建议在 `content` 中保留 OCR 文本、说明或可审查的相对文件名，例如：

```json
{
  "type": "image",
  "content": "[图片] 校历截图；OCR：9月7日学生报到",
  "formattedTime": "2026-07-20 09:12:00",
  "senderDisplayName": "辅导员",
  "isSelf": false
}
```

### 3.2 时间

支持字段：

```text
timestamp, time, datetime, date, formattedTime, createTime,
sendTime, msgTime
```

支持的值：

- 10 位 Unix 秒；
- 13 位 Unix 毫秒；
- `2026-07-29 01:48:30`；
- `2026/07/29 01:48`；
- `2026年7月29日 1时48分30秒`；
- JavaScript 可解析且包含可靠年份的其他日期字符串。

推荐始终导出完整年份和时区一致的本地时间。`07-29 01:48:30` 没有年份，不能独立用于任务目标时间。HYPERION 不会用文件修改时间补聊天时间。

### 3.3 发言人名称

支持：

```text
sender, senderName, senderDisplayName, from, nickname, author,
username, talker
```

字段值可以是字符串，也可以是嵌套对象。嵌套对象内支持：

```text
displayName, senderDisplayName, nickname, remark, remarkName,
name, username
```

群聊必须为每条消息提供发言人。私聊也应提供，因为它有助于展示来源和头像映射，但不能仅靠名称判断 self/other。

### 3.4 消息类型

支持：

```text
type, msgType, messageType
```

类型最长保留 80 字符。推荐使用稳定短值：`text`、`image`、`file`、`voice`、`video`、`system`、`link`。如果导出器把 `type` 用作方向（例如 `发送`/`接收`），HYPERION 也能识别方向，但此时会失去准确消息类型，最好另加 `direction`。

### 3.5 发言方向

这是最关键字段。推荐直接提供：

```json
"isSelf": true
```

支持的布尔/方向字段：

```text
isSend, isSendMsg, isSendMessage, isSendByMe, isOutgoing,
isSelf, isFromMe, fromMe, fromSelf, outgoing, self
```

这些字段中 `true`/`1`/`yes`/`self`/`me`/`outgoing`/`send`/`sent` 表示你；`false`/`0`/`no`/`other`/`incoming`/`receive`/`received` 表示对方。

也支持：

```text
direction, msgDirection, messageDirection, senderRole
```

推荐值：`self`、`other`、`outgoing`、`incoming`。

若没有方向字段，可以同时提供本人 ID 和发送者 ID：

```text
selfUin / myUin / selfId / myId / myAccountId
senderUin / senderId / fromUin / fromId / authorId / senderAccountId
```

二者完全相等表示 self，不等表示 other。不要只提供昵称并要求 HYPERION 猜测；备注名、群名片、改名和同名都会导致执行者反转。

### 3.6 头像

支持字段：

```text
avatar, avatarUrl, headImg, headImgUrl, headUrl, head,
headImage, headImageUrl, smallHead, smallHeadUrl, bigHead,
bigHeadUrl, face, faceUrl, icon, iconUrl, profileImage,
profileImageUrl, portrait
```

值可以是 HTTP(S) URL、`data:image/...`，或带 `url`/`uri`/`src`/`href` 的嵌套对象。HYPERION 会递归检查 message、sender/profile/contact/userInfo/senderInfo，以及任意层级的 `session` 对象。

远程头像显示还受本地代理白名单限制。当前只允许常见 QQ/微信图床域名，避免任意 URL 导致 SSRF。其他平台头像建议由导出工具转为 data URL，或未来扩展受信域名配置。

## 4. CSV 格式

推荐首行：

```csv
formattedTime,type,content,senderDisplayName,isSelf,avatar
```

示例：

```csv
formattedTime,type,content,senderDisplayName,isSelf
2026-07-28 18:30:00,text,周六下午去图书馆讨论材料，可以吗？,林晓,false
2026-07-28 18:31:12,text,可以，三点东门见。,示例用户,true
```

正文包含逗号时用双引号，正文内双引号写成两个双引号。当前解析器支持常见带引号 CSV，但复杂多行单元格、非 UTF-8 编码和不规则列更适合先转换为 JSON。

## 5. TXT 格式

最可靠格式：

```text
2026-07-28 18:30:00 林晓: 周六下午去图书馆讨论材料，可以吗？
2026-07-28 18:31:12 示例用户: 可以，三点东门见。
```

TXT 通常没有独立 `isSelf` 字段，所以发言方向会是 unknown。它适合只读浏览或群聊摘要，不适合依赖“谁答应谁”的任务和人物提炼。若能控制导出工具，优先 JSON。

## 6. JSON 递归解析规则

HYPERION 不要求固定顶层键。它递归进入对象和数组，并把上层发现的时间、发言人、类型、头像和方向传给子消息。某个对象一旦发现正文，就把它作为一条消息，不再把其子字段重复解析。

这支持以下结构：

```json
{
  "session": { "avatar": "https://..." },
  "pages": [
    {
      "date": "2026-07-28",
      "items": [
        { "time": "2026-07-28 18:30:00", "message": "内容", "sender": { "nickname": "林晓" }, "direction": "incoming" }
      ]
    }
  ]
}
```

如果完全识别不到消息对象，HYPERION 会把 JSON 的叶子值扁平化成普通文本作为最后降级。这会丢失可靠结构，不应作为正式导入成功的标准。

## 7. 去重与更新

每条导入 ID 基于：

```text
相对路径 | 时间 | 发言人 | 正文 | 文件内索引
```

目录扫描签名还包括文件路径、大小、修改时间和导入器版本。相同文件再次扫描会跳过；文件变化后重新解析，并尽量匹配更新旧记录。

修改旧文件中消息顺序会改变文件内索引，可能产生新 ID。稳定导出工具应追加新消息，不要每次随机重排全部历史。

## 8. 文件和目录限制

| 限制 | 当前值 |
| --- | --- |
| 支持扩展名 | `.json`、`.csv`、`.txt` |
| 单文件最大 | 50 MB（目录扫描） |
| 单次扫描最大文件数 | 20,000 |
| 最大目录深度 | 24 |
| 模型请求 JSON body | 256 MB |
| 单次模型附件 | 最多 4 个 |
| 单附件 | 最大 8 MB |
| 背景/用户头像上传 | 最大 20 MB |

单个 JSON 超过 50 MB 时，应按月份或合理时间段拆成多个文件，但仍放在同一个会话目录。不要按固定 100 条切成数千个文件，会增加扫描和归档开销。

## 9. 提交模型前检查表

- [ ] 会话数量与导出目录大致一致。
- [ ] 私聊和群聊分类正确。
- [ ] 选一个私聊，确认 self/other 没有反转。
- [ ] 时间包含年份，排序正确。
- [ ] 正文不是 `[object Object]` 或大量无意义元数据。
- [ ] 头像 URL 来自对方 session，而不是误用本人头像。
- [ ] 系统通知、撤回和支付消息有清楚的 type。
- [ ] 文件路径和会话名称不包含临时随机目录，避免重复会话。
- [ ] 先用严格时间和单一会话做模型测试。

## 10. 导出器适配建议

如果要为 HYPERION 编写适配器，优先输出一个规范化中间格式，而不是让 UI 继续增加平台特例：

```ts
interface NormalizedMessage {
  formattedTime: string
  type: string
  content: string
  senderDisplayName: string
  speakerRole: 'self' | 'other' | 'unknown'
  senderId?: string
  selfId?: string
  avatar?: string
}
```

适配器应记录自身版本、来源平台、导出账户 ID、时区和附件根目录。严禁在适配器里把无法确认的方向默认成 other；unknown 比错误方向更安全。
