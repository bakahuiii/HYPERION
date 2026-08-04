/* global fetch */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { withFileLock, writeFileAtomically } from '../server/atomicFile.mjs'
import { rotateFileCopies } from '../server/fileRotation.mjs'

// runtimePaths.mjs is intentionally cached by Node. Every dynamically imported
// proxy in this file must therefore point at the same disposable root; each
// test removes its contents before the next proxy recreates them.
const sharedRuntimeRoot = await mkdtemp(join(tmpdir(), 'theia-provider-suite-'))
process.env.THEIA_RUNTIME_ROOT = sharedRuntimeRoot
process.env.THEIA_RELEASE_LAYOUT = '1'

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      resolveListen(`http://127.0.0.1:${address.port}/v1`)
    })
  })
}

function close(server) {
  if (!server?.listening) return Promise.resolve()
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
}

function cleanupRuntimeRoot(path) {
  return rm(path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 25,
  })
}

test('file rotation creates the first backup and shifts existing copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'theia-rotation-'))
  const path = join(root, 'debug.log')
  try {
    await writeFile(path, 'current')
    await rotateFileCopies(path, 3)
    assert.equal(await readFile(`${path}.1`, 'utf8'), 'current')

    await writeFile(path, 'next')
    await rotateFileCopies(path, 3)
    assert.equal(await readFile(`${path}.1`, 'utf8'), 'next')
    assert.equal(await readFile(`${path}.2`, 'utf8'), 'current')
  } finally {
    await cleanupRuntimeRoot(root)
  }
})

test('atomic archive writes serialize concurrent writers and clean temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'theia-atomic-'))
  const path = join(root, 'archive.json.gz')
  const lockPath = `${path}.lock`
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => withFileLock(lockPath, async () => {
      await delay(5)
      await writeFileAtomically(path, Buffer.from(`snapshot-${index}`), { mode: 0o600 })
    })))
    const value = (await readFile(path, 'utf8')).trim()
    assert.match(value, /^snapshot-[0-7]$/)
    assert.deepEqual(await readdir(root), ['archive.json.gz'])
  } finally {
    await cleanupRuntimeRoot(root)
  }
})

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(payload))
}

async function discardBody(request) {
  for await (const _chunk of request) { /* consume the request */ }
}

function createFakeProvider(name) {
  const state = { modelRequests: 0, analysisRequests: 0, activeRequests: 0, peakActiveRequests: 0, failNext: 0 }
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path === '/v1/models') {
      state.modelRequests += 1
      sendJson(response, 200, { data: [{ id: 'test-model' }] })
      return
    }
    if (request.method === 'POST' && path === '/v1/responses') {
      state.analysisRequests += 1
      state.activeRequests += 1
      state.peakActiveRequests = Math.max(state.peakActiveRequests, state.activeRequests)
      await discardBody(request)
      try {
        if (state.failNext > 0) {
          state.failNext -= 1
          sendJson(response, 502, { error: { message: `${name} simulated gateway failure` } })
          return
        }
        // Keep requests active long enough for the scheduler to fill every
        // available slot, not merely select each provider once.
        await delay(100)
        sendJson(response, 200, {
          output_text: JSON.stringify({ guidance: [`served by ${name}`] }),
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        })
      } finally {
        state.activeRequests -= 1
      }
      return
    }
    sendJson(response, 404, { error: { message: 'not found' } })
  })
  return { name, state, server }
}

function createProtocolFallbackProvider() {
  const state = { responsesRequests: 0, chatRequests: 0, responsesCompatible: false }
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path === '/v1/models') {
      sendJson(response, 200, { data: [{ id: 'test-model' }] })
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 404, { error: { message: 'not found' } })
      return
    }
    await discardBody(request)
    if (path === '/v1/responses') {
      state.responsesRequests += 1
      if (state.responsesCompatible) {
        sendJson(response, 200, { output_text: JSON.stringify({ guidance: ['served by responses'] }) })
        return
      }
      sendJson(response, 500, { error: { message: 'json: cannot unmarshal object into Go struct field ***.tools of type []map[string]interface {}' } })
      return
    }
    if (path === '/v1/chat/completions') {
      state.chatRequests += 1
      sendJson(response, 200, { choices: [{ message: { content: JSON.stringify({ guidance: ['served by chat'] }) } }] })
      return
    }
    sendJson(response, 404, { error: { message: 'not found' } })
  })
  return { state, server }
}

