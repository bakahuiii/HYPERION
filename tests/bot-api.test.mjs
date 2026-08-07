import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Bot API keeps archive writes incremental and state mutations serialized', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'theia-bot-api-'))
  const inheritedSeleneInbox = process.env.THEIA_SELENE_INBOX
  delete process.env.THEIA_SELENE_INBOX
  process.env.THEIA_RUNTIME_ROOT = root
  process.env.THEIA_RELEASE_LAYOUT = '1'
  process.env.AI_PORT = '0'

  const { versionSharedState } = await import('../server/schemaMigrations.mjs')
  await mkdir(join(root, 'data'), { recursive: true })
  const initial = versionSharedState({
    updatedAt: '2026-08-06T00:00:00.000Z',
    data: {
      profile: { name: '测试用户' },
      quests: [{ id: 'q-1', title: '确认日期', description: '测试任务', status: 'active', locationId: '', characterIds: [], tags: [] }],
      people: [{ id: 'p-1', name: '测试人物', facts: ['不应暴露的原始事实'], preferences: [], sourceIds: [], platforms: [], model: 'test', createdAt: '2026-08-06T00:00:00.000Z', portrait: '可读人物摘要。' }],
      dailyCheckins: [],
      contextEvents: [{ id: 'c-1', version: 1, kind: 'location', source: 'selene', startAt: '2026-08-06T08:00:00.000Z', title: 'Location capture', capturedAt: '2026-08-06T08:00:00.000Z', importedAt: '2026-08-06T08:01:00.000Z', privacy: 'precise', sourceFile: 'SELENE-android/context-events.json', location: { latitude: 30, longitude: 120 } }],
      archive: { version: 1, messageCount: 0, conversationCount: 0, identifiedConversationCount: 0, messagesWithoutConversation: 0 },
    },
  })
  await writeFile(join(root, 'data', 'state.json'), JSON.stringify(initial), 'utf8')

  const { server, startAiProxy } = await import('../server/index.mjs')
  await startAiProxy()
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    if (inheritedSeleneInbox === undefined) delete process.env.THEIA_SELENE_INBOX
    else process.env.THEIA_SELENE_INBOX = inheritedSeleneInbox
    await rm(root, { recursive: true, force: true })
  })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const json = async (path, options) => {
    const response = await fetch(`${base}${path}`, options)
    return { response, body: await response.json() }
  }

  const overview = await json('/api/bot/summary')
  assert.equal(overview.response.status, 200)
  assert.equal(overview.body.activeQuestCount, 1)
  assert.equal(overview.body.peopleCount, 1)

  const journal = await json('/api/bot/journal', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '一条来自 Bot 的日记。' }),
  })
  assert.equal(journal.response.status, 201)
  assert.match(journal.body.id, /^bot-journal-/)
  assert.equal(journal.body.record.conversationId, 'self-journal')
  assert.equal(journal.body.record.speakerRole, 'self')
  assert.equal(journal.body.record.content, '一条来自 Bot 的日记。')
  assert.equal(typeof journal.body.archiveUpdatedAt, 'string')
  assert.equal((await json('/api/bot/summary')).body.archiveRecordCount, 1)

  const checkIn = await json('/api/bot/check-in', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-08-06', mood: 3, sleepHours: 7.25, medication: 'reduced', alcohol: 'low' }),
  })
  assert.equal(checkIn.response.status, 200)
  assert.equal(checkIn.body.item.sleepHours, 7.5)
  const snapshot = await json('/api/sync/snapshot')
  assert.equal(snapshot.body.data.dailyCheckins[0].id, 'self-checkin-2026-08-06')
  assert.equal((await json('/api/bot/summary')).body.archiveRecordCount, 2)

  const completed = await json('/api/bot/quests/q-1/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(completed.response.status, 200)
  assert.equal(completed.body.status, 'done')
  const people = await json('/api/bot/people')
  assert.equal(people.response.status, 200)
  assert.equal(people.body.items[0].facts, undefined)
  const selene = await json('/api/bot/selene')
  assert.equal(selene.response.status, 200)
  assert.equal(selene.body.latestEvents[0].location, undefined)
})
