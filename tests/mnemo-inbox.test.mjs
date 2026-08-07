import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMnemoAgentController } from '../server/mnemoAgent.mjs'
import { createMnemoInboxWatcher, MNEMO_DELTA_SCHEMA, normalizeMnemoDocument } from '../server/mnemoInbox.mjs'

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for MNEMO agent state')
}

function document(records = [record()]) {
  return {
    schema: MNEMO_DELTA_SCHEMA,
    generatedAt: '2026-08-07T02:00:00.000Z',
    producer: { name: 'MNEMO', version: '0.1.0', layout: 'immutable-delta-v1' },
    account: { id: 'wxid_owner' },
    records,
  }
}

function record() {
  return {
    id: 'mnemo:wxid_owner:message_0:messages:1',
    title: 'Hello', summary: 'Friend: Hello', content: 'Hello',
    conversationId: 'mnemo:wxid_owner:friend', conversationName: 'Friend', conversationKind: 'direct',
    avatarId: 'a'.repeat(64),
    speaker: 'Friend', messageType: 'text', speakerRole: 'other', capturedAt: '2026-08-07T01:00:00.000Z', status: 'new',
  }
}

test('finds the sibling MNEMO agent from a source workspace', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-mnemo-agent-'))
  const workspace = join(root, 'HYPERION', 'source')
  const inheritedHome = process.env.HYPERION_MNEMO_HOME
  const inheritedLegacyHome = process.env.THEIA_MNEMO_HOME
  delete process.env.HYPERION_MNEMO_HOME
  delete process.env.THEIA_MNEMO_HOME
  context.after(async () => {
    if (inheritedHome === undefined) delete process.env.HYPERION_MNEMO_HOME
    else process.env.HYPERION_MNEMO_HOME = inheritedHome
    if (inheritedLegacyHome === undefined) delete process.env.THEIA_MNEMO_HOME
    else process.env.THEIA_MNEMO_HOME = inheritedLegacyHome
    await rm(root, { recursive: true, force: true })
  })

  const controller = createMnemoAgentController({ workspace })
  assert.equal(controller.status().script, join(root, 'MNEMO', 'python', 'mnemo_agent.py'))
})

test('pauses the incremental agent while a full MNEMO import runs', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-mnemo-force-'))
  const script = join(root, 'agent.py')
  await writeFile(script, [
    'import json, sys, time',
    "if sys.argv[1] == 'once':",
    "  print(json.dumps({'changed': True, 'accountId': 'wxid_owner', 'totalRecordCount': 2, 'lastSyncAt': '2026-08-07T01:00:00+00:00'}), flush=True)",
    'else:',
    "  print(json.dumps({'type': 'mnemo-status', 'state': 'ready', 'accountId': 'wxid_owner', 'totalRecordCount': 2, 'lastSyncAt': '2026-08-07T01:00:00+00:00'}), flush=True)",
    '  time.sleep(60)',
  ].join('\n'), 'utf8')
  const controller = createMnemoAgentController({ workspace: root, script, interval: 10 })
  context.after(async () => {
    await controller.stop().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  await controller.start()
  await waitFor(() => controller.status().runtimeState === 'ready' ? controller.status() : null)
  const fullImport = await controller.forceSync()
  assert.equal(fullImport.result.totalRecordCount, 2)
  const ready = await waitFor(() => controller.status().runtimeState === 'ready' ? controller.status() : null)
  assert.equal(ready.totalRecordCount, 2)
  assert.equal(ready.accountId, 'wxid_owner')
})

test('normalizes MNEMO batches to the HYPERION archive record shape', () => {
  const normalized = normalizeMnemoDocument(document(), { sourceFile: 'MNEMO-v1-1/records.json' })
  assert.equal(normalized?.accountId, 'wxid_owner')
  assert.equal(normalized?.records[0].source, '微信导出')
  assert.equal(normalized?.records[0].sourceFile, 'mnemo://wxid_owner')
  assert.equal(normalized?.records[0].avatarUrl, `/api/media/avatar/local?id=${'a'.repeat(64)}`)
  assert.equal(normalizeMnemoDocument(document([{ ...record(), content: '' }])), null)
})

test('accepts account-scoped MNEMO reconciliation deletions', () => {
  const id = 'mnemo:wxid_owner:message_0:Msg_old:1'
  const normalized = normalizeMnemoDocument({ ...document([]), deleteIds: [id, 'other:record'] })
  assert.deepEqual(normalized?.deleteIds, [id])
  assert.deepEqual(normalized?.records, [])
})

test('imports each immutable MNEMO batch once and retries only unfinished files', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-mnemo-inbox-'))
  const inbox = join(root, 'inbox')
  const statePath = join(root, 'state', 'mnemo.json')
  const batchDirectory = join(inbox, 'MNEMO-v1-20260807T010000000Z')
  await mkdir(batchDirectory, { recursive: true })
  const batchPath = join(batchDirectory, 'records.json')
  await writeFile(batchPath, JSON.stringify(document()), 'utf8')
  const old = new Date(Date.now() - 3_000)
  await utimes(batchPath, old, old)

  const imported = []
  const watcher = createMnemoInboxWatcher({
    directory: inbox,
    statePath,
    settleMs: 1_000,
    intervalMs: 5_000,
    onImport: async (records, metadata) => {
      imported.push({ records, metadata })
      return { importedRecords: records.length }
    },
  })
  context.after(() => { watcher.stop(); return rm(root, { recursive: true, force: true }) })

  const first = await watcher.start()
  assert.equal(first.processedFiles, 1)
  assert.equal(imported.length, 1)
  assert.equal(imported[0].records[0].conversationId, 'mnemo:wxid_owner:friend')
  assert.deepEqual(imported[0].metadata.deleteIds, [])
  await watcher.scan()
  assert.equal(imported.length, 1)
})