function createSlowAbortableProvider() {
  const state = { activeRequests: 0, abortedRequests: 0 }
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path === '/v1/models') {
      sendJson(response, 200, { data: [{ id: 'test-model' }] })
      return
    }
    if (request.method !== 'POST' || path !== '/v1/responses') {
      sendJson(response, 404, { error: { message: 'not found' } })
      return
    }
    await discardBody(request)
    state.activeRequests += 1
    try {
      const completed = await new Promise((resolveCompletion) => {
        const timer = setTimeout(() => resolveCompletion(true), 5_000)
        response.once('close', () => {
          clearTimeout(timer)
          state.abortedRequests += 1
          resolveCompletion(false)
        })
      })
      if (completed && !response.destroyed) {
        sendJson(response, 200, { output_text: JSON.stringify({ candidates: [] }) })
      }
    } finally {
      state.activeRequests -= 1
    }
  })
  return { state, server }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const raw = await response.text()
  let payload = {}
  try { payload = JSON.parse(raw) } catch { payload = { raw } }
  return { response, payload }
}

async function waitForScheduler(baseUrl, predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  let latest
  do {
    latest = await requestJson(baseUrl, '/api/ai/status')
    if (predicate(latest.payload.scheduler)) return latest
    await delay(5)
  } while (Date.now() < deadline)
  return latest
}

const guidancePayload = {
  quest: { title: 'Verify provider pool', description: 'Local test request' },
  people: [],
}

const analysisPayload = {
  conversation: {
    id: 'direct-regression-test',
    name: 'Regression test contact',
    kind: 'direct',
    totalRecords: 2,
    recordCount: 2,
    segmentIndex: 1,
    segmentCount: 1,
    coreRecordIndexes: [1, 2],
  },
  records: [
    {
      id: 'record-1',
      formattedTime: '2026-07-31 10:00:00',
      type: 'incoming',
      content: '明天下午一起喝咖啡吗？',
      senderDisplayName: 'Regression test contact',
      speakerRole: 'other',
    },
    {
      id: 'record-2',
      formattedTime: '2026-07-31 10:01:00',
      type: 'outgoing',
      content: '可以，地点稍后确认。',
      senderDisplayName: 'You',
      speakerRole: 'self',
    },
  ],
  attachments: [],
  workflows: { people: false },
  settings: { mode: 'balanced', recencyPolicy: 'balanced' },
}

