# THEIA Developer Guide

[简体中文](DEVELOPER_GUIDE.md) | [English](DEVELOPER_GUIDE.en.md)

This guide is for engineers who maintain, review, extend, or package THEIA. It describes source version `0.4.1` and treats `package-lock.json`, `server/index.mjs`, and the current implementation as authoritative. Planned capabilities are not described as complete. For field-level local HTTP, upstream model JSON, session batching, and log formats, use [API_PROTOCOL.md](API_PROTOCOL.md) alongside this guide.

## 1. System and Engineering Boundary

THEIA is currently a single-user, local-first personal task-atlas application. The user deliberately supplies exported files. The browser parses and selects locally. The loopback Node.js service persists state, proxies controlled media requests, and forwards selected content to user-configured model providers. Engineering must preserve time, provenance, speaker direction, and revision. Inference must not masquerade as fact. Person descriptions must not turn isolated temporary states into stable labels. Guidance must not become prediction, scoring, manipulation, or moral judgment.

The project does not implement:

- login bypass for WeChat, QQ, school platforms, or other services;
- credential extraction or cracking;
- decryption of unauthorized private databases;
- silent background scraping of chats or social feeds;
- treatment of model output as an unquestionable fact database;
- cloud accounts, multi-user collaboration, or remote synchronization.

Source, portable, and electron-builder NSIS packaging are supported. Crash markers, schema migration backups, rollback scripts, and GitHub update checks exist locally; remote crash reporting and telemetry do not. Conversation bodies are not encrypted at rest. Packaged Electron protects provider keys using operating-system `safeStorage`; plain Node development retains a documented plaintext compatibility fallback.

## 2. Locked Technology Stack

Versions below come from the current lockfile and installed dependency graph rather than a floating `latest` range.

| Layer | Technology | Version | Role |
| --- | --- | --- | --- |
| Runtime | Node.js | validated on 24.13.0 | local service, scripts, Vite, Electron main process |
| Package manager | npm | validated on 11.18.0 | dependency installation and scripts |
| Frontend | React / React DOM | 19.2.8 | views, state, interactions |
| Language | TypeScript | 5.8.3 | frontend and shared type checking |
| Build | Vite | 8.1.5 | development server, HMR, production build |
| Desktop shell | Electron | 43.2.0 | Windows desktop window, Chromium, GPU composition |
| Installer/update | electron-builder / electron-updater | 26.15.3 / 6.8.9 | NSIS, GitHub update metadata, optional signing |
| UI regression | Playwright | 1.62.1 | browser visual/drag tests and Electron smoke tests |
| Model SDK | OpenAI JS | 7.0.0 | retained dependency; core compatibility calls use service-side `fetch` |
| Map | Leaflet | 1.9.4 | tiles, markers, approximate areas, drag editing |
| Icons | Lucide React | 1.27.0 | application iconography |
| Static analysis | ESLint / typescript-eslint | 10.8.0 / 8.65.0 | lint and TypeScript rules |

The practical minimum Node.js version is `22.12.0`. Node.js 24 LTS is recommended so development and release environments do not drift.

## 3. Source Layout

