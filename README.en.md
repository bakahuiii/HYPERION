# THEIA

[简体中文](README.md) | [English](README.en.md)

THEIA is a local-first personal task-atlas application. It turns conversations and deliberate personal records into reviewable tasks, schedules, people, and places while preserving traceable source evidence.

Alongside JSON, CSV, and TXT imports, THEIA can manage the local MNEMO WeChat adapter. After the user captures a key once for their own account in MNEMO, the adapter makes read-only local snapshots and continuously delivers deltas to THEIA. Keys, message bodies, and avatars never leave the machine through MNEMO. Records leave the machine only when the user enables model analysis with a configured provider.

> Current source version: `0.6.0`. Windows x64 NSIS and portable builds bundle Electron and Node.js. Tasks, settings, conversation archives, and logs are stored under `%APPDATA%\THEIA` in an installed build. Back up important data regularly.

## Changelog

**0.6.0**

- Added MNEMO, a THEIA-managed local WeChat sidecar with idempotent stable IDs and no repeated manual import after one local key capture.
- Readable conversation copies use the contact remark first and nickname second: `remark-or-nickname/remark-or-nickname.json`. THEIA content-addresses and verifies locally captured avatar files.
- New archive deltas feed the existing per-conversation incremental analysis watermarks, so the next automatic pass sends only changed messages plus bounded context.

**0.5.0**

- Added manual journal entries, daily check-ins, and AI-conversation import. A user-selected self-analysis produces source-linked longitudinal observations.
- Moved large conversation archives to integrity-checked append-only gzip JSONL segments, with recovery, paging, and large-file parsing improvements.
- Expanded session/channel observability and regression coverage. The multi-model adjudication data contract is present; actual multi-model fan-out is not enabled yet.

See [Release Notes](docs/RELEASE_NOTES.md) for the full history.

## Interface Preview

<p align="center">
  <img src="docs/screenshots/task-atlas.png" alt="THEIA zoomable task atlas" width="100%">
</p>
<p align="center"><sub>A zoomable, pannable task atlas with drag-based classification</sub></p>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/intel-workbench.png" alt="THEIA intelligence archive and model-analysis workbench"><br><sub>Archive intake and model-analysis workbench</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/appearance-customization.png" alt="THEIA appearance customization"><br><sub>Theme, avatar, and global-background customization</sub></td>
  </tr>
</table>

## Current Capabilities

- Recursively scan exported directories and import JSON, CSV, and TXT grouped by conversation.
- Manage authorized MNEMO incremental WeChat intake, readable remark/nickname-named conversation copies, and THEIA-owned local avatar storage.
- Preserve message text, time, sender, speaker direction, message type, platform, conversation, and avatar URL.
- Select full conversations by last-contact time, or strictly crop messages to an exact time interval.
- Segment oversized conversations continuously without random message sampling, retaining bounded overlap between adjacent segments.
- Balance independent conversations across multiple OpenAI-compatible provider channels while preserving chronological order inside each conversation.
- Analyze tasks and people with different stable context budgets; validate candidates before they enter the review queue.
- Review, edit, select, generate, dismiss, and feed back on task candidates before they become application state.
- Build evidence-linked person cards, cache accessible avatars, and sort people using relationship signals.
- Display tasks as a zoomable, pannable atlas with drag-based ordering and classification. Task completion is shared with the schedule.
- Search using public geocoding, and create, drag, edit, delete, or approximate map markers.
- Generate optional task guidance using linked people, time, place, and weather when weather is available for the next 16 days.
- Separate large archives, lightweight UI state, INI settings, media, and logs so large datasets do not require whole-state rewrites.
- Use Chromium GPU compositing by default, with an explicit software-rendering fallback.

## Requirements

| Item | Requirement |
| --- | --- |
| Operating system | Packaged launchers target Windows 10/11 x64; source may be adapted to other desktop systems |
| Node.js | Minimum `22.12.0`; Node.js 24 LTS x64 recommended; validated with `24.13.0` |
| npm | Installed with a supported Node.js version; validated with `11.18.0` |
| Disk | At least 1 GB for development dependencies, plus archives, media, logs, and release artifacts |
| Memory | 8 GB minimum recommended; 16 GB or more for hundreds of thousands of messages |
| Browser | Current Chrome or Edge for browser mode and File System Access API directory connections |
| Network | Required for first dependency install and for remote maps, geocoding, avatars, weather, quotations, or model services |
| Model service | Optional; analysis requires a valid OpenAI-compatible endpoint and API key |

Node.js 20 is not the actual supported baseline. Vite 8 and Electron 43 require Node.js `22.12.0` or newer.

## Quick Start

### Source workspace

Open PowerShell in the repository root:

```powershell
npm install
npm run desktop
```

Browser development mode:

```powershell
npm run dev
```

Open the local address printed by Vite, normally `http://127.0.0.1:5173/`. Do not open `index.html` directly; settings, model access, map proxying, and shared persistence require the local Node service.

Development and distribution checks:

```powershell
npm test
npm run test:e2e
npm run test:desktop-smoke
npm run dist:installer
```

### Installer and portable editions

The NSIS installer and portable package include their own runtime; they do not require Node.js or `npm install`. Installed mutable data lives under `%APPDATA%\THEIA`.

