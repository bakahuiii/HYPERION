import assert from 'node:assert/strict'
import test from 'node:test'

import { candidateRejectionReason } from '../src/lib/candidateValidation.ts'

const settings = { recencyPolicy: 'balanced' }
const item = (content, capturedAt, speakerRole = 'other') => ({
  id: `source-${Math.random()}`,
  source: 'wechat',
  content,
  summary: content,
  capturedAt,
  speakerRole,
})

test('rejects expired transient delivery tasks using source time', () => {
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
  const candidate = { title: '从快递柜取快件', description: '取件码 9937', sourceCapturedAt: old }
  assert.equal(candidateRejectionReason(candidate, [item('请取快递', old)], settings), 'expired')
})

test('rejects a candidate that reverses an invitation owner', () => {
  const recent = new Date(Date.now() - 60_000).toISOString()
  const candidate = { title: '开学后请 A 喝酒', description: '开学后一起喝酒', sourceCapturedAt: recent }
  const evidence = [item('我请你喝酒，开学后再说', recent, 'other')]
  assert.equal(candidateRejectionReason(candidate, evidence, settings), 'ownership')
})

test('keeps ambiguous and valid candidates for manual review', () => {
  const recent = new Date(Date.now() - 60_000).toISOString()
  const candidate = { title: '确认咖啡安排', description: '确认时间和地点', sourceCapturedAt: recent }
  assert.equal(candidateRejectionReason(candidate, [item('哪天喝咖啡？', recent)], settings), undefined)
})
