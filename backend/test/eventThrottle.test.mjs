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

test('message and current-track changes are never held back', async () => {
  const { updateJob, state } = __test__
  const seen = []
  const off = onEvent((ev) => ev.type === 'job.update' && ev.data.id === 'throttle-2' && seen.push({ ...ev.data }))
  state.jobs.set('throttle-2', { id: 'throttle-2', status: 'running', progress: 0, message: 'Preparing', stats: {} })
  try {
    updateJob('throttle-2', { progress: 1 })
    updateJob('throttle-2', { progress: 2 })
    updateJob('throttle-2', { message: 'Skipped Some Song (no album)' })
    updateJob('throttle-2', { progress: 3, currentTrack: 'Next Song' })
    assert.deepEqual(
      seen.map((e) => [e.progress, e.message, e.currentTrack ?? null]),
      [
        [1, 'Preparing', null],
        [2, 'Skipped Some Song (no album)', null],
        [3, 'Skipped Some Song (no album)', 'Next Song'],
      ],
    )
  } finally {
    off()
    state.jobs.delete('throttle-2')
  }
})

test('the newest held-back progress line is flushed before real lines and at the end', async () => {
  const { handleAmdpLine, createProgressState, updateJob, state } = __test__
  const logs = []
  const off = onEvent((ev) => ev.type === 'job.log' && ev.data.id === 'throttle-3' && logs.push(ev.data.line))
  const job = { id: 'throttle-3', kind: 'album', status: 'running', progress: 0, stats: {} }
  state.jobs.set(job.id, job)
  const ps = createProgressState(job, { convertEnabled: false })
  try {
    for (const pct of [10, 40, 70, 100]) handleAmdpLine(job, `${pct}% |████| (${pct}/100 MB)`, 'stdout', ps)
    handleAmdpLine(job, 'Decrypted', 'stdout', ps)
    for (const pct of [5, 50]) handleAmdpLine(job, `${pct}% |██| (${pct}/100 MB)`, 'stdout', ps)
    assert.deepEqual(logs, ['10% |████| (10/100 MB)', '100% |████| (100/100 MB)', 'Decrypted', '5% |██| (5/100 MB)'])
    updateJob(job.id, { status: 'done', progress: 100 })
    assert.equal(logs.at(-1), '50% |██| (50/100 MB)')
  } finally {
    off()
    state.jobs.delete(job.id)
  }
})
