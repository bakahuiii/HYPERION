import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeCapturedAt, parseIntelFile } from '../src/lib/importer.ts'

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