test('provider pool balances requests and isolates a failing channel', async () => {
  const runtimeRoot = sharedRuntimeRoot
  assert.equal(resolve(runtimeRoot).startsWith(resolve(tmpdir())), true)
  const primary = createFakeProvider('primary')
  const secondary = createFakeProvider('secondary')
  let proxy
  try {
    const [primaryUrl, secondaryUrl] = await Promise.all([listen(primary.server), listen(secondary.server)])
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    process.env.AI_PROVIDER_TIMEOUT_MS = '2000'
    const { startAiProxy } = await import(`../server/index.mjs?provider-pool-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`

    const primarySecret = 'pool-test-primary-secret'
    const secondarySecret = 'pool-test-secondary-secret'
    const primaryUpdate = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: {
        name: 'Primary test channel',
        url: primaryUrl,
        key: primarySecret,
        model: 'test-model',
        apiMode: 'responses',
        maxConcurrency: 1,
      },
    })
    assert.equal(primaryUpdate.response.status, 200)

    const secondaryCreate = await requestJson(baseUrl, '/api/ai/channels', {
      body: {
        id: 'secondary',
        name: 'Secondary test channel',
        url: secondaryUrl,
        key: secondarySecret,
        model: 'test-model',
        apiMode: 'responses',
        maxConcurrency: 1,
      },
    })
    assert.equal(secondaryCreate.response.status, 201)

    const initialStatus = await requestJson(baseUrl, '/api/ai/status')
    assert.equal(initialStatus.payload.configured, true)
    assert.equal(initialStatus.payload.configuredChannelCount, 2)
    assert.equal(initialStatus.payload.scheduler.totalMaxConcurrency, 2)

    const archiveItems = [
      { id: 'archive-record-1', title: 'first message', summary: 'first message', conversationId: 'direct-test', content: 'first message' },
      { id: 'archive-record-2', conversationId: 'direct-test', content: 'second message' },
    ]
    const savedArchive = await requestJson(baseUrl, '/api/sync/intel', { body: { items: archiveItems } })
    assert.equal(savedArchive.response.status, 200)
    assert.equal(savedArchive.payload.recordCount, 2)
    const archiveMeta = await requestJson(baseUrl, '/api/sync/intel/meta')
    assert.equal(archiveMeta.response.status, 200)
    assert.equal(archiveMeta.payload.recordCount, 2)
    const loadedArchive = await requestJson(baseUrl, '/api/sync/intel')
    assert.equal(loadedArchive.response.status, 200)
    assert.equal(loadedArchive.payload.recordCount, 2)
    assert.deepEqual(loadedArchive.payload.items, [
      { id: 'archive-record-1', conversationId: 'direct-test', content: 'first message' },
      { id: 'archive-record-2', conversationId: 'direct-test', content: 'second message' },
    ])

    // A legacy archive can exist without its sidecar metadata. The version
    // returned before the sidecar is removed must still be accepted for the
    // next optimistic write instead of becoming a permanent 409 conflict.
    await rm(join(runtimeRoot, 'data', 'chat-archive.meta.json'), { force: true })
    const legacyArchiveMeta = await requestJson(baseUrl, '/api/sync/intel/meta')
    assert.equal(legacyArchiveMeta.response.status, 200)
    const migratedSidecarWrite = await requestJson(baseUrl, '/api/sync/intel', {
      body: {
        expectedUpdatedAt: legacyArchiveMeta.payload.updatedAt,
        items: [...loadedArchive.payload.items, { id: 'archive-record-3', conversationId: 'direct-test', content: 'third message' }],
      },
    })
    assert.equal(migratedSidecarWrite.response.status, 200)
    assert.equal(migratedSidecarWrite.payload.recordCount, 3)

    const firstState = await requestJson(baseUrl, '/api/sync/snapshot', {
      body: { expectedUpdatedAt: null, data: { quests: [{ id: 'first' }] } },
    })
    assert.equal(firstState.response.status, 200)
    const staleState = await requestJson(baseUrl, '/api/sync/snapshot', {
      body: { expectedUpdatedAt: null, data: { quests: [{ id: 'stale' }] } },
    })
    assert.equal(staleState.response.status, 409)
    assert.equal(staleState.payload.currentUpdatedAt, firstState.payload.updatedAt)
    const currentState = await requestJson(baseUrl, '/api/sync/snapshot', {
      body: { expectedUpdatedAt: firstState.payload.updatedAt, data: { quests: [{ id: 'current' }] } },
    })
    assert.equal(currentState.response.status, 200)
    assert.equal(currentState.payload.updatedAt > firstState.payload.updatedAt, true)

    const parallel = await Promise.all([
      requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload }),
      requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload }),
    ])
    assert.deepEqual(parallel.map(({ response }) => response.status), [200, 200])
    assert.deepEqual(
      new Set(parallel.map(({ payload }) => payload.metadata.provider.channelId)),
      new Set(['primary', 'secondary']),
    )
    assert.equal(parallel.every(({ payload }) => Number(payload.metadata.provider.attempts?.[0]?.requestBytes) > 0), true)
    assert.equal(primary.state.analysisRequests, 1)
    assert.equal(secondary.state.analysisRequests, 1)

    primary.state.failNext = 1
    const failed = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(failed.response.status, 502)
    assert.equal(failed.payload.metadata.provider.channelId, 'primary')

    const failedStatus = await requestJson(baseUrl, '/api/ai/status')
    const failedPrimary = failedStatus.payload.channels.find((channel) => channel.id === 'primary')
    assert.equal(failedPrimary.runtime.status, 'cooling-down')
    assert.ok(failedPrimary.runtime.cooldownRemainingMs > 0)
    assert.ok(failedPrimary.runtime.cooldownRemainingMs <= 2_000)
    assert.equal(failedPrimary.runtime.effectiveMaxConcurrency, failedPrimary.runtime.configuredMaxConcurrency)
    assert.ok(failedStatus.payload.scheduler.coolingDownChannelCount >= 1)

    const recovered = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(recovered.response.status, 200)
    assert.equal(recovered.payload.metadata.provider.channelId === 'primary' || recovered.payload.metadata.provider.channelId === 'secondary', true)

    const disabledPrimary = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { enabled: false },
    })
    assert.equal(disabledPrimary.response.status, 200)
    assert.equal(disabledPrimary.payload.configured, true)
    assert.equal(disabledPrimary.payload.configuredChannelCount, 1)

    const requestsBeforeAnalysis = primary.state.analysisRequests + secondary.state.analysisRequests
    const analysis = await requestJson(baseUrl, '/api/ai/analyze', { body: analysisPayload })
    assert.equal(analysis.response.status, 200)
    assert.deepEqual(analysis.payload.candidates, [])
    assert.equal(analysis.payload.metadata.provider.attemptCount >= 1, true)
    assert.equal(primary.state.analysisRequests + secondary.state.analysisRequests, requestsBeforeAnalysis + 1)

    await delay(50)
    const logDirectory = join(runtimeRoot, 'logs')
    const debugLog = await readFile(join(logDirectory, 'ai-debug.jsonl'), 'utf8')
    const taskFiles = await readdir(join(logDirectory, 'tasks'))
    const taskLogs = (await Promise.all(taskFiles.map(async (file) => {
      const content = await readFile(join(logDirectory, 'tasks', file))
      return (file.endsWith('.gz') ? gunzipSync(content) : content).toString('utf8')
    }))).join('\n')
    assert.equal(debugLog.includes(primarySecret) || debugLog.includes(secondarySecret), false)
    assert.equal(taskLogs.includes(primarySecret) || taskLogs.includes(secondarySecret), false)

    await writeFile(join(runtimeRoot, 'data', 'chat-archive.json.gz'), Buffer.from('not-a-gzip-archive'))
    const corruptedArchive = await requestJson(baseUrl, '/api/sync/intel')
    assert.equal(corruptedArchive.response.status, 500)
    assert.match(corruptedArchive.payload.error, /归档已损坏/)
  } finally {
    await Promise.allSettled([close(proxy), close(primary.server), close(secondary.server)])
    await cleanupRuntimeRoot(runtimeRoot)
  }
})

