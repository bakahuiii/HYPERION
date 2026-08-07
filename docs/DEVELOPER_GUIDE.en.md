# HYPERION Developer Guide

[简体中文](DEVELOPER_GUIDE.md) | [English](DEVELOPER_GUIDE.en.md)

This guide is for engineers who maintain, review, extend, or package HYPERION. It describes source version `0.6.0` and treats `package-lock.json`, `server/index.mjs`, and the current implementation as authoritative. Planned capabilities are not described as complete. For field-level local HTTP, upstream model JSON, session batching, MNEMO, and log formats, use [API_PROTOCOL.md](API_PROTOCOL.md) and [MNEMO.md](MNEMO.md) alongside this guide.

## 1. System and Engineering Boundary

HYPERION is currently a single-user, local-first personal task-atlas application. The user deliberately supplies exported files. The browser parses and selects locally. The loopback Node.js service persists state, proxies controlled media requests, and forwards selected content to user-configured model providers. Engineering must preserve time, provenance, speaker direction, and revision. Inference must not masquerade as fact. Person descriptions must not turn isolated temporary states into stable labels. Guidance must not become prediction, scoring, manipulation, or moral judgment.

The project does not implement:

- login bypass for WeChat, QQ, school platforms, or other services;
- credential extraction or cracking;
- decryption of unauthorized private databases;
- silent background scraping of chats or social feeds;
- treatment of model output as an unquestionable fact database;
- cloud accounts, multi-user collaboration, or remote synchronization.

MNEMO is the only narrow exception: when the current Windows user has a local WeChat desktop session running, the separate MNEMO process may make a read-only decrypted snapshot for that account. It does not require a GUI, folder grant, or manual key-capture operation. Key material never enters HYPERION state, archives, logs, or model requests. HYPERION owns only the agent lifecycle, outbox, readable exports, and avatar cache.

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

`IntelView.tsx` composes `AnalysisPanel`, `CandidateQueue`, and `ConversationBrowser`. It polls MNEMO diagnostics only to surface real data failures; healthy or waiting intake remains silent. Selection and time-window logic belong to `useIntelAnalysisSelection.ts`.

### 3.1 Archive storage boundary

`server/archiveStore.mjs` is the authority for local raw conversation persistence. Disk writes append gzip JSONL segments. The first segment is a snapshot; later segments contain `upsert` and `delete` operations. Replaying segments in order reconstructs the current index.

The first line of a segment is metadata:

```json
{"schema":"hyperion-intel-archive/v1","schemaVersion":1,"kind":"delta","updatedAt":"2026-08-04T00:00:00.001Z","sourceFingerprint":"sha256:..."}
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

Default Chromium flags enable GPU rasterization, zero copy, and Canvas out-of-process rasterization. `HYPERION_SOFTWARE_RENDERING=1` disables hardware acceleration and enables the compatibility flags. Do not disable GPU globally to work around one driver. Atlas drag writes are batched through `requestAnimationFrame`; Leaflet uses canvas preference.

## 5. Domain Model

Core interfaces live in `src/types.ts`.

### 5.1 `IntelItem`

A raw imported record. Important fields include stable `id`, `platform`, `conversationId`, `conversationTitle`, `conversationType`, normalized `speakerRole`, parsed `sentAt`/`capturedAt`, `content`, source file metadata, and an optional avatar URL. `senderDisplayName` and the exporter `type` are local audit fields, not model input requirements.

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

Development layout uses repository-root `.hyperion-*` compatibility paths. Packaged layout uses:

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

### 6.1 Large-Archive Baseline (In Development)

The append-only body remains `hyperion-intel-archive/v1`: an initial snapshot is followed by stable-ID upsert/delete deltas. Compaction writes a new snapshot first, records metadata, removes old segments only after that snapshot is durable, then writes final metadata. At every point there is a replayable current-state path.

`chat-archive.meta.json` now carries `metadataVersion: 2`, with SHA-256, compressed byte length, operation count, and health data for every live segment. Metadata is a rebuildable index cache, not the source of truth: missing metadata is rebuilt from segments as `recovered-unindexed`; a digest mismatch stops reads; a delta with no actual change writes no empty segment. A running service compares the segment-name inventory and reuses its loaded map when it has not changed, rather than decompressing all segments for every small sync.

`GET /api/sync/intel/conversations` supplies a paged conversation index and `GET /api/sync/intel/conversations/:id` supplies one paged conversation. `ConversationBrowser` now uses that surface: startup and directory browsing retain only a conversation ID, name, time range, count, and a preview capped at 420 characters. The preview prefers the final `speakerRole=other` message and falls back to the final message only when no counterpart message exists; opening a conversation reads its body in 250-record pages. Archives above 25,000 records are not copied into React state during startup. A user-started extraction loads the archive on demand while retaining the established complete-conversation, continuous-segment, and evidence-validation semantics. Legacy `GET /api/sync/intel` remains a compatibility read and must not be used for list rendering, shared state, or localStorage.

Use only synthetic data for scale checks:

```powershell
npm run bench:archive -- --records=100000 --batch-size=5000
npm run bench:archive -- --records=1000000 --batch-size=10000
```

Record write time, cold read plus digest verification, segment count, first-page size, heap, and RSS together with the Node/Electron version and storage medium. Never commit a benchmark fixture based on a personal archive.

### 6.2 Operational Scale Boundaries

These are implementation boundaries, not promises of unlimited scale:

| Surface | Current behavior | Practical boundary / action |
| --- | --- | --- |
| Startup | Archives above **25,000 records** are not copied into React state when the local archive index is available. | Below that threshold, legacy compatibility hydration may still occur. Above it, investigate any unexpected full-state load. |
| Conversation browsing | The list reads compact server-side summaries; opening a conversation loads **250 records** per page and virtualizes the loaded rows. | The list can remain responsive with many conversations, but an individual conversation is still read into the browser page as the user continues loading. |
| MNEMO intake | HYPERION reads only immutable `mnemo-delta/v1` batches from its owned inbox. | A stable malformed batch is rejected and reported; external directories and JSON/CSV/TXT intake are not scanned. |
| Archive storage | Disk writes are append-only gzip JSONL deltas, with SHA-256 metadata and compaction. | Reload currently reconstructs an in-memory `Map`; archive size is therefore still bounded by available Node/Electron memory. |
| Extraction | The user-started extraction bridge currently obtains the full selected archive before creating complete chronological plans. | This is not million-record-safe. Treat **100,000+ records** as a high-scale mode requiring a synthetic benchmark and memory check; **1,000,000 records** is an unverified target, not a supported claim. |
| Model requests | Task baseline is 48 core records / ~4,000 compact characters; people baseline is 320 / ~24,000, with bounded overlap. | A custom ensemble profile may be larger only after testing that specific provider. Too-large prompts can still produce relay timeouts or 502 responses. |

Before changing any boundary, run the synthetic archive benchmark, record cold-load and extraction memory, and test crash recovery. The next scalability milestone is server-side conversation-scoped extraction so a run never hydrates an unrelated raw archive in the renderer.

Reference only: the synthetic 100,000-record archive benchmark recorded on 2026-08-06 with Node `v24.13.0` on Windows x64 used 5,000-record batches, wrote in 646 ms, cold-read plus verified in 646 ms, used 174.7 MiB heap / 345.2 MiB RSS, and returned a 160-record first conversation page. This is a regression reference for one machine, not a supported-scale guarantee or a substitute for extraction-memory measurement.

## 7. MNEMO Intake Pipeline

`server/mnemoAgent.mjs` starts `python/mnemo_agent.py` as a child process and explicitly provides HYPERION-owned inbox, readable-export, and avatar-cache directories. On each source fingerprint change, the agent creates a read-only snapshot, maps `contact.db` `remark -> nick_name`, reads local image blobs from `head_image.db`, and writes immutable `MNEMO-v1-*/records.json` documents. It must not write the append-only archive or read/write HYPERION credentials.

`server/mnemoInbox.mjs` accepts only `mnemo-delta/v1`, waits for a stable complete file, remembers the batch SHA-256, normalizes bounded fields, and sends records to `writeSharedIntelDelta`. Stable message IDs must not include display names. Readable exports use remark, nickname, then a collision-only hash suffix. MNEMO avatars must be binary-signature checked, content-addressed in HYPERION storage, and represented in archive records only as `/api/media/avatar/local?id=<hash>`.

External JSON, CSV, TXT, and directory intake are intentionally disabled. MNEMO is the only chat source. A batch is accepted only after it is complete and stable, then its normalized fields preserve the source message time and explicit speaker direction.

Manual extraction defaults to `scope=all`, which selects every database record. Automatic extraction must use conversation watermarks: `autoTriggerMode` is `time`, `message-count`, or `either`; `intervalHours` is constrained to 1–720 and `incrementalMessageCount` to 1–10,000. A run starts only when unprocessed increments exist and its configured condition is satisfied. It sends only new records plus bounded preceding context; the first full-library baseline remains a user-confirmed manual run.

## 8. Conversation Planning and Oversized Context

Analysis is planned per conversation, not per individual message. Different conversations may run concurrently. Segments of the same conversation remain chronological and serial so upstream concurrency cannot reorder the timeline.

Two selection modes exist:

- **Last-contact time** selects conversations whose latest record falls in the interval, then submits the selected conversations according to the configured workflow.
- **Strict time** removes records outside the interval before segmentation.

Task extraction uses a smaller bounded core to avoid oversized schemas and upstream 502 responses. Person evidence may use wider windows. Segments preserve continuous coverage and bounded overlap; they are not random samples. Prompt headers and output schemas are counted as fixed request overhead.

Old information may remain useful for identity or relationship context while becoming irrelevant as an actionable task. Expiration is based on source time, explicit target time, task class, and current time. Explicit future target times override generic recency heuristics. The UI displays source time when no reliable target time exists and must not invent estimates such as "10 minutes."

## 9. Model Task Pipeline

### 9.1 Client orchestration

`src/lib/aiClient.ts` builds compact records, invokes loopback endpoints, normalizes structured results, and validates references. The local archive keeps the full `IntelItem`, but the model wire format contains only `[RecordRef, sentAt, content, speakerRole]`, plus the direct-conversation `counterpartName` and request-level `analysisAsOf`, `timeZone`, and `utcOffsetMinutes`. The clock fields describe offset-free local message timestamps once per request rather than once per row. `type` and `senderDisplayName` remain local audit fields and are removed before prompt construction. `useAiWorkflow.ts` owns run state, total progress, task/person phase progress, pause checkpoints, stop behavior, failure retry, and resume prompts.

Long-running callbacks read current state through refs or functional updates. Candidate IDs and quest IDs must be checked against current state at commit time to prevent duplicate creation.

### 9.2 Service validation

The service validates provider selection, model, API mode, prompt templates, record shapes, output schema, evidence ranges, and response size before forwarding. Provider keys never enter debug logs. Full work-unit logs are sensitive because prompts and responses may contain complete conversation text.

### 9.3 Multi-Model Adjudication Foundation (Planned, Not Enabled)

Multiple provider channels are throughput capacity, not an instruction to broadcast one conversation to every model. `aiSettings.multiModel` defaults to `mode: 'single'`; the current extraction route neither reads ensemble participants nor makes additional calls. Saving this configuration is therefore safe and does not change the established provider-pool routing, request envelope, retry policy, or quota use.

The stored contract uses explicit roles rather than generic "extractor" and "reviewer": `task-extractor`, `task-judge`, `people-claim-extractor`, and `people-judge`. Old `{ workflow, role: 'extractor' | 'reviewer' }` values are migrated deterministically. Every extractor declares a `segmentProfileId`; a profile fixes `maxCoreRecords`, `maxCoreChars`, overlap limits, and an optional output-token budget. Built-in `task-standard` (48/4,000/6/1,000) and `people-context` (320/24,000/16/3,000) profiles preserve the currently proven single-model envelopes. A custom profile must use a new ID, so it cannot silently make the baseline request heavier.

The planned people pipeline is LLM-as-judge, but its evidence rules are deterministic:

```text
one direct conversation
  -> each people-claim extractor receives complete chronological coverage
     using its own declared segment profile
  -> each claim cites only a core archive RecordRef
  -> source/speaker/quote validation happens per extractor result
  -> observations are grouped by exact cited RecordRef
  -> distinct model participants, not overlap windows, determine corroboration
  -> a people-judge receives observations + citation clusters only
  -> cited portrait blocks, accepted claims, needs-verification claims, rejected claims
