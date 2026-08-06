# SELENE Event Import

THEIA accepts device-timeline data only from the standalone **SELENE** Android
or Windows application. The import is intentionally separate from chat archives and
journals: SELENE records describe a time-bound device or calendar observation,
not words written by the user. They can provide chronological background for
self-analysis, but never establish an emotion, diagnosis, motive, medication
decision, or causal relationship by themselves.

## Accepted Snapshot

Choose SELENE's parent export folder when connecting a directory. Every
collection writes one immutable child directory:

```text
SELENE-v1-20260806T185439123Z/
  context-events.json
```

THEIA scans these directories recursively. It accepts only UTF-8 JSON with the
following envelope; old companion formats are deliberately rejected.

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

The explicit producer marker prevents an ordinary JSON file or an obsolete
companion export from being mistaken for SELENE data. Snapshots are never
rewritten. If collection windows overlap, THEIA deduplicates records by their
stable `id` while retaining the snapshot path as provenance.

## Event Contract

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
  location?: { latitude: number; longitude: number; accuracyMeters?: number }
  locationConsent?: {
    exactLocation: true
    captureMode: 'manual' | 'foreground' | 'background'
    grantedAt: string
  }
}
```

Malformed timestamps and events whose `source` is not exactly `selene` are
discarded. Exact coordinates remain local to THEIA. Model requests receive a
coarse projection only: coordinate-, address-, and geohash-like values are
removed; location events may expose only `values.placeTag`.

## Analysis Boundary

- Chat rows and journal entries remain the only quoteable evidence.
- SELENE events orient time and activity only. Co-occurrence is never proof of
  causation.
- Missing data means limited coverage, not a claim about a period of life.
- The current SELENE collector may export calendar events, aggregate screen
  use, foreground application sessions, device/battery/screen state, network
  transport, anonymous Wi-Fi fingerprints, optional background location, and
  confirmed movement summaries. A movement summary records only duration,
  distance, approximate speed, and sample count; exact coordinates remain
  separate precise location events and never reach the model.
  It does not collect notification contents, SMS, calls, keystrokes,
  screenshots, other-application databases, or payment history.

For collection behavior, permission requirements, and snapshot-writing rules,
see the SELENE project documentation for the Android and Windows collectors.