```text
.
├─ electron/
│  └─ main.mjs                 Electron lifecycle, GPU flags, local service startup
├─ release-tools/
│  ├─ package-release.mjs      clean source-release generator
│  └─ package-portable-exe.mjs portable Windows runtime builder
├─ scripts/
│  ├─ dev.mjs                  API and Vite development orchestration
│  ├─ release-dev.mjs          browser entry for release layout
│  └─ release-desktop.mjs      desktop entry for release layout
├─ server/
│  ├─ index.mjs                HTTP API, model forwarding, maps, avatars, logs, snapshots
│  ├─ archiveStore.mjs         append-only conversation archive
│  ├─ providerConfig.mjs       provider URL normalization, model discovery, API mode
│  ├─ runtimePaths.mjs         development/release runtime mapping
│  └─ settings.mjs             INI settings, migration, media paths
├─ src/
│  ├─ components/              navigation, editors, provenance, appearance dialogs
│  ├─ hooks/                   shared/settings/AI workflow state machines
│  ├─ lib/                     import, planning, AI client, persistence, map, weather
│  ├─ workers/                 large-file parsing
│  ├─ views/                   atlas, schedule, map, people, archive, options
│  ├─ App.tsx                  top-level domain state and cross-view orchestration
│  ├─ seed.ts                  neutral fictional defaults
│  ├─ types.ts                 domain and settings types
│  └─ styles.css               global theme and view styling
├─ docs/                       canonical documentation
├─ release/                    clean package shell, default media, fictional examples
├─ public/                     Vite static assets
├─ vite.config.ts
└─ package.json
```

`App.tsx` still owns top-level domain state and atlas orchestration. Shared state synchronization belongs to `useSharedSync.ts`, settings to `useSettingsSync.ts`, and long-running task/person orchestration to `useAiWorkflow.ts`. Do not reintroduce multi-minute callbacks that read stale render closures; use `dataRef.current` or functional state updates.

`IntelView.tsx` composes `ArchivePanel`, `AnalysisPanel`, `CandidateQueue`, and `ConversationBrowser`. Selection and time-window logic belong to `useIntelAnalysisSelection.ts`.

### 3.1 Archive storage boundary

`server/archiveStore.mjs` is the authority for local raw conversation persistence. Disk writes append gzip JSONL segments. The first segment is a snapshot; later segments contain `upsert` and `delete` operations. Replaying segments in order reconstructs the current index.

The first line of a segment is metadata:

```json
{"schema":"theia-intel-archive/v1","schemaVersion":1,"kind":"delta","updatedAt":"2026-08-04T00:00:00.001Z","sourceFingerprint":"sha256:..."}
```

Following lines are one of:

```json
{"op":"upsert","item":{"id":"..."}}
{"op":"delete","id":"..."}
```

`POST /api/sync/intel/delta` accepts `upserts`, `deleteIds`, `sourceFingerprint`, and optional `expectedUpdatedAt`. A mismatched watermark returns 409. The client uses a delta only after establishing a matching baseline and when the change set is bounded; otherwise it falls back to the full snapshot compatibility endpoint.

Browser IndexedDB is a cache, not the archive authority. IndexedDB v2 stores individual messages in `intelRecords` and watermarks in `intelMeta`. The legacy `snapshots` store remains readable during migration.

## 4. Runtime Topology

### 4.1 Browser development

`npm run dev` starts:

```text
Node local API     127.0.0.1:8787
Vite web server    127.0.0.1:5173, or the next free port
```

Vite proxies `/api/*` to the loopback service. The orchestrator shuts down the sibling process when either side exits and force-terminates after a bounded grace period.

### 4.2 Electron

`npm run desktop` runs `electron/main.mjs`. Before showing the UI, the main process configures rendering, assigns isolated `userData` and `sessionData`, obtains a single-instance lock, records a PID marker, starts or reuses a compatible loopback service, starts Vite programmatically for development, and creates a sandboxed 1600x900 window with a 1280x720 minimum.

Node integration is disabled. Context isolation and Chromium sandboxing are enabled. Application menus and Alt/F10 menu activation are disabled. Exit cleanup closes Vite and the API service and removes only the current process marker.

### 4.3 GPU policy

Default Chromium flags enable GPU rasterization, zero copy, and Canvas out-of-process rasterization. `THEIA_SOFTWARE_RENDERING=1` disables hardware acceleration and enables the compatibility flags. Do not disable GPU globally to work around one driver. Atlas drag writes are batched through `requestAnimationFrame`; Leaflet uses canvas preference.

## 5. Domain Model

Core interfaces live in `src/types.ts`.

### 5.1 `IntelItem`

