import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for MNEMO import')
}

test('THEIA merges a MNEMO batch into its unified append-only archive', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'theia-mnemo-server-'))
  const inbox = join(root, 'inbox')
  const batchDirectory = join(inbox, 'MNEMO-v1-20260807T010000000Z')
  await mkdir(batchDirectory, { recursive: true })
  const path = join(batchDirectory, 'records.json')
  const avatarId = 'a'.repeat(64)
  const avatarDirectory = join(root, 'assets', 'img', 'avatars')
  await mkdir(avatarDirectory, { recursive: true })
  await writeFile(join(avatarDirectory, `mnemo-${avatarId}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
  await writeFile(join(avatarDirectory, `mnemo-${avatarId}.json`), JSON.stringify({ mimeType: 'image/png', file: `mnemo-${avatarId}.png`, producer: 'MNEMO' }), 'utf8')
  await writeFile(path, JSON.stringify({
    schema: 'mnemo-delta/v1',
    generatedAt: '2026-08-07T02:00:00.000Z',
    producer: { name: 'MNEMO', version: '0.1.0', layout: 'immutable-delta-v1' },
    account: { id: 'wxid_owner' },
    records: [{
      id: 'mnemo:wxid_owner:message_0:messages:1', title: 'Hello', summary: 'Friend: Hello', content: 'Hello',
      conversationId: 'mnemo:wxid_owner:friend', conversationName: 'Friend', conversationKind: 'direct',
      avatarId,
      speaker: 'Friend', messageType: 'text', speakerRole: 'other', capturedAt: '2026-08-07T01:00:00.000Z', status: 'new',
    }],
  }), 'utf8')
  const old = new Date(Date.now() - 3_000)
  await utimes(path, old, old)

  process.env.THEIA_RUNTIME_ROOT = root
  process.env.THEIA_RELEASE_LAYOUT = '1'
  process.env.THEIA_MNEMO_INBOX = inbox
  process.env.THEIA_MNEMO_DISABLED = '1'
  process.env.THEIA_MNEMO_INBOX_SETTLE_MS = '1000'
  process.env.AI_PORT = '0'

  const { server, startAiProxy } = await import('../server/index.mjs')
  await startAiProxy()
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const meta = await waitFor(async () => {
    const response = await fetch(`${base}/api/sync/intel/meta`)
    const payload = await response.json()
    return payload.recordCount === 1 ? payload : null
  })
  assert.equal(meta.recordCount, 1)
  const archive = await fetch(`${base}/api/sync/intel`).then((response) => response.json())
  assert.equal(archive.items[0].source, '微信导出')
  assert.equal(archive.items[0].content, 'Hello')
  assert.equal(archive.items[0].avatarUrl, `/api/media/avatar/local?id=${avatarId}`)
  const avatar = await fetch(`${base}/api/media/avatar/local?id=${avatarId}`)
  assert.equal(avatar.status, 200)
  assert.equal(avatar.headers.get('content-type'), 'image/png')
  const invalidAvatar = await fetch(`${base}/api/media/avatar/local?id=..%2Fsecret`)
  assert.equal(invalidAvatar.status, 400)
  const status = await fetch(`${base}/api/mnemo/status`).then((response) => response.json())
  assert.equal(status.agent.enabled, false)
  assert.equal(status.directoryCount >= 1, true)
})
