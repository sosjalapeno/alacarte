import test from 'node:test'
import assert from 'node:assert/strict'

import { parseAppleMusicUrl } from '../lib/appleMusicUrl.mjs'

test('returns null for ordinary search terms', () => {
  assert.equal(parseAppleMusicUrl('radiohead'), null)
  assert.equal(parseAppleMusicUrl('https://example.com/album/1'), null)
  assert.equal(parseAppleMusicUrl(''), null)
})

test('parses album urls with storefront and slug', () => {
  assert.deepEqual(
    parseAppleMusicUrl(
      'https://music.apple.com/us/album/in-rainbows/1627498557?uo=4&l=en-US',
    ),
    { kind: 'album', id: '1627498557', storefront: 'us' },
  )
})

test('parses album urls without storefront', () => {
  assert.deepEqual(
    parseAppleMusicUrl('https://music.apple.com/album/1627498557'),
    { kind: 'album', id: '1627498557' },
  )
})

test('parses itunes album urls with id prefix', () => {
  assert.deepEqual(
    parseAppleMusicUrl('https://itunes.apple.com/gb/album/ok-computer/id1109716833'),
    { kind: 'album', id: '1109716833', storefront: 'gb' },
  )
})

test('parses song deep links via album path and i= query', () => {
  assert.deepEqual(
    parseAppleMusicUrl(
      'https://music.apple.com/us/album/15-step/1627498557?i=1627498560',
    ),
    {
      kind: 'song',
      id: '1627498560',
      albumId: '1627498557',
      storefront: 'us',
    },
  )
})

test('parses song urls', () => {
  assert.deepEqual(
    parseAppleMusicUrl(
      'https://geo.music.apple.com/us/song/15-step/1627498560',
    ),
    { kind: 'song', id: '1627498560', storefront: 'us' },
  )
})

test('parses artist urls', () => {
  assert.deepEqual(
    parseAppleMusicUrl(
      'https://music.apple.com/us/artist/radiohead/657515',
    ),
    { kind: 'artist', id: '657515', storefront: 'us' },
  )
})

test('parses playlist urls', () => {
  assert.deepEqual(
    parseAppleMusicUrl(
      'https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb',
    ),
    {
      kind: 'playlist',
      id: 'pl.f4d106fed2bd41149aaacabb233eb5eb',
      storefront: 'us',
    },
  )
})

test('accepts host-only paste without scheme and wrapping quotes', () => {
  assert.deepEqual(
    parseAppleMusicUrl(
      '"music.apple.com/us/album/kid-a/1440841489"',
    ),
    { kind: 'album', id: '1440841489', storefront: 'us' },
  )
})

test('rejects library, station, and music-video links', () => {
  for (const input of [
    'https://music.apple.com/us/library/albums/l.abc',
    'https://music.apple.com/us/station/pure-radio/ra.123',
    'https://music.apple.com/us/music-video/clip/123',
  ]) {
    const parsed = parseAppleMusicUrl(input)
    assert.equal(parsed?.unsupported, true)
    assert.match(parsed.message, /not a catalog/i)
  }
})