```

Evidence states are categorical: `single-source`, `corroborated`, `needs-review`, and `rejected`. They are provenance labels, not probability or confidence scores. A one-model observation remains visible to the judge as `needs-verification`; it is not silently deleted merely because another model missed it. The judge may only cite provided claim IDs and source IDs, must prefer corroborated evidence, and must keep transient states separate from durable traits, habits, interests, boundaries, and relationship changes. Coverage limitations belong in metadata, never in portrait prose.

`src/lib/multiModel.ts` currently contains only normalization, profile-aware deterministic planning, exact-citation clustering, judge-input construction, and task-candidate grouping. Before real fan-out is enabled, implementation must add per-pass work logs, cancellation/retry state, provider usage accounting, output-schema validation, and a review UI for `needs-verification` claims. Do not add a hidden broadcast path.

### 9.4 Prompt hierarchy

System safety and evidence rules are stable prefixes. User-editable task, person-evidence, person-merge, and guidance prompts are separate settings. Dynamic feedback, time ranges, and records are appended after stable instructions to improve provider-side prompt caching.

Task prompts must explicitly require speaker-direction fidelity, target/source time separation, actionable relevance, expiration handling, concise summaries instead of raw quotation, and no fabricated time or place.

### 9.5 Structured output and fallback

Responses API and Chat Completions use strict JSON schema where supported. A 502, timeout, or network failure does not automatically duplicate a large request through another API mode. Mode fallback occurs only when endpoint or structured-output incompatibility is explicitly detected.

Candidate validation rejects missing evidence, mismatched conversations, impossible speaker references, unparseable target times, and unsupported fields. User-visible confidence scores are not used as a substitute for validation.

### 9.6 Provider pool

Each provider channel has an independent URL, key reference, model, API mode, enabled flag, and concurrency limit. Global concurrency is bounded separately. Scheduler capacity is the minimum of global analysis concurrency, healthy channel capacity, and effective shared-origin capacity.

Channels pointing to the same origin are not guaranteed independent upstream capacity. 429, 502, 503, 504, 524, network failure, and timeout use a short local retry delay capped at two seconds in the established stable baseline. Failed work remains recoverable in the session; results use acknowledgement semantics so a transient polling-response loss does not discard completed provider work.

### 9.7 End-to-end task flow

```text
exported files
  -> local recursive parse, role resolution, avatar discovery, and deduplication
  -> conversation grouping and chronological sorting
  -> contiguous core segments with bounded overlap
  -> compact-v2 request: [RecordRef, sentAt, content, speakerRole]
  -> structured candidate response
  -> restore local message IDs and validate owner/time/place/source
  -> deduplicate overlap results
  -> review queue
  -> user confirmation and persistent quest