test('provider pool fills each channel capacity before queueing extra work', async () => {
  const runtimeRoot = sharedRuntimeRoot
  assert.equal(resolve(runtimeRoot).startsWith(resolve(tmpdir())), true)
  const primary = createFakeProvider('capacity-primary')
  const secondary = createFakeProvider('capacity-secondary')
  let proxy
  try {
    const [primaryUrl, secondaryUrl] = await Promise.all([listen(primary.server), listen(secondary.server)])
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    process.env.AI_PROVIDER_TIMEOUT_MS = '2000'
    const { startAiProxy } = await import(`../server/index.mjs?provider-capacity-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`

    const primaryUpdate = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { name: 'Capacity primary', url: primaryUrl, key: 'capacity-primary-secret', model: 'test-model', apiMode: 'responses', maxConcurrency: 2 },
    })
    assert.equal(primaryUpdate.response.status, 200)
    const secondaryCreate = await requestJson(baseUrl, '/api/ai/channels', {
      body: { id: 'secondary', name: 'Capacity secondary', url: secondaryUrl, key: 'capacity-secondary-secret', model: 'test-model', apiMode: 'responses', maxConcurrency: 2 },
    })
    assert.equal(secondaryCreate.response.status, 201)

    const requests = Array.from({ length: 8 }, () => requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload }))
    const inFlight = await waitForScheduler(baseUrl, (scheduler) => scheduler?.activeRequests === 4 && scheduler?.queueDepth === 4)
    assert.equal(inFlight.payload.scheduler.totalMaxConcurrency, 4)
    assert.equal(inFlight.payload.scheduler.activeRequests, 4)
    assert.equal(inFlight.payload.scheduler.queueDepth, 4)
    assert.deepEqual(
      inFlight.payload.channels.map((channel) => channel.runtime.activeRequests).sort((left, right) => left - right),
      [2, 2],
    )

    const completed = await Promise.all(requests)
    assert.deepEqual(completed.map(({ response }) => response.status), Array(8).fill(200))
    assert.equal(primary.state.peakActiveRequests, 2)
    assert.equal(secondary.state.peakActiveRequests, 2)
    assert.equal(primary.state.analysisRequests, 4)
    assert.equal(secondary.state.analysisRequests, 4)

    // One browser-facing batch must still fan out to every local provider
    // slot. This avoids Chromium's per-origin long-request connection cap.
    const batched = requestJson(baseUrl, '/api/ai/batch', {
      body: {
        requests: Array.from({ length: 8 }, (_, index) => ({
          id: index + 1,
          workflow: 'tasks',
          payload: { ...analysisPayload, conversation: { ...analysisPayload.conversation, id: `batch-${index + 1}` } },
        })),
      },
    })
    const batchInFlight = await waitForScheduler(baseUrl, (scheduler) => scheduler?.activeRequests === 4 && scheduler?.queueDepth === 4)
    assert.equal(batchInFlight.payload.scheduler.activeRequests, 4)
    assert.equal(batchInFlight.payload.scheduler.queueDepth, 4)
    const batchResult = await batched
    assert.equal(batchResult.response.status, 200)
    assert.equal(batchResult.payload.results.length, 8)
    assert.deepEqual(batchResult.payload.results.map((result) => result.ok), Array(8).fill(true))

    const secondaryDisabled = await requestJson(baseUrl, '/api/ai/channels/secondary', { body: { enabled: false } })
    assert.equal(secondaryDisabled.response.status, 200)
    primary.state.failNext = 1
    const transientFailure = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(transientFailure.response.status, 502)
    const reducedStatus = await requestJson(baseUrl, '/api/ai/status')
    const reducedPrimary = reducedStatus.payload.channels.find((channel) => channel.id === 'primary')
    assert.equal(reducedPrimary.runtime.status, 'cooling-down')
    assert.ok(reducedPrimary.runtime.cooldownRemainingMs > 0)
    assert.ok(reducedPrimary.runtime.cooldownRemainingMs <= 2_000)
    assert.equal(reducedPrimary.runtime.configuredMaxConcurrency, 2)
    assert.equal(reducedPrimary.runtime.effectiveMaxConcurrency, 2)

    const successfulRecovery = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(successfulRecovery.response.status, 200)
    const recoveredStatus = await requestJson(baseUrl, '/api/ai/status')
    const recoveredPrimary = recoveredStatus.payload.channels.find((channel) => channel.id === 'primary')
    assert.equal(recoveredPrimary.runtime.status, 'ready')
    assert.equal(recoveredPrimary.runtime.effectiveMaxConcurrency, 2)
  } finally {
    await Promise.allSettled([close(proxy), close(primary.server), close(secondary.server)])
    await cleanupRuntimeRoot(runtimeRoot)
  }
})

