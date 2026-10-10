import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const { createGateway, runInLane, currentLane, AppleRateLimitedError } = await import('../lib/appleGateway.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Records the order and time at which tasks actually run.
function recorder() {
  const runs = []
  const task = (name, status = 200, gw) => async () => {
    runs.push({ name, at: Date.now() })
    gw?.report(status)
    return name
  }
  return { runs, task }
}

test('calls are spaced by the interval and run at most maxInFlight at once', async () => {
  const gw = createGateway({ intervalMs: 40, minIntervalMs: 40, maxInFlight: 1, burst: 1 })
  const { runs, task } = recorder()
  await Promise.all(['a', 'b', 'c'].map((n) => gw.schedule(task(n, 200, gw), { lane: 'batch' })))
  assert.deepEqual(runs.map((r) => r.name), ['a', 'b', 'c'])
  assert.ok(runs[1].at - runs[0].at >= 35 && runs[2].at - runs[1].at >= 35, 'gap of about 40 ms')
})

test('interactive jumps ahead of queued batch and background calls, background goes last', async () => {
  const gw = createGateway({ intervalMs: 30, minIntervalMs: 30, burst: 1, maxInFlight: 1 })
  const { runs, task } = recorder()
  const all = [
    gw.schedule(task('first', 200, gw), { lane: 'batch' }),
    gw.schedule(task('bg', 200, gw), { lane: 'background' }),
    gw.schedule(task('batch2', 200, gw), { lane: 'batch' }),
    gw.schedule(task('ui', 200, gw), { lane: 'interactive' }),
  ]
  await Promise.all(all)
  assert.deepEqual(runs.map((r) => r.name), ['first', 'ui', 'batch2', 'bg'])
})

test('a steady stream of interactive calls still lets batch through', async () => {
  const gw = createGateway({ intervalMs: 5, minIntervalMs: 5, burst: 1, maxInFlight: 1, batchEvery: 3 })
  const { runs, task } = recorder()
  const all = []
  for (let i = 0; i < 8; i++) all.push(gw.schedule(task(`ui${i}`, 200, gw), { lane: 'interactive' }))
  all.push(gw.schedule(task('batch', 200, gw), { lane: 'batch' }))
  await Promise.all(all)
  const pos = runs.findIndex((r) => r.name === 'batch')
  assert.ok(pos > 0 && pos < 5, `batch ran at position ${pos}, not last`)
})

test('interactive calls can burst, other lanes cannot', async () => {
  const gw = createGateway({ intervalMs: 200, minIntervalMs: 200, burst: 3, maxInFlight: 5 })
  const { runs, task } = recorder()
  await Promise.all([1, 2, 3].map((i) => gw.schedule(task(`ui${i}`, 200, gw), { lane: 'interactive' })))
  assert.ok(runs[2].at - runs[0].at < 100, 'three interactive calls go out together')
  const t0 = Date.now()
  await gw.schedule(task('b1', 200, gw), { lane: 'batch' })
  await gw.schedule(task('b2', 200, gw), { lane: 'batch' })
  assert.ok(Date.now() - t0 >= 190, 'batch calls wait for the gap')
})

test('the gap shrinks after a run of successes but not below the floor', async () => {
  const gw = createGateway({ intervalMs: 0.4 * 100, minIntervalMs: 30, speedUpAfter: 3, speedUpFactor: 0.5, burst: 10, maxInFlight: 5 })
  assert.equal(gw.status().intervalMs, 40)
  for (let i = 0; i < 3; i++) gw.report(200)
  assert.equal(gw.status().intervalMs, 30, 'halved but held at the floor')
  for (let i = 0; i < 9; i++) gw.report(200)
  assert.equal(gw.status().intervalMs, 30)
})

test('a 429 doubles the gap, raises the floor, blocks calls and escalates on repeats', async () => {
  const gw = createGateway({ intervalMs: 100, minIntervalMs: 50, cooldownBaseMs: 60 })
  gw.report(429)
  let s = gw.status()
  assert.equal(s.state, 'cooldown')
  assert.equal(s.intervalMs, 200)
  assert.equal(s.floorMs, 125, 'floor 25% above the pace that failed')
  await assert.rejects(gw.schedule(async () => 1, { lane: 'interactive', path: '/v1/x' }), (e) => {
    assert.ok(e instanceof AppleRateLimitedError)
    assert.match(e.message, /Apple API 429 on \/v1\/x/)
    assert.equal(e.status, 429)
    return true
  })
  await sleep(70)
  assert.equal(gw.status().state, 'probing')
  // the probe fails again: second strike, twice the cooldown
  await gw.schedule(async () => gw.report(429), { lane: 'interactive' })
  s = gw.status()
  assert.equal(s.strikes, 2)
  const left = gw.cooldownRemainingMs()
  assert.ok(left > 60 && left <= 120, `cooldown doubled to 120 ms, ${left} ms left`)
  assert.equal(s.rateLimited24h, 2)
})

test('queued calls are rejected when a 429 arrives, and a successful probe reopens', async () => {
  const gw = createGateway({ intervalMs: 20, minIntervalMs: 20, maxInFlight: 1, burst: 1, cooldownBaseMs: 50 })
  const first = gw.schedule(async () => gw.report(429), { lane: 'batch' })
  const queued = gw.schedule(async () => 'never', { lane: 'background', path: '/q' })
  await first
  await assert.rejects(queued, /Apple API 429 on \/q/)
  await sleep(60)
  assert.equal(gw.status().state, 'probing')
  assert.equal(await gw.schedule(async () => { gw.report(200); return 'ok' }, { lane: 'batch' }), 'ok')
  assert.equal(gw.status().state, 'ok')
})

test('an interactive call that waits too long fails instead of hanging', async () => {
  const gw = createGateway({ intervalMs: 1000, minIntervalMs: 1000, burst: 1, maxInFlight: 1, interactiveMaxWaitMs: 40 })
  await gw.schedule(async () => 1, { lane: 'interactive' }) // uses the only burst credit
  await assert.rejects(gw.schedule(async () => 2, { lane: 'interactive', path: '/slow' }), /busy/)
})

test('lane follows async calls and defaults to background', async () => {
  assert.equal(currentLane(), 'background')
  await runInLane('interactive', async () => {
    await sleep(1)
    assert.equal(currentLane(), 'interactive')
    await runInLane('batch', async () => assert.equal(currentLane(), 'batch'))
    assert.equal(currentLane(), 'interactive')
  })
})

test('cooldown, gap and history survive a restart', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apple-gw-')), 'apple-rate.json')
  const a = createGateway({ intervalMs: 100, minIntervalMs: 50, cooldownBaseMs: 60_000, stateFile })
  a.report(429)
  const b = createGateway({ intervalMs: 100, minIntervalMs: 50, cooldownBaseMs: 60_000, stateFile })
  const s = b.status()
  assert.equal(s.state, 'cooldown')
  assert.equal(s.intervalMs, 200)
  assert.equal(s.floorMs, 125)
  assert.equal(s.strikes, 1)
  await assert.rejects(b.schedule(async () => 1), /rate limited by Apple/)
})