```

The task workflow asks only whether the user still has an actionable next step. Core rows may introduce a candidate; overlap rows are context and cannot be the sole evidence for a new candidate. `analysisAsOf` is used only for age/recency decisions. Relative dates must be resolved from the cited row's `sentAt` under the request-level time zone, never from the import or model runtime clock. A candidate is never written directly as a quest.

## 10. Person Pipeline

Private conversations can create or update person evidence. Group chats do not automatically become one card per participant without reliable identity boundaries.

Evidence extraction must retain claim IDs, source IDs, exact speaker direction, quotations, category, persistence, and portrait eligibility. Transient plans, one-off states, and filler are separated from durable traits, habits, preferences, skills, boundaries, and background.

Merge output should use structured portrait paragraphs with referenced claim IDs. Deterministic validation verifies that IDs exist, quotations belong to the correct speaker, and portrait paragraphs cite eligible claims. Evidence-limit commentary belongs in separate coverage metadata, not in the portrait prose. Validation failure may trigger one bounded rewrite; repeated failure must remain retryable rather than being marked as a successful empty portrait.

Person fingerprints advance only after a successful durable update. Incremental updates send new records plus at most 16 preceding records for each addition. Unchanged conversations are not resubmitted.

When a card lacks an avatar, the service searches the linked source conversation's session metadata for `avatar`, downloads only allowed remote media through the controlled cache path, and persists a local reference. MNEMO local avatars are read by `server/mnemoAvatarStore.mjs`, which accepts only a 64-hex ID, a fixed `mnemo-<hash>` filename, regular non-symlink files up to 5 MiB, matching metadata, and JPEG/PNG/GIF/WebP/AVIF signatures. Avatar failure must not block person evidence.

Person extraction is a separate evidence pass from task extraction:

```text
direct conversation
  -> locally verified counterpartName
  -> wide chronological windows
  -> claim-level facts/preferences with exact quotes and RecordRefs
  -> deterministic source/speaker/quote validation
  -> cross-window deduplication and merge
  -> portrait/advice generation from verified claims only
  -> person card update
