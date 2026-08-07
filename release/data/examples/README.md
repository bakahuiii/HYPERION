# 示例导入文件

`sample-chat-export.json` 和 `sample-chat-export.csv` 展示 HYPERION 可识别的最小字段：

- `formattedTime`：消息时间。
- `type`：消息类型，例如 `text`。
- `content`：消息正文。
- `senderDisplayName`：发言人名称。
- `isSelf`：是否为“你”的发言，必须尽可能由导出工具提供。

示例会话是虚构内容，仅供验证导入和模型提炼流程。真正的聊天导出格式可以不同；在情报库导入后，先检查单一会话时间线与“你/对方”的发言方向是否正确，再提交给模型。
