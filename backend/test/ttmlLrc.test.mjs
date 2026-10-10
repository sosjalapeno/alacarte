import test from 'node:test'
import assert from 'node:assert/strict'
import { formatLrcTimestamp, ttmlToLrc } from '../lib/ttmlLrc.mjs'

test('formatLrcTimestamp parses various time strings to standard [mm:ss.xx]', () => {
  assert.equal(formatLrcTimestamp('00:23.150'), '[00:23.15]')
  assert.equal(formatLrcTimestamp('01:04.080'), '[01:04.08]')
  assert.equal(formatLrcTimestamp('00:01:23.456'), '[01:23.46]')
  assert.equal(formatLrcTimestamp('12.34s'), '[00:12.34]')
  assert.equal(formatLrcTimestamp('75.5'), '[01:15.50]')
  assert.equal(formatLrcTimestamp(''), '[00:00.00]')
})

test('ttmlToLrc parses standard TTML and converts to synchronized LRC', () => {
  const ttml = `
<tt xmlns="http://www.w3.org/ns/ttml">
  <body>
    <div>
      <p begin="00:23.150" end="00:30.630">天空灰得像哭過 離開妳以後</p>
      <p begin="00:30.630" end="00:34.920"><span>並沒有更自由</span></p>
      <p begin="01:04.080" end="01:10.000">妳我的過去 &amp; 被順時針的忘記</p>
    </div>
  </body>
</tt>
`
  const expected = `[00:23.15]天空灰得像哭過 離開妳以後
[00:30.63]並沒有更自由
[01:04.08]妳我的過去 & 被順時針的忘記
`
  assert.equal(ttmlToLrc(ttml), expected)
})

test('ttmlToLrc returns empty string on empty or invalid input', () => {
  assert.equal(ttmlToLrc(''), '')
  assert.equal(ttmlToLrc(null), '')
  assert.equal(ttmlToLrc('<tt></tt>'), '')
})
