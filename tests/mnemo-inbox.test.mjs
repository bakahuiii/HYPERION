import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMnemoInboxWatcher, MNEMO_DELTA_SCHEMA, normalizeMnemoDocument } from '../server/mnemoInbox.mjs'

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

test('normalizes MNEMO batches to the THEIA archive record shape', () => {
  const normalized = normalizeMnemoDocument(document(), { sourceFile: 'MNEMO-v1-1/records.json' })
  assert.equal(normalized?.accountId, 'wxid_owner')
  assert.equal(normalized?.records[0].source, '微信导出')
  assert.equal(normalized?.records[0].sourceFile, 'mnemo://wxid_owner/MNEMO-v1-1/records.json')
  assert.equal(normalized?.records[0].avatarUrl, `/api/media/avatar/local?id=${'a'.repeat(64)}`)
  assert.equal(normalizeMnemoDocument(document([{ ...record(), content: '' }])), null)
})

test('imports each immutable MNEMO batch once and retries only unfinished files', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'theia-mnemo-inbox-'))
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
  await watcher.scan()
  assert.equal(imported.length, 1)
})
