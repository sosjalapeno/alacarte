import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-throttle-'))
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-music-'))

const { onEvent } = await import('../lib/eventBus.mjs')
const { __test__ } = await import('../lib/queue.mjs')
const { emitJobUpdate, isProgressOnlyLine } = __test__

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('progress updates are coalesced but the latest state and status changes always go out', async () => {
  const seen = []
  const off = onEvent((ev) => ev.type === 'job.update' && seen.push({ ...ev.data }))
  const job = { id: 'throttle-1', status: 'running', progress: 0, stats: {} }
  try {
    for (let p = 1; p <= 50; p++) {
      job.progress = p
      emitJobUpdate(job, false)
    }
    assert.equal(seen.length, 1)
    await sleep(300)
    assert.equal(seen.length, 2)
    assert.equal(seen.at(-1).progress, 50)

    job.progress = 60
    emitJobUpdate(job, false)
    job.status = 'done'
    job.progress = 100
    emitJobUpdate(job, true)
    await sleep(300)
    assert.equal(seen.at(-1).status, 'done')
    assert.equal(seen.filter((e) => e.status === 'done').length, 1)
  } finally {
    off()
  }
})

test('only bare progress lines are throttled', () => {
  assert.equal(isProgressOnlyLine('45% |██████      | (12/30 MB, 5.1 MB/s)'), true)
  assert.equal(isProgressOnlyLine('Track 2 of 4: songs'), false)
  assert.equal(isProgressOnlyLine('Failed to run v2: 45% done'), false)
})
