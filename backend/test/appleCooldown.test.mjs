import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.APPLE_429_COOLDOWN_MS = '60000'
process.env.APPLE_GATEWAY_INTERVAL_MS = '0'
process.env.APPLE_GATEWAY_MIN_INTERVAL_MS = '0'
const { searchCatalog, getAppleCooldownMs } = await import('../lib/appleApi.mjs')

test('after one Apple 429 every later call fails locally without hitting Apple', async () => {
  const realFetch = globalThis.fetch
  let appleCalls = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === 'https://music.apple.com') return new Response('<script src="/assets/index~a.js"></script>')
    if (u.endsWith('/assets/index~a.js')) return new Response('eyJhaa.eyJbbb.ccc')
    if (u.includes('amp-api.music.apple.com')) {
      appleCalls++
      return new Response('{}', { status: 429 })
    }
    return new Response('0.0.0.0') // ipify
  }
  try {
    await assert.rejects(searchCatalog({ storefront: 'nz', term: 'a' }), /Apple API 429/)
    assert.ok(getAppleCooldownMs() > 0)
    await assert.rejects(searchCatalog({ storefront: 'nz', term: 'b' }), /Apple API 429.*rate limited by Apple/)
    assert.equal(appleCalls, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})
