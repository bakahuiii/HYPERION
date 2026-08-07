import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeCapturedAt, parseContextEventFile, parseIntelFile } from '../src/lib/importer.ts'

function jsonFile(name, value) {
  const raw = JSON.stringify(value)
  return { name, size: raw.length, lastModified: 1, async text() { return raw } }
}

test('normalizes epoch, Chinese dates, and rejects invalid timestamps', () => {
  assert.match(normalizeCapturedAt('2026年8月4日 12时03分09秒') ?? '', /^2026-08-04T12:03:09$/)
  assert.match(normalizeCapturedAt(1_754_300_000_000) ?? '', /^2025-/)
  assert.equal(normalizeCapturedAt('not-a-date'), undefined)
})

test('structured JSON keeps sender direction and session avatar context', async () => {
  const records = await parseIntelFile(jsonFile('messages.json', {
    session: { avatar: 'https://example.invalid/avatar.jpg' },
    messages: [
      { formattedTime: '2026-08-04 10:00:00', type: 'incoming', content: 'hello', senderDisplayName: 'A' },
      { formattedTime: '2026-08-04 10:01:00', type: 'outgoing', content: 'reply', senderDisplayName: '你' },
    ],
  }), { path: '私聊/A/messages.json' })

  assert.equal(records.length, 2)
  assert.deepEqual(records.map((item) => item.speakerRole), ['other', 'self'])
  assert.equal(records[0].conversationKind, 'direct')
  assert.equal(records[0].avatarUrl, 'https://example.invalid/avatar.jpg')
  assert.equal(records[1].avatarUrl, 'https://example.invalid/avatar.jpg')
  assert.equal(records[0].capturedAt, '2026-08-04T10:00:00')
})

test('nested sender metadata and avatar URL are inherited by message rows', async () => {
  const records = await parseIntelFile(jsonFile('chat.json', [{
    time: '2026/08/04 11:00',
    sender: { displayName: 'B', profile: { url: 'https://example.invalid/b.png' } },
    body: 'nested message',
  }]), { path: 'direct/B/chat.json' })
  assert.equal(records.length, 1)
  assert.equal(records[0].speaker, 'B')
  assert.equal(records[0].avatarUrl, 'https://example.invalid/b.png')
})

test('CSV parser preserves quoted commas and outgoing flags', async () => {
  const file = {
    name: 'export.csv',
    async text() { return 'time,sender,content,isSend\n2026-08-04 12:00,A,"coffee, tomorrow?",false\n2026-08-04 12:01,你,yes,true\n' },
  }
  const records = await parseIntelFile(file, { path: '私聊/A/export.csv' })
  assert.equal(records.length, 2)
  assert.equal(records[0].content, 'coffee, tomorrow?')
  assert.deepEqual(records.map((item) => item.speakerRole), ['other', 'self'])
})

test('strict directory import ignores metadata objects without message fields', async () => {
  const records = await parseIntelFile(jsonFile('profile.json', {
    session: { avatar: 'https://example.invalid/avatar.jpg', nickname: 'A' },
    profile: { name: 'A' },
  }), { path: '私聊/A/profile.json' })
  assert.deepEqual(records, [])
})

test('AI conversation folders keep user direction and receive the explicit AI source', async () => {
  const records = await parseIntelFile(jsonFile('conversation.json', {
    session: { displayName: 'ChatGPT', kind: 'direct' },
    messages: [
      { formattedTime: '2026-08-06T08:00:00.000Z', content: 'My question', isSelf: true },
      { formattedTime: '2026-08-06T08:01:00.000Z', content: 'Assistant answer', isSelf: false },
    ],
  }), { path: 'direct/AI/ChatGPT/2026-08-06/conversation.json' })

  assert.equal(records.length, 2)
  assert.equal(records[0].source, 'AI 对话导入')
  assert.deepEqual(records.map((item) => item.speakerRole), ['self', 'other'])
  assert.equal(records[0].conversationKind, 'direct')
  assert.equal(records[0].conversationId, 'folder:direct/AI/ChatGPT/2026-08-06')
})

test('SELENE documents are kept out of chat imports and retain their separate contract', async () => {
  const file = jsonFile('context-events.json', {
    schema: 'selene-context-events/v1',
    generatedAt: '2026-08-06T20:00:00.000Z',
    producer: { name: 'SELENE', version: '0.1.0', layout: 'immutable-snapshot-v1' },
    events: [{
      id: 'screen-day', version: 1, kind: 'screen-time', source: 'selene',
      startAt: '2026-08-06T00:00:00.000Z', endAt: '2026-08-06T20:00:00.000Z',
      title: 'Screen usage', values: { foregroundMinutes: 180 }, capturedAt: '2026-08-06T20:00:00.000Z',
      importedAt: '2026-08-06T20:00:00.000Z', privacy: 'coarse',
    }],
  })
  assert.deepEqual(await parseIntelFile(file, { path: 'SELENE-v1-20260806T200000000Z/context-events.json' }), [])
  const context = await parseContextEventFile(file, { path: 'SELENE-v1-20260806T200000000Z/context-events.json' })
  assert.equal(context.length, 1)
  assert.equal(context[0].kind, 'screen-time')
  assert.equal(context[0].sourceFile, 'SELENE-v1-20260806T200000000Z/context-events.json')
})