```

Each claim must cite a core row whose `speakerRole` is `other`; a self-authored row can provide interaction context but cannot prove a fact about the counterpart. A single message such as “蛋挞好吃” supports “once said that egg tart was good”, not “likes egg tarts”. Stable preferences require repeated or otherwise materially corroborated signals. The merge stage may write readable portrait prose, but it may not add a claim absent from the verified evidence. Evidence-coverage notes are metadata, not portrait sentences. An invalid or empty merge remains retryable and must not be marked permanently successful.

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
| `/api/mnemo/status` | sidecar and immutable inbox status without messages or secrets |
| `/api/media/avatar/local?id=` | signature-checked local MNEMO avatar |
| `/api/settings` | INI-backed profile, appearance, prompts, and provider metadata |
| `/api/ai/providers*` | provider CRUD, model discovery, and runtime status |
| `/api/ai/analyze` | task and optional person-evidence analysis |
| `/api/ai/people*` | person evidence, merge, and incremental update |
| `/api/ai/sessions*` | enqueue, polling, acknowledgement, pause/recovery support |
| `/api/map/*` | tile proxy/cache and geocoding |
| `/api/media/*` | controlled avatar/background retrieval |
| `/api/storage/overview` | runtime paths, schema, archive, migration, and recovery health |
| `/api/bot/*` | narrow QQ Bot summaries and incremental writes; never a raw archive or full snapshot surface |

This is a local API, not an authenticated multi-user server. Do not bind it to non-loopback interfaces without designing authentication, authorization, CSRF, origin policy, rate limiting, and secret isolation first.

The QQ Bot boundary, request JSON, atomic write behavior, first-owner binding,
and proactive-notification queue are documented in
[`QQ_BOT.en.md`](QQ_BOT.en.md). The Bot may use only `/api/bot/*`; it must not
read-and-rewrite `/api/sync/snapshot` or read archive files directly.

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

Provider variables inherited from a parent IDE, Codex, or terminal process are ignored by default. `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_MODE`, and `OPENAI_MAX_CONCURRENCY` are read only when `HYPERION_USE_ENV_PROVIDER=1` is explicitly set. A protected secondary channel must always hydrate from its own `credentialRef`; it must never inherit the process-wide key.

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

Integration tests use disposable `HYPERION_RUNTIME_ROOT` directories and fake loopback providers. They must not read the developer's real conversations, INI, or API keys. Playwright snapshot updates require human visual review; updating a baseline is not itself a passing test.

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
node release-tools/package-release.mjs ..\staging\v0.6.0\HYPERION-release-0.6.0
npm run dist:exe -- ..\staging\v0.6.0\HYPERION-0.6.0-portable
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

## 20. Self-Authored Longitudinal Inputs

HYPERION's archive is not limited to imported conversations. A user-authored entry is first-class local data, intended to make later longitudinal self-research possible without turning the product into passive surveillance.

There are three deliberately separate inputs:

| Input | Storage | Authoritative time | Purpose |
| --- | --- | --- | --- |
| Journal message | `IntelItem` in `self-journal` | save timestamp | low-friction free text |
| Daily check-in | `AppData.dailyCheckins` plus one mirrored `IntelItem` | selected local calendar day | queryable state anchor |
| AI conversation import | normal imported `IntelItem` rows | exporter timestamp | preserve user speech beside other conversations |

The journal contract is stable: `conversationId = "self-journal"`, `conversationKind = "direct"`, `speakerRole = "self"`, source `手动记录`, and status `reviewed`. A daily check-in has exactly one stable ID per day, `self-checkin-YYYY-MM-DD`. Updating the same day replaces the corresponding archive row rather than appending duplicate state snapshots. This dual representation is intentional: structured check-ins support future trend queries, while the mirrored archive row preserves chronological auditability and evidence provenance.

`src/lib/selfJournal.ts` owns normalization, archive-row creation, manual-record retention, and the future analysis contract:

```ts
buildSelfAnalysisInput(items, dailyCheckins) => {
  analysisTarget: 'self',
  records: /* all and only speakerRole === 'self', chronological */,
  dailyCheckins: /* normalized, one per local day */
}
```

This is not a shortcut into `analyzePeople`. The people pipeline intentionally validates counterpart (`other`) quotations, so applying it to the user would invert evidence direction and produce invalid claims. The implemented `analyzeSelf()` workflow accepts only `self` records, preserves timestamps and source IDs, distinguishes observation from inference, and never replaces raw messages with a life-stage interpretation.

### 20.1 Implemented Self-Analysis Pipeline

The user starts this flow explicitly from the Intel view by selecting `self`. Opening Journal, writing a journal entry, or saving a check-in does not send data to a model.

```text
verified self-authored messages + journal + daily check-ins + imported AI user messages
  -> one capturedAt-ordered timeline
  -> continuous windows: at most 56 core rows / about 6,000 characters, with up to 8 preceding overlap rows
  -> /api/ai/self/observe returns only exact-quote, RecordRef-linked observations
  -> client restores source IDs and validates direction, contiguous quote, core-range citation, timestamp, and non-clinical text
  -> overlap/retry observations are deduplicated with merged provenance
  -> chronological quarterly groups, at most 120 observations per merge request
  -> /api/ai/self/merge returns source-linked periods; only summaries and complete source IDs persist