test('base cooldown of 0 disables the block but still slows down', async () => {
  const gw = createGateway({ intervalMs: 10, minIntervalMs: 10, cooldownBaseMs: 0 })
  gw.report(429)
  assert.equal(gw.status().state, 'ok')
  assert.equal(gw.status().intervalMs, 20)
  assert.equal(await gw.schedule(async () => 'still works'), 'still works')
})

test('configure applies the starting gap, minimum gap and adaptive switch; null goes back to the default', async () => {
  const gw = createGateway({ intervalMs: 100, minIntervalMs: 50, speedUpAfter: 2, speedUpFactor: 0.5 })
  gw.configure({ intervalMs: 400, minIntervalMs: 200, adaptive: true, cooldownMinutes: 5 })
  let s = gw.status()
  assert.equal(s.intervalMs, 400)
  assert.deepEqual(s.config, { intervalMs: 400, minIntervalMs: 200, adaptive: true, cooldownMinutes: 5 })
  gw.report(200)
  gw.report(200)
  assert.equal(gw.status().intervalMs, 200, 'speeds up, but not below the configured minimum')

  gw.configure({ intervalMs: 400, minIntervalMs: 200, adaptive: false })
  gw.report(200)
  gw.report(200)
  gw.report(200)
  assert.equal(gw.status().intervalMs, 400, 'fixed pace when adaptive is off')

  gw.configure({})
  s = gw.status()
  assert.equal(s.config.intervalMs, 100)
  assert.equal(s.config.minIntervalMs, 50)
  assert.equal(s.config.adaptive, true)
})

test('boot-time configure keeps the adapted pace; a learned floor survives settings changes and can be reset', async () => {
  const gw = createGateway({ intervalMs: 100, minIntervalMs: 50, cooldownBaseMs: 0 })
  gw.report(429) // gap 200, learned floor 125
  gw.configure({ intervalMs: 100, minIntervalMs: 10 }, { resetPace: false })
  let s = gw.status()
  assert.equal(s.intervalMs, 200)
  assert.equal(s.floorMs, 125, 'configured minimum 10 does not undo what the 429 taught')
  gw.configure({ intervalMs: 100, minIntervalMs: 10 })
  assert.equal(gw.status().intervalMs, 125, 'new starting gap, held at the learned floor')
  gw.resetLearned()
  s = gw.status()
  assert.equal(s.floorMs, 10)
  assert.equal(s.strikes, 0)
  assert.equal(s.intervalMs, 100)
})
