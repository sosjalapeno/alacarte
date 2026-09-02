import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFailureTail,
  extractWrapperFailureReason,
  redactWrapperOutput,
} from '../lib/wrapperLoginDiagnostics.mjs'

test('uses StoreServices diagnostics instead of the generic response type', () => {
  const reason = extractWrapperFailureReason(`
    [!] server message: This Apple Account cannot be used for purchases.
    [!] auth error: code=-5000, message=Authentication failed upstream
    [.] response type 4
  `)

  assert.equal(
    reason,
    'Apple sign-in failed: This Apple Account cannot be used for purchases. — StoreServices error -5000: Authentication failed upstream',
  )
})

test('describes response type 4 as generic rather than a credential rejection', () => {
  const reason = extractWrapperFailureReason('[.] response type 4')

  assert.match(reason, /generic failure code/i)
  assert.doesNotMatch(reason, /wrong password|rejected the (email|sign-in)/i)
})

test('keeps a specific Apple account dialog ahead of generic diagnostics', () => {
  const reason = extractWrapperFailureReason(`
    [.] dialogHandler: {title: Account Information, message: Please try again.}
    [!] auth error: code=4, message=generic failure
    [.] response type 4
  `)

  assert.equal(
    reason,
    'Apple rejected the email or password. Double-check both and try again.',
  )
})

test('redacts credentials before collecting or exposing wrapper output', () => {
  const output = redactWrapperOutput(
    'user@example.com failed with abc:def and user@example.com',
    'user@example.com',
    'abc:def',
  )

  assert.equal(
    output,
    '[redacted-email] failed with [redacted-password] and [redacted-email]',
  )
})

test('failure tail keeps diagnostics and removes bionic startup noise', () => {
  const tail = buildFailureTail(`
    __bionic_open_tzdata: couldn't find any tzdata
    [+] initializing StoreServices
    [!] server message: Try again later.
    [!] auth error: code=500, message=temporary failure
  `)

  assert.deepEqual(tail, [
    '[!] server message: Try again later.',
    '[!] auth error: code=500, message=temporary failure',
  ])
})

test('hides unreadable StoreServices codes from truncated pointer values', () => {
  const reason = extractWrapperFailureReason(`
    [+] logging in...
    [.] dialogHandler: {title: Sign In, message: }
    [.] credentialHandler: {title: , message: , 2FA: false}
    [!] auth error: code=-269227992, message=
    [!] auth error: code=-269227992, message=
    [.] response type 4
    [!] login failed
  `)

  assert.match(reason, /code unreadable/i)
  assert.doesNotMatch(reason, /-269227992/)
})

test('parses external and status fields from auth error lines', () => {
  const reason = extractWrapperFailureReason(`
    [!] auth error: code=2, external=5002, status=0, message=
    [.] response type 4
  `)

  assert.equal(reason, 'Apple sign-in failed: StoreServices error 2 (external 5002)')
})