A raw imported record. Important fields include stable `id`, `platform`, `conversationId`, `conversationTitle`, `conversationType`, `senderDisplayName`, normalized `speakerRole`, `formattedTime`, parsed `timestamp`, `type`, `content`, source file metadata, and optional avatar URL.

### 5.2 `AiTaskCandidate`

A model-proposed task awaiting review. It retains title, summary, source time, optional explicit start/due time, place, participants, evidence IDs, expiration decision, and model rationale. Confidence scoring is not a user-facing requirement and must not substitute for provenance.

### 5.3 `Quest`

A user-approved task. It stores lifecycle status, explicit target time separately from source time, linked places/people, guidance, evidence, atlas category, and atlas order. Editing must preserve guidance and atlas fields.

### 5.4 `Person`

A contextual person card linked to one or more private conversations. Facts, preferences, portrait paragraphs, evidence IDs, avatar references, relationship signals, update watermark, and revision metadata must remain distinct. Deleting a card removes its current content and obsolete model-reference IDs without blocking later evidence from creating a new card.

### 5.5 `Place`

A user- or model-created point or approximate area with coordinates, radius/precision, provenance, notes, and editable marker state.

## 6. State Ownership and Persistence

Lightweight application state includes quests, people, places, schedules, candidates, UI preferences, and atlas layout. The large raw archive is separate. Provider secrets are separate again.

Development layout uses repository-root `.theia-*` compatibility paths. Packaged layout uses:

```text
runtime/
  data/state.json
  data/chat-archive/
  data/chat-archive.meta.json
  data/settings.ini
  data/credentials.json
  data/migrations/
  data/electron/
  logs/ai-debug.jsonl
  logs/tasks/*.jsonl.gz
  assets/img/backgrounds/
  assets/img/avatars/
```

Snapshot writes use an `updatedAt` watermark. Conflicts return 409 and the client merges by ID before retrying up to a bounded count. Comparing record counts is not a conflict-resolution strategy; a smaller snapshot can contain newer records.

Do not put raw messages back into lightweight shared state. Do not rewrite the complete archive for a small directory change. Preserve old migration sources until the new schema is confirmed readable.

## 7. Import Pipeline

Directory discovery is recursive and accepts supported JSON, CSV, and TXT. One folder is treated as one conversation when the exporter provides that structure. Stable IDs combine source identity and record identity so rescans update or delete authoritative records instead of accumulating duplicates.

Files larger than 1 MiB use `workers/intelParser.worker.ts`; smaller files call the same parser directly. Worker and direct paths must produce identical IDs, times, speaker roles, conversation keys, and avatar fields.

JSON import traverses known arrays and exporter-specific containers. CSV uses structured parsing. TXT supports timestamped conversation lines. Avoid ad hoc comma splitting or timestamp guessing.

Time must come from the record. A value such as `07-29 01:48:30` has no reliable year and must not silently inherit the file modification year. Speaker direction must come from an explicit field or a validated exporter contract; display-name guessing is forbidden.

## 8. Conversation Planning and Oversized Context

Analysis is planned per conversation, not per individual message. Different conversations may run concurrently. Segments of the same conversation remain chronological and serial so upstream concurrency cannot reorder the timeline.

Two selection modes exist:

- **Last-contact time** selects conversations whose latest record falls in the interval, then submits the selected conversations according to the configured workflow.
- **Strict time** removes records outside the interval before segmentation.

Task extraction uses a smaller bounded core to avoid oversized schemas and upstream 502 responses. Person evidence may use wider windows. Segments preserve continuous coverage and bounded overlap; they are not random samples. Prompt headers and output schemas are counted as fixed request overhead.

Old information may remain useful for identity or relationship context while becoming irrelevant as an actionable task. Expiration is based on source time, explicit target time, task class, and current time. Explicit future target times override generic recency heuristics. The UI displays source time when no reliable target time exists and must not invent estimates such as "10 minutes."

## 9. Model Task Pipeline