test('same relay aliases share one upstream concurrency ceiling', async () => {
  const runtimeRoot = sharedRuntimeRoot
  const provider = createFakeProvider('shared-relay')
  let proxy
  try {
    const providerUrl = await listen(provider.server)
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    const { startAiProxy } = await import(`../server/index.mjs?shared-origin-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const primary = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { name: 'Shared primary', url: providerUrl, key: 'shared-primary', model: 'test-model', apiMode: 'responses', maxConcurrency: 4 },
    })
    assert.equal(primary.response.status, 200)
    const secondary = await requestJson(baseUrl, '/api/ai/channels', {
      body: { id: 'shared-secondary', name: 'Shared secondary', url: providerUrl, key: 'shared-secondary', model: 'test-model', apiMode: 'responses', maxConcurrency: 4 },
    })
    assert.equal(secondary.response.status, 201)

    const requests = Array.from({ length: 12 }, () => requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload }))
    const scheduled = await waitForScheduler(baseUrl, (scheduler) => scheduler?.sharedOrigins?.[0]?.activeRequests === 8 && scheduler?.queueDepth === 4, 1_000)
    assert.equal(scheduled.payload.scheduler.sharedOrigins[0].effectiveMaxConcurrency, 8)
    const results = await Promise.all(requests)
    assert.equal(results.every((result) => result.response.status === 200), true)
    assert.equal(provider.state.peakActiveRequests <= 8, true)
  } finally {
    await Promise.allSettled([close(proxy), close(provider.server)])
    await cleanupRuntimeRoot(runtimeRoot)
  }
})

test('upstream Retry-After is reported without cooling the local provider slot', async () => {
  const runtimeRoot = sharedRuntimeRoot
  const state = { requests: 0 }
  const provider = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path === '/v1/models') {
      sendJson(response, 200, { data: [{ id: 'test-model' }] })
      return
    }
    if (request.method !== 'POST' || path !== '/v1/responses') {
      sendJson(response, 404, { error: { message: 'not found' } })
      return
    }
    state.requests += 1
    await discardBody(request)
    if (state.requests === 1) {
      sendJson(response, 502, { error: { message: 'relay is busy' }, retry_after: 60 }, { 'retry-after': '60' })
      return
    }
    sendJson(response, 200, { output_text: JSON.stringify({ guidance: ['recovered'] }) })
  })
  let proxy
  try {
    const providerUrl = await listen(provider)
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    const { startAiProxy } = await import(`../server/index.mjs?retry-after-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const configured = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { name: 'Retry-After provider', url: providerUrl, key: 'retry-after-secret', model: 'test-model', apiMode: 'responses', maxConcurrency: 1 },
    })
    assert.equal(configured.response.status, 200)
    const failed = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(failed.response.status, 502)
    assert.equal(failed.payload.retry_after, 2)
    const status = await requestJson(baseUrl, '/api/ai/status')
    const channel = status.payload.channels.find((item) => item.id === 'primary')
    assert.equal(channel.runtime.status, 'cooling-down')
    assert.ok(channel.runtime.cooldownRemainingMs > 0)
    assert.ok(channel.runtime.cooldownRemainingMs <= 2_000)
    assert.ok(status.payload.scheduler.sharedOrigins[0].cooldownRemainingMs > 0)
    assert.ok(status.payload.scheduler.sharedOrigins[0].cooldownRemainingMs <= 2_000)
    assert.equal(state.requests, 1)
  } finally {
    await Promise.allSettled([close(proxy), close(provider)])
    await cleanupRuntimeRoot(runtimeRoot)
  }
})

