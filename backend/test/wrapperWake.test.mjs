import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

async function freePort() {
  const srv = net.createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  await new Promise((r) => srv.close(r))
  return port
}

// The wrapper ports stay closed until the fake supervisor is woken, like a
// wrapper held back by the lease-loss restart backoff.
const wrapperPorts = [await freePort(), await freePort(), await freePort()]
const wrapperServers = []
let wakes = 0
const supervisor = http.createServer(async (req, res) => {
  if (req.url === '/wake' && req.method === 'POST') {
    wakes++
    for (const port of wrapperPorts) {
      const s = net.createServer((c) => c.destroy())
      await new Promise((r) => s.listen(port, '127.0.0.1', r))
      wrapperServers.push(s)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, mode: 'normal', running: true }))
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, mode: 'idle', running: false, reason: 'lease_lost', restartInMs: 60000 }))
})
await new Promise((r) => supervisor.listen(0, '127.0.0.1', r))

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-wake-'))
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-music-'))
process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
process.env.AMDL_WRAPPER_SUPERVISOR_PORT = String(supervisor.address().port)
process.env.AMDL_WRAPPER_DECRYPT_PORT = String(wrapperPorts[0])
process.env.AMDL_WRAPPER_M3U8_PORT = String(wrapperPorts[1])
process.env.AMDL_WRAPPER_ACCOUNT_PORT = String(wrapperPorts[2])

const { probeWrapperPorts } = await import('../lib/wrapperHealth.mjs')
const { getSupervisorHealth } = await import('../lib/wrapperLogin.mjs')
const { __test__ } = await import('../lib/queue.mjs')

test.after(async () => {
  for (const s of wrapperServers) s.close()
  supervisor.close()
})

test('supervisor health exposes the lease-loss restart backoff', async () => {
  const h = await getSupervisorHealth()
  assert.equal(h.reason, 'lease_lost')
  assert.equal(h.restartInMs, 60000)
})

test('a download wakes a paused wrapper instead of failing', async () => {
  assert.equal((await probeWrapperPorts()).ok, false)
  const health = await __test__.wakeAndWaitForWrapper({ id: 'wake-1', cancelled: false })
  assert.equal(wakes, 1)
  assert.equal(health.ok, true)
})
