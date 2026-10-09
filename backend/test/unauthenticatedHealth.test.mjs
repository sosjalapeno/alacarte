import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const supervisor = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      mode: 'idle',
      running: false,
      authenticated: false,
      reason: 'unauthenticated',
    }),
  )
})
await new Promise((r) => supervisor.listen(0, '127.0.0.1', r))

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-unauth-cfg-'))
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-unauth-music-'))
process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
process.env.AMDL_WRAPPER_SUPERVISOR_PORT = String(supervisor.address().port)
// Port 1 will be closed, producing ECONNREFUSED
process.env.AMDL_WRAPPER_DECRYPT_PORT = '1'
process.env.AMDL_WRAPPER_M3U8_PORT = '1'
process.env.AMDL_WRAPPER_ACCOUNT_PORT = '1'

const { healthRouter } = await import('../routes/health.mjs')

test.after(() => {
  supervisor.close()
})

test('health endpoint reports clear unauthenticated error when supervisor is unauthenticated', async () => {
  const app = express()
  app.use('/api/health', healthRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.wrapper.up, false)
    assert.equal(data.wrapper.supervisor.reason, 'unauthenticated')
    assert.equal(data.wrapper.supervisor.authenticated, false)
    assert.equal(
      data.wrapper.decrypt.error,
      'wrapper has no Apple Music credentials (sign in under Settings -> Apple Account)',
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
