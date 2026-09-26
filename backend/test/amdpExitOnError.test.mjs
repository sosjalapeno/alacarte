import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-amdp-'))
const tmpMusic = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-music-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic

const { writeAmdpConfig } = await import('../lib/amdpRunner.mjs')
const { __test__ } = await import('../lib/queue.mjs')
const { assertAmdpResult, isSkippableTrackError, renumberFromTrackTag } = __test__

const NOISE = 'Failed to decrypt secret: secret key not initialized'

function run(code, stdout, stderr = NOISE) {
  return [{ code, stdout, stderr }, `${stdout}\n${stderr}`]
}

test('amdp config exits after a failed pass instead of waiting for Enter', async () => {
  const cfgPath = await writeAmdpConfig({ settings: {}, mediaUserToken: 't', stagingRoot: tmpConfig })
  assert.match(await fsp.readFile(cfgPath, 'utf8'), /^exit-on-error: true$/m)
})

test('playlist tracks keep their album metadata instead of the playlist', async () => {
  const cfgPath = await writeAmdpConfig({ settings: {}, mediaUserToken: 't', stagingRoot: tmpConfig })
  assert.match(await fsp.readFile(cfgPath, 'utf8'), /^use-songinfo-for-playlist: true$/m)
})

test('playlist files are renumbered from the album track tag', () => {
  assert.equal(renumberFromTrackTag('08. Double Trio 2.m4a', '7/9'), '07. Double Trio 2.m4a')
  assert.equal(renumberFromTrackTag('05. And I Dance.flac', '1'), '01. And I Dance.flac')
  assert.equal(renumberFromTrackTag('12. GGG.m4a', null), '12. GGG.m4a')
  assert.equal(renumberFromTrackTag('No Number.m4a', '3'), 'No Number.m4a')
})

test('a clean amdp run is not partial', () => {
  const out = '=======  [✔ ] Completed: 3/3  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 0  ======='
  assert.equal(assertAmdpResult(...run(0, out)), null)
})

test('a pass with some failed tracks keeps the downloaded ones', () => {
  const out = [
    'Track 2 of 3: songs',
    'Failed to run v2: dial tcp 127.0.0.1:10020: connect: connection refused',
    '=======  [✔ ] Completed: 2/3  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 1  =======',
    'Error detected, exiting...',
  ].join('\n')
  assert.deepEqual(assertAmdpResult(...run(1, out)), {
    failed: 1,
    reason: 'Failed to run v2: dial tcp 127.0.0.1:10020: connect: connection refused',
  })
})

test('a pass where nothing downloaded fails with the amdp error, not the noise line', () => {
  const out = [
    '\x1b[31mFailed to run v2: invalid CKC\x1b[0m',
    '=======  [✔ ] Completed: 0/1  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 1  =======',
    'Error detected, exiting...',
  ].join('\n')
  assert.throws(() => assertAmdpResult(...run(1, out)), /^Error: amdp exited 1: Failed to run v2: invalid CKC$/)
})

test('a silent track failure names the track count instead of the noise line', () => {
  const out = '=======  [✔ ] Completed: 0/1  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 1  =======\nError detected, exiting...'
  assert.throws(() => assertAmdpResult(...run(1, out)), /^Error: amdp exited 1: 1 of 1 track\(s\) failed to download$/)
})

test('a non-zero exit without a summary still fails', () => {
  assert.throws(() => assertAmdpResult(...run(2, 'panic: boom', 'boom')), /amdp exited 2: boom/)
})

test('per-track loops skip download failures but not cancels or stalls', () => {
  const job = { cancelled: false }
  assert.equal(isSkippableTrackError(job, new Error('amdp exited 1: Failed to run v2')), true)
  const stall = Object.assign(new Error('wrapper stalled'), { code: 'WRAPPER_STALL' })
  assert.equal(isSkippableTrackError(job, stall), false)
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  assert.equal(isSkippableTrackError(job, abort), false)
  assert.equal(isSkippableTrackError({ cancelled: true }, new Error('x')), false)
})
