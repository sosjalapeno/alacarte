import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.APPLE_GATEWAY_INTERVAL_MS = '0'
process.env.APPLE_GATEWAY_MIN_INTERVAL_MS = '0'
process.env.AMDL_CONFIG_DIR = '/nonexistent-alacarte-test'
const { getAlbum, searchCatalog } = await import('../lib/appleApi.mjs')
const { runInLane } = await import('../lib/appleGateway.mjs')

const realFetch = globalThis.fetch
let appleCalls = []
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u === 'https://music.apple.com') return new Response('<script src="/assets/index~a.js"></script>')
  if (u.endsWith('/assets/index~a.js')) return new Response('eyJhaa.eyJbbb.ccc')
  appleCalls.push(u)
  await new Promise((r) => setTimeout(r, 20))
  return Response.json({ data: [{ id: 'x', n: appleCalls.length }] })
}
test.after(() => {
  globalThis.fetch = realFetch
})

test('identical requests made at the same time share one Apple call', async () => {
  appleCalls = []
  const [a, b, c] = await Promise.all([
    getAlbum({ storefront: 'nz', id: '1' }),
    getAlbum({ storefront: 'nz', id: '1' }),
    getAlbum({ storefront: 'nz', id: '2' }),
  ])
  assert.equal(appleCalls.length, 2)
  assert.deepEqual(a, b)
  assert.notEqual(a, b, 'each caller gets its own copy')
  a.data[0].id = 'changed'
  assert.equal(b.data[0].id, 'x')
  assert.equal(c.data[0].id, 'x')
})

test('requests from different lanes are not merged, later ones are sent again', async () => {
  appleCalls = []
  await Promise.all([
    runInLane('interactive', () => searchCatalog({ storefront: 'nz', term: 'q' })),
    runInLane('background', () => searchCatalog({ storefront: 'nz', term: 'q' })),
  ])
  assert.equal(appleCalls.length, 2)
  await searchCatalog({ storefront: 'nz', term: 'q' })
  assert.equal(appleCalls.length, 3)
})
