import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import express from 'express'
import http from 'node:http'

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-gw-settings-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_SECRET_KEY = 'b'.repeat(64)
process.env.APPLE_GATEWAY_INTERVAL_MS = '1500'

const { ensureConfigDir, loadSecretsAtBoot } = {
  ...(await import('../lib/settingsStore.mjs')),
  ...(await import('../lib/secretKey.mjs')),
}
await ensureConfigDir(tmpConfig)
loadSecretsAtBoot(tmpConfig)
const { appleGateway } = await import('../lib/appleGateway.mjs')
const { settingsRouter } = await import('../routes/settings.mjs')

async function call(method, url, body) {
  const app = express()
  app.use(express.json())
  app.use('/api/settings', settingsRouter)
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, json: await res.json() }
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('pacing settings are clamped, saved, and applied to the running gateway', async () => {
  const saved = await call('PUT', '/api/settings', {
    appleGatewayIntervalMs: 2500,
    appleGatewayMinIntervalMs: 20, // below the allowed minimum
    appleGatewayAdaptive: false,
    appleGatewayCooldownMinutes: 999, // above the allowed maximum
  })
  assert.equal(saved.status, 200)
  const status = (await call('GET', '/api/settings/apple-status')).json
  assert.deepEqual(status.config, { intervalMs: 2500, minIntervalMs: 100, adaptive: false, cooldownMinutes: 240 })
  assert.equal(status.intervalMs, 2500)
})

test('clearing a setting goes back to the default; non-boolean adaptive is ignored', async () => {
  await call('PUT', '/api/settings', { appleGatewayAdaptive: 'yes' })
  assert.equal(appleGateway.status().config.adaptive, false, 'still off')
  await call('PUT', '/api/settings', {
    appleGatewayIntervalMs: null,
    appleGatewayMinIntervalMs: null,
    appleGatewayAdaptive: true,
    appleGatewayCooldownMinutes: null,
  })
  const { config } = appleGateway.status()
  assert.equal(config.intervalMs, 1500)
  assert.equal(config.minIntervalMs, 600)
  assert.equal(config.adaptive, true)
  assert.equal(config.cooldownMinutes, 15)
})

test('reset forgets the learned pace limit', async () => {
  appleGateway.report(429)
  assert.ok(appleGateway.status().learnedFloorMs > 0)
  const res = await call('POST', '/api/settings/apple-status/reset')
  assert.equal(res.json.learnedFloorMs, 0)
  assert.equal(res.json.strikes, 0)
})
