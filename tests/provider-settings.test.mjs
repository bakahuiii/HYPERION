import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeProviderRecords } from '../server/settings.mjs'

test('protected secondary channels never inherit the ambient API key', () => {
  const previous = process.env.OPENAI_API_KEY
  const previousOptIn = process.env.THEIA_USE_ENV_PROVIDER
  process.env.OPENAI_API_KEY = 'ambient-key-must-not-enter-a-saved-channel'
  process.env.THEIA_USE_ENV_PROVIDER = '1'
  try {
    const records = normalizeProviderRecords([
      {
        id: 'primary',
        name: 'Primary',
        credentialRef: 'theia/provider/primary',
        baseURL: 'https://relay.example/v1',
      },
      {
        id: 'secondary',
        name: 'Secondary',
        credentialRef: 'theia/provider/secondary',
        baseURL: 'https://relay.example/v1',
      },
    ], {
      id: 'primary',
      name: 'Primary',
      apiKey: '',
      baseURL: 'https://relay.example/v1',
      model: 'test-model',
      apiMode: 'auto',
      models: [],
      maxConcurrency: 4,
    })

    assert.equal(records[0].apiKey, '')
    assert.equal(records[1].apiKey, '')
    assert.equal(records[1].credentialRef, 'theia/provider/secondary')
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
    if (previousOptIn === undefined) delete process.env.THEIA_USE_ENV_PROVIDER
    else process.env.THEIA_USE_ENV_PROVIDER = previousOptIn
  }
})