test('server-resident AI session keeps provider capacity supplied after individual jobs complete', async () => {
  const runtimeRoot = sharedRuntimeRoot
  assert.equal(resolve(runtimeRoot).startsWith(resolve(tmpdir())), true)
  const primary = createFakeProvider('session-primary')
  const secondary = createFakeProvider('session-secondary')
  let proxy
  try {
    const [primaryUrl, secondaryUrl] = await Promise.all([listen(primary.server), listen(secondary.server)])
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    process.env.AI_PROVIDER_TIMEOUT_MS = '2000'
    const { startAiProxy } = await import(`../server/index.mjs?provider-session-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`

    const primaryUpdate = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { name: 'Session primary', url: primaryUrl, key: 'session-primary-secret', model: 'test-model', apiMode: 'responses', maxConcurrency: 2 },
    })
    assert.equal(primaryUpdate.response.status, 200)
    const secondaryCreate = await requestJson(baseUrl, '/api/ai/channels', {
      body: { id: 'secondary', name: 'Session secondary', url: secondaryUrl, key: 'session-secondary-secret', model: 'test-model', apiMode: 'responses', maxConcurrency: 2 },
    })
    if (secondaryCreate.response.status === 409) {
      const secondaryUpdate = await requestJson(baseUrl, '/api/ai/channels/secondary', {
        body: { name: 'Session secondary', url: secondaryUrl, key: 'session-secondary-secret', model: 'test-model', apiMode: 'responses', enabled: true, maxConcurrency: 2 },
      })
      assert.equal(secondaryUpdate.response.status, 200)
    } else {
      assert.equal(secondaryCreate.response.status, 201)
    }

    const created = await requestJson(baseUrl, '/api/ai/sessions', { body: {} })
    assert.equal(created.response.status, 201)
    assert.equal(typeof created.payload.id, 'string')
    const sessionId = created.payload.id
    const enqueued = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}/enqueue`, {
      body: {
        requests: Array.from({ length: 8 }, (_, index) => ({
          id: index + 1,
          workflow: 'tasks',
          payload: { ...analysisPayload, conversation: { ...analysisPayload.conversation, id: `session-${index + 1}` } },
        })),
      },
    })
    assert.equal(enqueued.response.status, 202)
    assert.equal(enqueued.payload.acceptedIds.length, 8)

    const supplied = await waitForScheduler(baseUrl, (scheduler) => scheduler?.activeRequests === 4 && scheduler?.queueDepth === 4)
    assert.equal(supplied.payload.scheduler.totalMaxConcurrency, 4)
    assert.equal(supplied.payload.scheduler.activeRequests, 4)
    assert.equal(supplied.payload.scheduler.queueDepth, 4)

    const results = new Map()
    let acknowledgements = []
    let replayVerified = false
    for (let attempt = 0; attempt < 30 && results.size < 8; attempt += 1) {
      const query = acknowledgements.length ? `&ack=${acknowledgements.join(',')}` : ''
      const page = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}/results?protocol=ack-v1${query}`)
      assert.equal(page.response.status, 200)
      acknowledgements = page.payload.results.map((result) => result.id)
      if (acknowledgements.length && !replayVerified) {
        const replay = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}/results?protocol=ack-v1`)
        // More jobs may finish between reads. The unacknowledged page must
        // remain the prefix; newly completed results may follow it.
        assert.deepEqual(replay.payload.results.slice(0, acknowledgements.length).map((result) => result.id), acknowledgements)
        replayVerified = true
      }
      page.payload.results.forEach((result) => results.set(result.id, result))
      if (results.size < 8) await delay(30)
    }
    const finalAck = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}/results?protocol=ack-v1&ack=${acknowledgements.join(',')}`)
    assert.equal(finalAck.payload.results.length, 0)
    const orderedResults = [...results.values()].sort((left, right) => left.id - right.id)
    assert.equal(orderedResults.length, 8)
    assert.deepEqual(orderedResults.map((result) => result.ok), Array(8).fill(true))
    assert.deepEqual(orderedResults.map((result) => result.id), Array.from({ length: 8 }, (_, index) => index + 1))
    assert.equal(primary.state.peakActiveRequests, 2)
    assert.equal(secondary.state.peakActiveRequests, 2)

    const legacyEnqueued = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}/enqueue`, {
      body: {
        requests: [{
          id: 9,
          workflow: 'tasks',
          payload: { ...analysisPayload, conversation: { ...analysisPayload.conversation, id: 'session-legacy-9' } },
        }],
      },
    })
    assert.equal(legacyEnqueued.response.status, 202)
    let legacyPage
    for (let attempt = 0; attempt < 30; attempt += 1) {
      legacyPage = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}/results`)
      if (legacyPage.payload.results.length) break
      await delay(30)
    }
    assert.deepEqual(legacyPage.payload.results.map((result) => result.id), [9])
    const legacyReplay = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}/results`)
    assert.deepEqual(legacyReplay.payload.results, [])
  } finally {
    await Promise.allSettled([close(proxy), close(primary.server), close(secondary.server)])
    await cleanupRuntimeRoot(runtimeRoot)
  }
})

test('deleting an AI session aborts active upstream requests and removes queued provider work', async () => {
  const runtimeRoot = sharedRuntimeRoot
  const provider = createSlowAbortableProvider()
  let proxy
  try {
    const providerUrl = await listen(provider.server)
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    process.env.AI_PROVIDER_TIMEOUT_MS = '10000'
    const { startAiProxy } = await import(`../server/index.mjs?session-cancel-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const configured = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { name: 'Cancellation test', url: providerUrl, key: 'cancel-test-secret', model: 'test-model', apiMode: 'responses', maxConcurrency: 1 },
    })
    assert.equal(configured.response.status, 200)
    const current = await requestJson(baseUrl, '/api/ai/status')
    for (const channel of current.payload.channels ?? []) {
      if (channel.id !== 'primary') {
        await requestJson(baseUrl, `/api/ai/channels/${encodeURIComponent(channel.id)}`, { body: { enabled: false } })
      }
    }

    const created = await requestJson(baseUrl, '/api/ai/sessions', { body: {} })
    assert.equal(created.response.status, 201)
    const sessionId = created.payload.id
    const requests = Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      workflow: 'tasks',
      payload: { ...analysisPayload, conversation: { ...analysisPayload.conversation, id: `cancel-${index + 1}` } },
    }))
    const enqueued = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}/enqueue`, { body: { requests } })
    assert.equal(enqueued.response.status, 202)

    for (let attempt = 0; attempt < 30 && provider.state.activeRequests === 0; attempt += 1) await delay(10)
    assert.equal(provider.state.activeRequests, 1)
    const cancelled = await requestJson(baseUrl, `/api/ai/sessions/${sessionId}`, { method: 'DELETE' })
    assert.equal(cancelled.response.status, 200)
    for (let attempt = 0; attempt < 50 && provider.state.activeRequests > 0; attempt += 1) await delay(10)
    assert.equal(provider.state.activeRequests, 0)
    assert.equal(provider.state.abortedRequests >= 1, true)

    const status = await requestJson(baseUrl, '/api/ai/status')
    assert.equal(status.payload.scheduler.activeRequests, 0)
    assert.equal(status.payload.scheduler.queueDepth, 0)
  } finally {
    await Promise.allSettled([close(proxy), close(provider.server)])
    await cleanupRuntimeRoot(runtimeRoot)
  }
})

test('auto mode learns a Responses protocol incompatibility and reuses Chat Completions', async () => {
  const runtimeRoot = sharedRuntimeRoot
  const provider = createProtocolFallbackProvider()
  let proxy
  try {
    const providerUrl = await listen(provider.server)
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    process.env.AI_PROVIDER_TIMEOUT_MS = '2000'
    const { startAiProxy } = await import(`../server/index.mjs?provider-protocol-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const configured = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { name: 'Protocol fallback', url: providerUrl, key: 'protocol-test-secret', model: 'test-model', apiMode: 'auto', maxConcurrency: 1 },
    })
    assert.equal(configured.response.status, 200)
    // The provider-config module is shared by the dynamically imported test
    // servers. Disable channels left by the preceding pool test so this case
    // exercises only the protocol-fallback provider.
    const current = await requestJson(baseUrl, '/api/ai/status')
    for (const channel of current.payload.channels ?? []) {
      if (channel.id !== 'primary') {
        const disabled = await requestJson(baseUrl, `/api/ai/channels/${encodeURIComponent(channel.id)}`, { body: { enabled: false } })
        assert.equal(disabled.response.status, 200)
      }
    }

    const first = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(first.response.status, 200)
    assert.equal(first.payload.apiModeUsed, 'chat-completions')
    assert.equal(first.payload.metadata.provider.fallbackCount, 1)

    const second = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(second.response.status, 200)
    assert.equal(second.payload.apiModeUsed, 'chat-completions')
    assert.equal(provider.state.responsesRequests, 1)
    assert.equal(provider.state.chatRequests, 2)

    provider.state.responsesCompatible = true
    const refreshedConnection = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { url: providerUrl, apiMode: 'auto' },
    })
    assert.equal(refreshedConnection.response.status, 200)
    const third = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(third.response.status, 200)
    assert.equal(third.payload.apiModeUsed, 'responses')
    assert.equal(provider.state.responsesRequests, 2)
    assert.equal(provider.state.chatRequests, 2)
  } finally {
    await Promise.allSettled([close(proxy), close(provider.server)])
    await cleanupRuntimeRoot(runtimeRoot)
  }
})

