# SELENE 事件导入

THEIA 的设备时间线数据只接收独立 Android 或 Windows 项目 **SELENE** 的输出。SELENE
事件与聊天记录、日记条目严格分开：它们描述某个时间段的设备或日历背景，
不是用户说过的话。因此它们只能帮助自我分析保持时间线完整，不能单独证明
情绪、诊断、动机、用药决定或因果关系。

## 接入目录与不可变快照

在 THEIA 中连接 SELENE 选择的父目录。每次采集都会新建一个不可变子目录：

```text
SELENE-v1-20260806T185439123Z/
  context-events.json
```

THEIA 会递归扫描这些子目录，仅接受以下 UTF-8 JSON 外层结构。旧伴生程序
格式会被明确拒绝，不再作为兼容输入。

```json
{
  "schema": "selene-context-events/v1",
  "device": { "platform": "android" },
  "generatedAt": "2026-08-06T18:54:39.123Z",
  "producer": {
    "name": "SELENE",
    "version": "0.3.0",
    "layout": "immutable-snapshot-v1"
  },
  "events": []
}
```

`producer` 标识确保普通 JSON 或旧格式不会被误认成 SELENE 数据。SELENE
从不回写、合并或删除旧快照。若两个采集窗口存在重叠，THEIA 会按稳定的
`id` 去重，并保留快照相对路径作为来源信息。

## 事件结构

```ts
type SeleneEventKind =
  | 'calendar' | 'location' | 'movement' | 'screen-time' | 'activity'
  | 'health' | 'payment' | 'device' | 'custom'

interface SeleneEvent {
  id: string
  version: 1
  kind: SeleneEventKind
  source: 'selene'
  startAt: string
  endAt?: string
  title: string
  summary?: string
  values?: Record<string, string | number | boolean>
  capturedAt: string
  importedAt?: string
  privacy: 'coarse' | 'precise'
}
```

时间戳无效、或 `source` 不等于 `selene` 的事件会被丢弃。精确坐标仅在
THEIA 本地保存。发送给模型的是粗粒度投影：坐标、地址、地理哈希及类似
字段会被移除；地点事件最多保留 `values.placeTag`。

## 分析边界

- 聊天原文和日记原文仍是唯一可引用、可核验的证据。
- SELENE 事件只用于定位时间和行为背景；同一时期出现不代表因果关系。
- 某段时间没有采集到数据只代表覆盖不足，不能据此推断那段生活状态。
- 当前 SELENE 可导出日历、屏幕使用汇总、前台应用时段、设备/电量/屏幕
  状态、网络状态、匿名 Wi-Fi 指纹、可选后台位置和已确认的运动汇总。运动汇总
  只记录时长、距离、大致速度和样本数；精确坐标仍是单独的精确位置事件，绝不
  发送给模型。它不采集通知正文、短信、
  通话、键盘输入、截图、其他应用数据库或支付历史。

采集行为、权限和快照写入规则请见 SELENE 的 Android 与 Windows 文档。
