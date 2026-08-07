# HYPERION QQ Bot API

The optional QQ Bot is a local input surface, not a second database. The Bot
in the sibling `IRIS` repository uses the official `@tencent-connect/qqbot-nodejs`
SDK, while HYPERION listens only on `127.0.0.1`. It never reads raw archive files
and must not call `/api/sync/snapshot`.

## Data boundary

The Bot receives compact task/person summaries, appends journal and check-in
records through HYPERION's append-only writer, and reads only coarse SELENE and AI
runtime summaries. Raw chat bodies, API keys, exact locations, archive paths,
and complete state snapshots never cross the Bot boundary.

## Endpoints

```text
GET  /api/bot/summary
GET  /api/bot/ai
GET  /api/bot/selene
GET  /api/bot/quests
GET  /api/bot/people?q=
POST /api/bot/journal          { "content": "..." }
POST /api/bot/check-in         { "mood": 1..5, "sleepHours": 0..24, ... }
POST /api/bot/quests/:id/complete
```

State mutations are serialized with the same file lock as browser and desktop
writes. A journal is an archive delta upsert; a check-in has the stable id
`self-checkin-YYYY-MM-DD` and mirrors itself as a self-journal archive row.

See [QQ_BOT.zh-CN.md](QQ_BOT.zh-CN.md) for the full JSON examples, privacy
boundary, owner binding rules, and command list.