### 9.1 Client orchestration

`src/lib/aiClient.ts` builds compact records, invokes loopback endpoints, normalizes structured results, and validates references. `useAiWorkflow.ts` owns run state, total progress, task/person phase progress, pause checkpoints, stop behavior, failure retry, and resume prompts.

Long-running callbacks read current state through refs or functional updates. Candidate IDs and quest IDs must be checked against current state at commit time to prevent duplicate creation.

### 9.2 Service validation

The service validates provider selection, model, API mode, prompt templates, record shapes, output schema, evidence ranges, and response size before forwarding. Provider keys never enter debug logs. Full work-unit logs are sensitive because prompts and responses may contain complete conversation text.

### 9.3 Prompt hierarchy

System safety and evidence rules are stable prefixes. User-editable task, person-evidence, person-merge, and guidance prompts are separate settings. Dynamic feedback, time ranges, and records are appended after stable instructions to improve provider-side prompt caching.

Task prompts must explicitly require speaker-direction fidelity, target/source time separation, actionable relevance, expiration handling, concise summaries instead of raw quotation, and no fabricated time or place.

### 9.4 Structured output and fallback

Responses API and Chat Completions use strict JSON schema where supported. A 502, timeout, or network failure does not automatically duplicate a large request through another API mode. Mode fallback occurs only when endpoint or structured-output incompatibility is explicitly detected.

Candidate validation rejects missing evidence, mismatched conversations, impossible speaker references, unparseable target times, and unsupported fields. User-visible confidence scores are not used as a substitute for validation.

### 9.5 Provider pool

Each provider channel has an independent URL, key reference, model, API mode, enabled flag, and concurrency limit. Global concurrency is bounded separately. Scheduler capacity is the minimum of global analysis concurrency, healthy channel capacity, and effective shared-origin capacity.

Channels pointing to the same origin are not guaranteed independent upstream capacity. 429, 502, 503, 504, 524, network failure, and timeout use a short local retry delay capped at two seconds in the established stable baseline. Failed work remains recoverable in the session; results use acknowledgement semantics so a transient polling-response loss does not discard completed provider work.

## 10. Person Pipeline

Private conversations can create or update person evidence. Group chats do not automatically become one card per participant without reliable identity boundaries.

Evidence extraction must retain claim IDs, source IDs, exact speaker direction, quotations, category, persistence, and portrait eligibility. Transient plans, one-off states, and filler are separated from durable traits, habits, preferences, skills, boundaries, and background.

Merge output should use structured portrait paragraphs with referenced claim IDs. Deterministic validation verifies that IDs exist, quotations belong to the correct speaker, and portrait paragraphs cite eligible claims. Evidence-limit commentary belongs in separate coverage metadata, not in the portrait prose. Validation failure may trigger one bounded rewrite; repeated failure must remain retryable rather than being marked as a successful empty portrait.

Person fingerprints advance only after a successful durable update. Incremental updates send new records plus at most 16 preceding records for each addition. Unchanged conversations are not resubmitted.

When a card lacks an avatar, the service searches the linked source conversation's session metadata for `avatar`, downloads only allowed remote media through the controlled cache path, and persists a local reference. Avatar failure must not block person evidence.

## 11. Task Guidance Refresh

Guidance context combines the quest, linked person facts/preferences/portrait, place, and optional weather. Weather is fetched from Open-Meteo only when an explicit target date is between today and 16 days ahead and coordinates exist.

When linked person evidence changes materially, related guidance may be offered for refresh. Refreshes must be incremental, visible, and user-reviewable; they must not silently rewrite task meaning or target time.

## 12. Maps and External Services

Supported tile choices include OSM DE, OSM Standard, and HOT. All views preserve attribution and policy links. Tile cache limits are configurable from 32 to 1024 MB and eviction is capacity-based.