The source-release package is intended for inspection and customization. Install dependencies from its `app` directory, then use the provided desktop or browser launcher from the package root.

## First Run

1. Set a display name, avatar, theme, and global background under Options.
2. Add an API root and key under Model Provider Pool, then detect and select a model. Add genuinely independent channels only when needed.
3. Keep API mode on Auto unless the provider requires a specific compatible endpoint.
4. Import one small example or one private conversation in the Intelligence Archive.
5. Inspect the conversation and verify time, speaker, and `you / other person` direction.
6. Run the first analysis with a strict time range. Review candidates and person evidence before expanding scope.
7. Generate accepted tasks. Dismiss unsuitable candidates with a reason so later prompts can incorporate that feedback.

For the one-time MNEMO setup, local paths, status endpoint, and troubleshooting, see [MNEMO Integration](docs/MNEMO.md). MNEMO complements rather than replaces JSON/CSV/TXT imports.

## Data Flow

```text
User-selected JSON / CSV / TXT          Local MNEMO read-only snapshot
                |
                v
      Browser parsing and deduplication          Immutable deltas
                |                                      |
                +------------------+-------------------+
                |
                +----> Raw archive (gzip JSONL segments / IndexedDB v2)
                |
                v
      User selects conversations and starts analysis
                |
                v
       127.0.0.1:8787 local service
                |
                v
          User-configured model provider
                |
                v
        Task candidates + person evidence + guidance
                |
                v
         User review before durable application state
```

Model credentials are sent only to the loopback service. Packaged Electron uses `safeStorage` and stores a credential reference in INI. Plain Node/browser development cannot access the Electron credential backend and retains a documented plaintext compatibility path. Treat the entire runtime data directory as sensitive.

## Runtime Layout

```text
THEIA runtime/
  assets/img/
    backgrounds/             user backgrounds
    avatars/                 downloaded and MNEMO-captured contact avatars
  data/
    state.json               tasks, people, places, candidates, atlas layout
    chat-archive/             append-only gzip JSONL segments
    chat-archive.json.gz      legacy archive retained for migration/rollback
    chat-archive.meta.json    schema and archive watermarks
    mnemo-inbox/              immutable batches written by MNEMO and read by THEIA
    mnemo-export/             readable conversation copies named by remark or nickname
    settings.ini             appearance, prompts, provider metadata, credentialRef
    credentials.json         Electron safeStorage ciphertext container
    migrations/              pre-migration backups
    electron/                Chromium profile
    runtime/desktop.pid      desktop process marker
    examples/                fictional examples
  logs/
    ai-debug.jsonl           pipeline summaries without message bodies
    tasks/*.jsonl.gz         compressed per-work-unit model input/output logs
```

Task logs may contain full conversation text. Never publish runtime `data/`, `logs/`, or downloaded avatars.

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start local API and Vite browser development server |
| `npm run desktop` | Start Electron, local API, and Vite |
| `npm test` | Run deterministic importer, segmentation, validation, storage, migration, recovery, and provider tests |
| `npm run test:e2e` | Run task-atlas, drag, map-setting, and storage-health visual tests |
| `npm run test:desktop-smoke` | Verify Electron startup and safeStorage credential migration in an isolated runtime |
| `npm run test:unpacked-smoke` | Start the generated unpacked `THEIA.exe` |
| `npm run build` | Run TypeScript project checks and build `dist/` |
| `npm run lint` | Run ESLint |
| `npm run dist:installer` | Build a Windows x64 NSIS installer locally |
| `npm run dist:exe` | Build a portable Windows x64 directory locally |

## Documentation

- [Developer Guide](docs/DEVELOPER_GUIDE.en.md): architecture, storage, model workflow, API boundaries, performance, and release controls.
- [Chinese Release Notes](docs/RELEASE_NOTES.md): version changes, compatibility, limitations, and validation.
- [Chinese User Guide](docs/USER_GUIDE.md): installation and operation for first-time users.
- [API Protocol](docs/API_PROTOCOL.md): field-level local HTTP and upstream model protocol reference.
- [Chat Export Format](docs/CHAT_EXPORT_FORMAT.md): JSON/CSV/TXT fields, directory layout, speaker direction, and avatars.
- [MNEMO Integration](docs/MNEMO.md): local WeChat intake, naming, avatar storage, status, and troubleshooting.
- [Troubleshooting](docs/TROUBLESHOOTING.md): startup, ports, GPU, imports, empty candidates, 502/403, maps, and recovery.
- [Privacy and Data](docs/PRIVACY_AND_DATA.md): sensitivity levels, model transmission, backup, migration, and redaction.
- [Versioning](docs/VERSIONING.md): local layout, semantic versions, checksums, tags, and rollback.

## Boundaries

- Tasks and person descriptions come from probabilistic models and require user review.
- Unknown speaker direction remains unknown; THEIA must not infer `you` from a nickname.
- Maps, weather, quotations, and remote avatars depend on third-party public services and their policies.
- The minimum automatic-analysis interval is 24 hours and currently requires the application page to stay open.
- Conversation bodies are not stored in an encrypted database. Protect the Windows account, disk, backups, and runtime directory.
- MNEMO handles only an account explicitly authorized by its local one-time key capture. It does not bypass login, collect other accounts, transmit keys, or support remote or unauthorized collection.
