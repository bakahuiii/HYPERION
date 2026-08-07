import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finishRecoverySession, startRecoverySession } from '../server/crashRecovery.mjs'
import { pruneLogDirectory } from '../server/logRetention.mjs'

test('log retention removes oldest files while respecting count and byte limits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-logs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (let index = 0; index < 5; index += 1) {
    const path = join(root, `${index}.jsonl.gz`)
    await writeFile(path, Buffer.alloc(20, index))
    const time = new Date(Date.now() - (5 - index) * 1_000)
    await import('node:fs/promises').then(({ utimes }) => utimes(path, time, time))
  }
  const result = await pruneLogDirectory(root, { maxFiles: 3, maxBytes: 50 })
  assert.equal(result.retainedFiles, 2)
  assert.equal(result.removedFiles, 3)
  assert.deepEqual((await readdir(root)).sort(), ['3.jsonl.gz', '4.jsonl.gz'])
})
test('runtime marker reports an unclean prior session and clears on shutdown', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hyperion-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const marker = join(root, 'runtime', 'session.json')
  const log = join(root, 'logs', 'crash.jsonl')
  const first = await startRecoverySession(marker, log, { version: 'test' })
  assert.equal(first.uncleanShutdownDetected, false)
  const second = await startRecoverySession(marker, log, { version: 'test-2' })
  assert.equal(second.uncleanShutdownDetected, true)
  assert.match(await readFile(log, 'utf8'), /unclean_shutdown_detected/)
  await finishRecoverySession(marker)
  await assert.rejects(stat(marker), (error) => error?.code === 'ENOENT')
})