test('reports a stable malformed MNEMO batch as a data anomaly', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-mnemo-invalid-'))
  const inbox = join(root, 'inbox')
  const statePath = join(root, 'state', 'mnemo.json')
  const batchDirectory = join(inbox, 'MNEMO-v1-20260807T010000000Z')
  await mkdir(batchDirectory, { recursive: true })
  const batchPath = join(batchDirectory, 'records.json')
  await writeFile(batchPath, '{invalid', 'utf8')
  const old = new Date(Date.now() - 3_000)
  await utimes(batchPath, old, old)

  const watcher = createMnemoInboxWatcher({
    directory: inbox,
    statePath,
    settleMs: 1_000,
    onImport: async () => ({ importedRecords: 0 }),
  })
  context.after(() => { watcher.stop(); return rm(root, { recursive: true, force: true }) })

  const status = await watcher.start()
  assert.equal(status.pendingFiles, 1)
  assert.equal(status.lastError, 'MNEMO data batch is not valid JSON.')
})

test('can import a completed full-sync batch without waiting for the normal settle delay', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-mnemo-immediate-'))
  const inbox = join(root, 'inbox')
  const statePath = join(root, 'state', 'mnemo.json')
  const batchDirectory = join(inbox, 'MNEMO-v1-20260807T010000000Z')
  await mkdir(batchDirectory, { recursive: true })
  await writeFile(join(batchDirectory, 'records.json'), JSON.stringify(document()), 'utf8')
  const imported = []
  const watcher = createMnemoInboxWatcher({
    directory: inbox,
    statePath,
    settleMs: 60_000,
    onImport: async (records) => {
      imported.push(...records)
      return { importedRecords: records.length }
    },
  })
  context.after(() => { watcher.stop(); return rm(root, { recursive: true, force: true }) })

  await watcher.start()
  assert.equal(imported.length, 0)
  await watcher.scan({ ignoreSettle: true })
  assert.equal(imported.length, 1)
})

test('can start the private MNEMO watcher without scanning historical batches', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-mnemo-idle-'))
  const inbox = join(root, 'inbox')
  const statePath = join(root, 'state', 'mnemo.json')
  const batchDirectory = join(inbox, 'MNEMO-v1-20260807T010000000Z')
  await mkdir(batchDirectory, { recursive: true })
  await writeFile(join(batchDirectory, 'records.json'), JSON.stringify(document()), 'utf8')
  const imported = []
  const watcher = createMnemoInboxWatcher({
    directory: inbox,
    statePath,
    onImport: async (records) => {
      imported.push(...records)
      return { importedRecords: records.length }
    },
  })
  context.after(() => { watcher.stop(); return rm(root, { recursive: true, force: true }) })

  const status = await watcher.start({ initialScan: false, watch: false })
  assert.equal(status.processedFiles, 0)
  assert.equal(imported.length, 0)
  await watcher.scan({ ignoreSettle: true })
  assert.equal(imported.length, 1)
})