```

An observation may cover a cited event, action, expressed emotion or thought, decision, relationship interaction, routine, stressor, coping attempt, change, or uncertainty. It is not a diagnosis, personality score, treatment recommendation, risk label, hidden-motive inference, or a conversion of one statement into a durable trait. A merge may include an explanatory professional context only when its observation IDs support it; the UI labels it explicitly as non-diagnostic. The 120-observation boundary is a per-request envelope, not a discard limit: dense periods are split chronologically and every verified observation is assigned to a group.

MNEMO is authoritative only for its own stable record IDs. Its reconciliation deltas must never overwrite `self-journal` rows or lightweight state such as `dailyCheckins`; raw chat records remain in the append-only archive store.

## 21. Known Risks and Priorities

Version `0.4.2` adds compact model payloads, conversation-level counterpart identity, temporal evidence boundaries, meaningful person events, structured continuous portraits, and more resilient multi-channel recovery. Portrait consolidation starts only after evidence extraction completes, preventing repeated segment-driven cancellation; portrait versioning, persistence, and server logging now advance together so older prose is safely regenerated.

Remaining priorities include:

- continue extracting person merge, task guidance, and domain reducers from `App.tsx` into unit-tested modules;
- expose map cache hit/eviction metrics and an explicit cache-clear control;
- add macOS/Linux packaging validation and signed Windows CI with human publication approval;
- add per-attachment execution state, retry, and actual provider usage reconciliation;
- benchmark million-record import time, memory peak, archive compaction, and recovery;
- establish repeatable synthetic million-record benchmarks with `bench:archive`, then move extraction selection and execution to conversation-scoped server reads so one user-started run does not hydrate a whole archive in the renderer;
- enable real multi-model fan-out only after budget, per-pass logs, evidence provenance, and human review UI are in place;
- evolve the data model from current-task snapshots toward revision-aware longitudinal observations, inferences, reflections, and life-stage transitions.

HYPERION remains a single-user local application. It does not promise unbounded scale, every export format, public-service availability, or identical behavior from every OpenAI-compatible relay. New protocol work must preserve the established stable provider baseline while moving the system toward its longitudinal self-research purpose.