Geocoding supports automatic selection between Nominatim and Photon or an explicit source. Search responses normalize display name, coordinates, bounds, precision, and approximate radius. Public endpoints can throttle or fail; the UI must distinguish an empty result from network failure.

Remote avatars, quotations, geocoding, tiles, and weather are optional online dependencies. Server-side proxying must validate protocols, content types, size limits, timeouts, and cache paths.

## 13. Local HTTP Surface

The loopback service listens on `127.0.0.1:8787`. Major endpoint groups include:

| Group | Purpose |
| --- | --- |
| `/api/sync/snapshot` | lightweight application state read/write |
| `/api/sync/intel` | full raw-archive compatibility snapshot |
| `/api/sync/intel/delta` | bounded append-only archive changes |
| `/api/settings` | INI-backed profile, appearance, prompts, and provider metadata |
| `/api/ai/providers*` | provider CRUD, model discovery, and runtime status |
| `/api/ai/analyze` | task and optional person-evidence analysis |
| `/api/ai/people*` | person evidence, merge, and incremental update |
| `/api/ai/sessions*` | enqueue, polling, acknowledgement, pause/recovery support |
| `/api/map/*` | tile proxy/cache and geocoding |
| `/api/media/*` | controlled avatar/background retrieval |
| `/api/storage/overview` | runtime paths, schema, archive, migration, and recovery health |

This is a local API, not an authenticated multi-user server. Do not bind it to non-loopback interfaces without designing authentication, authorization, CSRF, origin policy, rate limiting, and secret isolation first.

## 14. Logs and Observability

`logs/ai-debug.jsonl` contains pipeline summaries without conversation bodies and rotates around 8 MB with up to three history files. Work-unit logs under `logs/tasks/*.jsonl.gz` include timestamps, work type, sanitized conversation label, digest, model request, provider attempts, and response. They may contain complete records and are highly sensitive.

Debug in this order:

1. confirm the application and loopback service are running;
2. inspect storage and provider runtime status;
3. check whether `providerAttemptCount` is zero;
4. distinguish local validation, queueing, upstream HTTP failure, output parse failure, and candidate validation;
5. open only the relevant work-unit log;
6. redact message bodies, avatar data URLs, keys, and absolute paths before sharing.

Never print raw merge responses unconditionally to production console. All full-content diagnostics must pass through the sensitive work-log boundary.

## 15. Settings and Provider Configuration

`settings.ini` is shared between browser and desktop modes. It stores profile display settings, appearance, prompt templates, provider metadata, concurrency, map sources, cache limits, and credential references.

Packaged Electron attempts to migrate plaintext provider keys into `safeStorage` and writes ciphertext to `credentials.json`. The INI retains a `credentialRef`. A user can always choose and save a detected model; saving applies to the next request, not a stale in-flight request.

Provider editing must remain available even when runtime-status refresh is slow or fails. Status visualization is diagnostic and must not block configuration forms.

## 16. Performance Strategy

- Keep large raw records outside React top-level state and lightweight snapshots.
- Parse large imports in a Worker and virtualize long candidate/conversation/person lists.
- Append archive deltas and compact only at a segment threshold.
- Keep task and person request budgets independent.
- Run different conversations concurrently, but preserve order inside one conversation.
- Batch drag writes with `requestAnimationFrame`; do not call React state setters on every pointer event.
- Lazy-load heavy views such as maps and options.
- Bound tile, avatar, log, and migration storage.
- Avoid full-array cloning in polling and progress updates.
- Surface task and person phase progress independently so long person consolidation does not look frozen.

## 17. Development and Verification

Install and run:

```powershell
npm install
npm run dev
npm run desktop
```

Core verification:

```powershell
npm run lint
npm run build
npm test
npm run test:e2e
npm run test:desktop-smoke
npm run dist:unpacked
npm run test:unpacked-smoke
node --check server/index.mjs
node --check electron/main.mjs
git diff --check
```