test('people consolidation preserves structured evidence claims for renderer verification', async () => {
  const runtimeRoot = sharedRuntimeRoot
  const provider = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path === '/v1/models') {
      sendJson(response, 200, { data: [{ id: 'test-model' }] })
      return
    }
    await discardBody(request)
    if (request.method === 'POST' && path === '/v1/responses') {
      sendJson(response, 200, {
        output_text: JSON.stringify({
          facts: [{ text: '曾表示蛋挞好吃', quote: '蛋挞好吃', sourceIds: ['record-1'] }],
          preferences: [{ text: '对蛋挞有过单次正向评价', quote: '蛋挞好吃', sourceIds: ['record-1'] }],
          advice: [],
          portrait: '记录中有过对蛋挞的单次正向评价；仍需要更多信息确认稳定偏好。',
          portraitSourceIds: ['record-1', 'record-2'],
          profileNotesUsed: false,
          factClaimIds: ['claim-fact'],
          preferenceClaimIds: ['claim-preference'],
          portraitBlocks: [{ text: '对蛋挞有过单次正向评价', claimIds: ['claim-fact', 'claim-preference'], reason: 'preference' }],
          coverageNote: null,
          // Exercise the new strict merge contract without legacy fields.
          ...{ facts: undefined, preferences: undefined, portrait: undefined, portraitSourceIds: undefined },
        }),
      })
      return
    }
    sendJson(response, 404, { error: { message: 'not found' } })
  })
  let proxy
  try {
    const providerUrl = await listen(provider)
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    const { startAiProxy } = await import(`../server/index.mjs?people-merge-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const configured = await requestJson(baseUrl, '/api/ai/channels/primary', {
      body: { name: 'People merge test', url: providerUrl, key: 'people-merge-secret', model: 'test-model', apiMode: 'responses', maxConcurrency: 1 },
    })
    assert.equal(configured.response.status, 200)
    const result = await requestJson(baseUrl, '/api/ai/people/merge', {
      body: {
        person: {
          name: 'Test contact',
          evidence: [{
            id: 'claim-fact',
            kind: 'fact',
            text: '曾表示蛋挞好吃',
            quote: '蛋挞好吃',
            sourceIds: ['record-1'],
            evidenceStrength: 'single',
          }, {
            id: 'claim-preference',
            kind: 'preference',
            text: '对蛋挞有过单次正向评价',
            quote: '蛋挞好吃',
            sourceIds: ['record-1'],
            evidenceStrength: 'single',
          }],
          facts: ['曾表示蛋挞好吃'],
          preferences: ['对蛋挞有过单次正向评价'],
          advice: [],
          portrait: null,
        },
      },
    })
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.payload.preferences, [{ text: '对蛋挞有过单次正向评价', quote: '蛋挞好吃', sourceIds: ['record-1'] }])
    assert.deepEqual(result.payload.facts, [{ text: '曾表示蛋挞好吃', quote: '蛋挞好吃', sourceIds: ['record-1'] }])
    assert.deepEqual(result.payload.portraitSourceIds, ['record-1'])
    assert.equal(result.payload.portraitBlocks.length, 1)
    assert.equal(result.payload.profileNotesUsed, false)
  } finally {
    await Promise.allSettled([close(proxy), close(provider)])
    await cleanupRuntimeRoot(runtimeRoot)
  }
})

test('concurrent app and provider settings writes preserve both updates', async () => {
  const runtimeRoot = sharedRuntimeRoot
  let proxy
  try {
    process.env.THEIA_RUNTIME_ROOT = runtimeRoot
    process.env.THEIA_RELEASE_LAYOUT = '1'
    process.env.AI_PORT = '0'
    const { startAiProxy } = await import(`../server/index.mjs?settings-concurrency-test=${Date.now()}`)
    proxy = await startAiProxy()
    const address = proxy.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const initial = await requestJson(baseUrl, '/api/settings')
    assert.equal(initial.response.status, 200)

    for (let index = 0; index < 20; index += 1) {
      const name = `Concurrent profile ${index}`
      const model = `concurrent-model-${index}`
      const models = [model, `alternate-model-${index}`]
      const [appWrite, providerWrite] = await Promise.all([
        requestJson(baseUrl, '/api/settings', {
          body: {
            profile: { ...initial.payload.profile, name },
            appearance: initial.payload.appearance,
            aiSettings: { ...initial.payload.aiSettings, instructions: `concurrent instruction ${index}` },
          },
        }),
        requestJson(baseUrl, '/api/ai/channels/primary', { body: { name: 'Concurrent provider', model, models } }),
      ])
      assert.equal(appWrite.response.status, 200)
      assert.equal(providerWrite.response.status, 200)
      const [settings, status] = await Promise.all([
        requestJson(baseUrl, '/api/settings'),
        requestJson(baseUrl, '/api/ai/status'),
      ])
      assert.equal(settings.payload.profile.name, name)
      assert.equal(settings.payload.aiSettings.instructions, `concurrent instruction ${index}`)
      assert.equal(status.payload.channels.find((channel) => channel.id === 'primary')?.model, model)
      assert.deepEqual(status.payload.channels.find((channel) => channel.id === 'primary')?.models, models)
    }

    const emptied = await requestJson(baseUrl, '/api/sync/intel', {
      body: { items: [], sourceFingerprint: 'empty-directory-snapshot' },
    })
    assert.equal(emptied.response.status, 200)
    assert.equal(emptied.payload.recordCount, 0)
    const emptiedAgain = await requestJson(baseUrl, '/api/sync/intel', {
      body: { items: [], sourceFingerprint: 'empty-directory-snapshot-2' },
    })
    assert.equal(emptiedAgain.response.status, 200)
    assert.equal(emptiedAgain.payload.updatedAt > emptied.payload.updatedAt, true)
    const [emptyMeta, emptyArchive] = await Promise.all([
      requestJson(baseUrl, '/api/sync/intel/meta'),
      requestJson(baseUrl, '/api/sync/intel'),
    ])
    assert.equal(emptyMeta.payload.sourceFingerprint, 'empty-directory-snapshot-2')
    assert.equal(emptyMeta.payload.recordCount, 0)
    assert.equal(emptyArchive.payload.recordCount, 0)
    assert.deepEqual(emptyArchive.payload.items, [])
  } finally {
    await close(proxy)
    await cleanupRuntimeRoot(runtimeRoot)
  }
})
