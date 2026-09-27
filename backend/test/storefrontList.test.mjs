import { test } from 'node:test'
import assert from 'node:assert/strict'

const { storefrontList, __setStorefrontFetchForTests } = await import('../lib/storefrontList.mjs')

test('storefront list is exactly what apple returns, localized and sorted', async () => {
  const calls = []
  __setStorefrontFetchForTests(async (tag) => {
    calls.push(tag)
    return [
      { id: 'pl', attributes: { name: 'ポーランド' } },
      { id: 'jp', attributes: { name: '日本' } },
      { id: 'us', attributes: { name: 'アメリカ合衆国' } },
    ]
  })
  const list = await storefrontList('ja')
  assert.deepEqual(list.map((s) => s.id).sort(), ['jp', 'pl', 'us'])
  assert.equal(list.length, 3)
  await storefrontList('ja')
  assert.deepEqual(calls, ['ja'])
  await storefrontList('zh-Hant')
  await storefrontList('xx')
  assert.deepEqual(calls, ['ja', 'zh-Hant-TW', 'en-US'])
  __setStorefrontFetchForTests(null)
})

test('failed apple lookups are not cached', async () => {
  let fail = true
  __setStorefrontFetchForTests(async () => {
    if (fail) throw new Error('down')
    return [{ id: 'us', attributes: { name: 'United States' } }]
  })
  await assert.rejects(storefrontList('en'))
  fail = false
  assert.deepEqual(await storefrontList('en'), [{ id: 'us', name: 'United States' }])
  __setStorefrontFetchForTests(null)
})