Integration tests use disposable `THEIA_RUNTIME_ROOT` directories and fake loopback providers. They must not read the developer's real conversations, INI, or API keys. Playwright snapshot updates require human visual review; updating a baseline is not itself a passing test.

Additional desired coverage includes person claim validation and same-name conversation isolation, provider URL/mode compatibility, and geocoder bounds/precision/radius normalization.

## 18. Release Procedure

### 18.1 Local readiness checklist

1. Confirm package version and release notes.
2. Run tests, lint, build, syntax checks, desktop smoke, and unpacked smoke.
3. Start browser and desktop modes with fictional data.
4. Verify provider setup, one-conversation analysis, stop/retry, person phase, task generation, map, and restart persistence.
5. Search for real names, keys, provider hosts, absolute user paths, and conversation fragments.
6. Confirm the package shell contains only neutral assets and fictional examples.
7. Build into a new local staging directory.

### 18.2 Source and portable packages

```powershell
node release-tools/package-release.mjs ..\staging\v0.4.1\THEIA-release-0.4.1
npm run dist:exe -- ..\staging\v0.4.1\THEIA-0.4.1-portable
```

The source packager refuses an existing destination and excludes conversations, tasks, people, places, candidates, keys, provider settings, browser/Electron profiles, logs, downloaded avatars, custom backgrounds, dependencies, builds, caches, and Git metadata. It includes source, lockfiles, canonical documentation, neutral assets, fictional examples, and a manifest.

### 18.3 Installer, signing, and updates

```powershell
npm run dist:installer
```

electron-builder writes an assisted Windows x64 NSIS installer to `release-bin/installer/`, packages application code in ASAR, and generates `latest.yml` plus blockmap metadata. An unpacked build is for smoke testing and is not interchangeable with updater metadata.

Signing secrets are injected only in a clean release environment:

```text
CSC_LINK=<base64 value, HTTPS URL, or certificate path>
CSC_KEY_PASSWORD=<certificate password>
GH_TOKEN=<used only when publishing a GitHub Release>
```

The repository must never store signing certificates, passwords, or access tokens. Automatic binary update does not replace data-schema rollback. Back up runtime data before upgrading; binary rollback and migrated-data rollback are separate operations.

## 19. Changing Data Structures

1. Update `src/types.ts`.
2. Update neutral defaults in `seed.ts`.
3. Define normalization, migration, or removal in storage code.
4. Decide whether the field belongs in lightweight shared state; raw archive data does not.
5. Update server settings or runtime paths where required.
6. Version model work logs and protocol schemas or preserve compatibility.
7. Update path and privacy documentation.
8. Verify restart, browser/desktop sharing, migration backup, and rollback with old samples.
9. Update both Chinese and English purpose/developer documentation when semantics or boundaries change.

Avoid `JSON.parse(JSON.stringify(...))` for domain cloning. It silently loses dates and `undefined` and duplicates large arrays. Do not read stale React state inside multi-minute model callbacks.

## 20. Known Risks and Priorities

Version `0.4.1` includes the `0.4.0` storage and reliability foundation plus overlap-safe task/person deduplication, human-centered people search and sorting, contact summaries, source-aware conversation previews, and guarded interpersonal guidance.

Remaining priorities include:

- continue extracting person merge, task guidance, and domain reducers from `App.tsx` into unit-tested modules;
- expose map cache hit/eviction metrics and an explicit cache-clear control;
- add macOS/Linux packaging validation and signed Windows CI with human publication approval;
- add per-attachment execution state, retry, and actual provider usage reconciliation;
- benchmark million-record import time, memory peak, archive compaction, and recovery;
- evolve the data model from current-task snapshots toward revision-aware longitudinal observations, inferences, reflections, and life-stage transitions.

THEIA remains a single-user local application. It does not promise unbounded scale, every export format, public-service availability, or identical behavior from every OpenAI-compatible relay. New protocol work must preserve the established stable provider baseline while moving the system toward its longitudinal self-research purpose.
