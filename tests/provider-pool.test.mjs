/* global fetch */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

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

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(payload))
}

async function discardBody(request) {
  for await (const _chunk of request) { /* consume the request */ }
}

function createFakeProvider(name) {
  const state = { modelRequests: 0, analysisRequests: 0, failNext: 0 }
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path === '/v1/models') {
      state.modelRequests += 1
      sendJson(response, 200, { data: [{ id: 'test-model' }] })
      return
    }
    if (request.method === 'POST' && path === '/v1/responses') {
      state.analysisRequests += 1
      await discardBody(request)
      if (state.failNext > 0) {
        state.failNext -= 1
        sendJson(response, 502, { error: { message: `${name} simulated gateway failure` } })
        return
      }
      // Keep the first request active long enough for the scheduler to fill a
      // second channel instead of serially reusing the primary.
      await delay(100)
      sendJson(response, 200, {
        output_text: JSON.stringify({ guidance: [`served by ${name}`] }),
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      })
      return
    }
    sendJson(response, 404, { error: { message: 'not found' } })
  })
  return { name, state, server }
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
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'theia-provider-pool-'))
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

    const parallel = await Promise.all([
      requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload }),
      requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload }),
    ])
    assert.deepEqual(parallel.map(({ response }) => response.status), [200, 200])
    assert.deepEqual(
      new Set(parallel.map(({ payload }) => payload.metadata.provider.channelId)),
      new Set(['primary', 'secondary']),
    )
    assert.equal(primary.state.analysisRequests, 1)
    assert.equal(secondary.state.analysisRequests, 1)

    primary.state.failNext = 1
    const failed = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(failed.response.status, 502)
    assert.equal(failed.payload.metadata.provider.channelId, 'primary')

    const recovered = await requestJson(baseUrl, '/api/ai/task-guidance', { body: guidancePayload })
    assert.equal(recovered.response.status, 200)
    assert.equal(recovered.payload.metadata.provider.channelId, 'secondary')

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
    const taskLogs = (await Promise.all(taskFiles.map((file) => readFile(join(logDirectory, 'tasks', file), 'utf8')))).join('\n')
    assert.equal(debugLog.includes(primarySecret) || debugLog.includes(secondarySecret), false)
    assert.equal(taskLogs.includes(primarySecret) || taskLogs.includes(secondarySecret), false)
  } finally {
    await Promise.allSettled([close(proxy), close(primary.server), close(secondary.server)])
    await rm(runtimeRoot, { recursive: true, force: true })
  }
})
