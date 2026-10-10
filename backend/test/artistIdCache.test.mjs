import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-artist-cache-'))
const { normalizeArtistName, readStoredArtistIds, storeArtistId, rememberArtistNames } = await import(
  '../lib/artistIdCache.mjs'
)

test('names in any script get a key, accents and punctuation are ignored', () => {
  assert.equal(normalizeArtistName('周杰倫'), '周杰倫')
  assert.equal(normalizeArtistName('Beyoncé'), 'beyonce')
  assert.equal(normalizeArtistName('  AC/DC '), 'ac dc')
  assert.equal(normalizeArtistName('Привет'), 'привет')
  assert.equal(normalizeArtistName('!!!'), '')
})

test('one artist can be stored under several names', () => {
  storeArtistId('nz', normalizeArtistName('Jay Chou'), '111')
  storeArtistId('nz', normalizeArtistName('周杰倫'), '111')
  const ids = readStoredArtistIds('nz')
  assert.equal(ids.get('jay chou'), '111')
  assert.equal(ids.get('周杰倫'), '111')
  assert.equal(readStoredArtistIds('us').size, 0)
})

test('names seen in search results are remembered unless ambiguous or already known', () => {
  storeArtistId('nz', 'known artist', '1')
  rememberArtistNames('nz', [
    { id: '2', name: 'Known Artist' }, // already known: kept
    { id: '3', name: 'Twin' },
    { id: '4', name: 'Twin' }, // same name, different artists: skipped
    { id: '5', name: '五月天' },
  ])
  const ids = readStoredArtistIds('nz')
  assert.equal(ids.get('known artist'), '1')
  assert.equal(ids.has('twin'), false)
  assert.equal(ids.get('五月天'), '5')
})
