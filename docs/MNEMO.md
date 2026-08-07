# MNEMO: HYPERION's Local WeChat Intake

MNEMO is a small, independent local adapter controlled by HYPERION. It turns the currently signed-in local WeChat account's database changes into a durable HYPERION archive. HYPERION starts and stops the agent, owns the outbox, validates every batch, stores the avatar files, and decides when a changed conversation is analysed. MNEMO never writes HYPERION's append-only archive directly.

## First-Time Setup

1. Start the local Windows WeChat desktop app and sign in to the account whose local history you want HYPERION to archive.
2. Start HYPERION. In a source workspace, HYPERION automatically finds the sibling MNEMO directory. In a packaged or relocated installation, set `HYPERION_MNEMO_HOME` to that directory before starting HYPERION.
3. Leave HYPERION running. MNEMO is started in the background and rechecks the local database every 30 seconds; no GUI, directory grant, key-capture step, or later manual folder import is required.

When WeChat is not running, not signed in, or has not created a readable local account directory yet, MNEMO stays alive in a silent waiting state. HYPERION reports only malformed batches, archive failures, a missing adapter, or another actual local processing failure. HYPERION accepts chat batches only from its own MNEMO outbox; external JSON inboxes and the former directory/file import UI are disabled.

MNEMO reads the active local WeChat process to obtain the per-database keys needed for a read-only snapshot. Key material is kept only in MNEMO's private local directory; it is never placed in HYPERION's archive, inbox, logs, readable exports, avatar cache, model prompts, or network requests.

When more than one account directory exists, MNEMO automatically selects the account with the most recently updated local database. Set `HYPERION_MNEMO_ACCOUNT` to an account directory to select a different one deliberately:

```powershell
$env:HYPERION_MNEMO_HOME = (Resolve-Path '..\..\WECHAT-Exporter').Path
$env:HYPERION_MNEMO_ACCOUNT = '<wechat-data-root>\wxid_example'
```

Set `HYPERION_MNEMO_DISABLED=1` to prevent the sidecar from starting. The setting is useful for maintenance; it does not delete any archived records.

## Continuous Data Flow

1. Every 30 seconds MNEMO discovers the active local account and checks its message, contact, session, and avatar database metadata.
2. A change causes a read-only decrypted snapshot. WeChat 4.x `Msg_<hash>` tables are mapped through `session.db` before records are emitted; opaque binary payloads become a message-type marker instead of chat text.
3. MNEMO emits immutable `mnemo-delta/v1` batches containing only new messages. A parser correction can also send account-scoped deletion IDs, allowing HYPERION to remove stale MNEMO records without touching any other archive source.
4. HYPERION checks the batch schema, timestamps, field limits, and stable IDs; it deduplicates, updates, or removes accepted MNEMO records in its unified `hyperion-intel-archive/v1` store.
5. The renderer polls archive deltas. Automatic analysis sees changed conversation watermarks and is eligible on its next one-minute check.

The stable message ID is based on the account, database, table, and WeChat local ID, never on a remark, nickname, folder name, or avatar. Restarting either process and replaying a batch are therefore idempotent.

## Readable Conversation Copies

HYPERION also owns a readable MNEMO export tree. It is an audit convenience; the append-only HYPERION archive remains the authoritative unified database.

```text
data/mnemo-export/
  <account>/
    direct/
      <contact remark or nickname>/
        <contact remark or nickname>.json
    group/
      <group remark or nickname>/
        <group remark or nickname>.json
```

Development uses `.hyperion-mnemo-export/` instead. A Windows-safe filename is derived from the contact remark first, then the nickname, and finally the stable WeChat identifier. A short hash is added only when two conversations would otherwise collide. When a remark changes, MNEMO moves the existing readable conversation copy to the new name; the message IDs and HYPERION archive identity do not change.

Each conversation JSON is `mnemo-conversation-export/v1`. It contains its stable conversation ID, current display name, optional local avatar ID, and deduplicated normalized messages. It contains no WeChat key and no base64 image data.

## Avatar Ownership

MNEMO reads `head_image.db` only from its snapshot. It accepts JPEG, PNG, GIF, WebP, and AVIF only after inspecting the binary signature and rejects empty, malformed, and oversized blobs. Valid images are content-addressed with SHA-256 and written directly to HYPERION's avatar cache:

```text
assets/img/avatars/mnemo-<sha256>.<extension>
assets/img/avatars/mnemo-<sha256>.json
```

Development uses `.hyperion-avatar-cache/`. Archive records refer to a local route, `/api/media/avatar/local?id=<sha256>`; the server validates the ID, metadata, filename, file type, size, and image signature before returning the image. No local filesystem path is exposed to the renderer or recorded in a chat batch.

## Status And Recovery

`GET /api/mnemo/status` is a local diagnostics endpoint. It reports whether MNEMO is enabled and available, whether the agent has a live process ID, whether it is waiting or ready, the HYPERION-owned directory, watcher progress, and a bounded setup/runtime state. It never returns message bodies, keys, avatar bytes, or account content.

- WeChat is not running: MNEMO waits silently. Start and sign in to the local Windows WeChat desktop app; the next check resumes automatically.
- an in-app MNEMO error: check the local archive and batch file first. A malformed immutable batch is rejected rather than imported.
- no live process: verify `HYPERION_MNEMO_HOME` and Python availability. HYPERION will not guess a non-existent agent path.
- pending batches: keep HYPERION running. The watcher imports immutable files in order and safely resumes after interruption.
- wrong account: set `HYPERION_MNEMO_ACCOUNT` explicitly and restart HYPERION. Existing archive records are not removed automatically.

## Incremental Analysis Timing

HYPERION stores an analysis watermark for every conversation. A MNEMO delta changes that watermark, so the conversation is considered at the next automatic workflow check (normally within one minute when automatic analysis and a usable provider are enabled). The request contains new messages plus up to 16 preceding messages for context, not the entire archive.

`intervalHours` remains a 24-hour minimum for routine unchanged conversations. It does not delay a conversation whose MNEMO watermark changed.

## Backup Boundary

Treat the HYPERION runtime's archive, readable MNEMO export, avatar cache, and MNEMO private key directory as sensitive local data. Back up the runtime and MNEMO private directory together when you need a restorable setup. Do not commit, upload, or share either directory.
