# MNEMO: THEIA's Local WeChat Intake

MNEMO is a small, independent local adapter controlled by THEIA. It has one job: turn the authorized account's local WeChat database changes into a durable THEIA archive. THEIA starts and stops the agent, owns the outbox, validates every batch, stores the avatar files, and decides when a changed conversation is analysed. MNEMO never writes THEIA's append-only archive directly.

## First-Time Setup

1. Run MNEMO's GUI (`run_gui.cmd` in the MNEMO source directory) and complete the one-time login-key capture for the account you own.
2. Start THEIA. In a source workspace, THEIA automatically finds the sibling MNEMO directory. In a packaged or relocated installation, set `THEIA_MNEMO_HOME` to that directory before starting THEIA.
3. Leave THEIA running. No later manual folder import is required.

The captured key stays in MNEMO's private directory. It is not placed in THEIA's archive, inbox, logs, readable exports, avatar cache, model prompts, or network requests.

When more than one account directory exists, MNEMO automatically selects the account with the most recently updated local database. Set `THEIA_MNEMO_ACCOUNT` to an account directory to select a different one deliberately:

```powershell
$env:THEIA_MNEMO_HOME = 'H:\work\WECHAT-Exporter'
$env:THEIA_MNEMO_ACCOUNT = 'D:\xwechat_files\wxid_example'
```

Set `THEIA_MNEMO_DISABLED=1` to prevent the sidecar from starting. The setting is useful for maintenance; it does not delete any archived records.

## Continuous Data Flow

1. Every 30 seconds MNEMO checks the local message, contact, and avatar database metadata.
2. A change causes a read-only decrypted snapshot. MNEMO emits immutable `mnemo-delta/v1` batches containing only new messages plus a bounded replay window.
3. THEIA checks the batch schema, timestamps, field limits, and stable IDs; it deduplicates and appends accepted records to its unified `theia-intel-archive/v1` store.
4. The renderer polls archive deltas. Automatic analysis sees changed conversation watermarks and is eligible on its next one-minute check.

The stable message ID is based on the account, database, table, and WeChat local ID, never on a remark, nickname, folder name, or avatar. Restarting either process and replaying a batch are therefore idempotent.

## Readable Conversation Copies

THEIA also owns a readable MNEMO export tree. It is an audit convenience; the append-only THEIA archive remains the authoritative unified database.

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

Development uses `.theia-mnemo-export/` instead. A Windows-safe filename is derived from the contact remark first, then the nickname, and finally the stable WeChat identifier. A short hash is added only when two conversations would otherwise collide. When a remark changes, MNEMO moves the existing readable conversation copy to the new name; the message IDs and THEIA archive identity do not change.

Each conversation JSON is `mnemo-conversation-export/v1`. It contains its stable conversation ID, current display name, optional local avatar ID, and deduplicated normalized messages. It contains no WeChat key and no base64 image data.

## Avatar Ownership

MNEMO reads `head_image.db` only from its snapshot. It accepts JPEG, PNG, GIF, WebP, and AVIF only after inspecting the binary signature and rejects empty, malformed, and oversized blobs. Valid images are content-addressed with SHA-256 and written directly to THEIA's avatar cache:

```text
assets/img/avatars/mnemo-<sha256>.<extension>
assets/img/avatars/mnemo-<sha256>.json
```

Development uses `.theia-avatar-cache/`. Archive records refer to a local route, `/api/media/avatar/local?id=<sha256>`; the server validates the ID, metadata, filename, file type, size, and image signature before returning the image. No local filesystem path is exposed to the renderer or recorded in a chat batch.

## Status And Recovery

`GET /api/mnemo/status` is a local diagnostics endpoint. It reports whether MNEMO is enabled and available, whether the agent has a live process ID, the THEIA-owned directories, watcher progress, and a bounded setup/runtime state. It never returns message bodies, keys, avatar bytes, or account content.

- `setup required`: open MNEMO's GUI and complete the one-time key capture; restart THEIA afterwards.
- no live process: verify `THEIA_MNEMO_HOME`, then inspect the local MNEMO GUI/key setup. THEIA will not guess a non-existent agent path.
- pending batches: keep THEIA running. The watcher imports immutable files in order and safely resumes after interruption.
- wrong account: set `THEIA_MNEMO_ACCOUNT` explicitly and restart THEIA. Existing archive records are not removed automatically.

## Incremental Analysis Timing

THEIA stores an analysis watermark for every conversation. A MNEMO delta changes that watermark, so the conversation is considered at the next automatic workflow check (normally within one minute when automatic analysis and a usable provider are enabled). The request contains new messages plus up to 16 preceding messages for context, not the entire archive.

`intervalHours` remains a 24-hour minimum for routine unchanged conversations. It does not delay a conversation whose MNEMO watermark changed.

## Backup Boundary

Treat the THEIA runtime's archive, readable MNEMO export, avatar cache, and MNEMO private key directory as sensitive local data. Back up the runtime and MNEMO private directory together when you need a restorable setup. Do not commit, upload, or share either directory.
