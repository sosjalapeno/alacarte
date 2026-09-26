import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import {
  buildFailureTail,
  extractWrapperFailureReason,
  formatUnexpectedExitFallback,
  logsIndicateTwoFa,
  redactWrapperOutput,
  TWO_FA_HINT,
} from '../lib/wrapperLoginDiagnostics.mjs'
import {
  clearHardBlock,
  validate2faCode,
  isWrapperReachable,
  startWrapperLogin,
  submit2FA,
  cancelLogin,
  getLoginStatus,
} from '../lib/wrapperLogin.mjs'

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

  assert.match(reason, /Apple rejected the email or password/)
  assert.match(reason, /hardware security keys/)
  assert.match(reason, /account\.apple\.com/)
})

test('explains the security-key dead end when the 2FA code times out', () => {
  const reason = extractWrapperFailureReason(`
    [.] credentialHandler: {title: , message: , 2FA: true}
    [!] Enter your 2FA code into rootfs/data/data/com.apple.android.music/files/2fa.txt
    [!] Failed to get 2FA Code in 60s. Exiting...
  `)

  assert.match(reason, /No 2FA code was entered/)
  assert.match(reason, /Get Verification Code/)
  assert.match(reason, /hardware security keys/)
  assert.doesNotMatch(reason, /just try again/i)
})

test('describes response type 0 as a pre-completion rejection', () => {
  const reason = extractWrapperFailureReason(`
    [.] credentialHandler: {title: , message: , 2FA: false}
    [.] response type 0
    [!] login failed
  `)

  assert.match(reason, /before completing authentication/)
  assert.match(reason, /hardware security keys/)
})

test('2FA hint tells users where codes come from and about security keys', () => {
  assert.match(TWO_FA_HINT, /Get Verification Code/)
  assert.match(TWO_FA_HINT, /hardware security keys/)
  assert.match(TWO_FA_HINT, /account\.apple\.com/)
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

test('does not treat 2FA progress lines as the final failure reason', () => {
  const reason = extractWrapperFailureReason(`
    [+] logging in...
    [.] dialogHandler: {title: Sign In, message: }
    [.] credentialHandler: {title: , message: , 2FA: true}
    [!] Enter your 2FA code into rootfs/data/data/com.apple.android.music/files/2fa.txt
    [!] Code file detected! Logging in...
  `)

  assert.equal(reason, null)
})

test('keeps StoreServices errors ahead of 2FA progress lines', () => {
  const reason = extractWrapperFailureReason(`
    [!] Enter your 2FA code into rootfs
    [!] Code file detected! Logging in...
    [!] auth error: code=-5000, message=Authentication failed upstream
    [.] response type 4
  `)

  assert.equal(
    reason,
    'Apple sign-in failed: StoreServices error -5000: Authentication failed upstream',
  )
})

test('detects 2FA from the enter-code banner or credentialHandler', () => {
  assert.equal(
    logsIndicateTwoFa(
      '[!] Enter your 2FA code into rootfs/data/data/com.apple.android.music/files/2fa.txt',
    ),
    true,
  )
  assert.equal(
    logsIndicateTwoFa(
      '[.] credentialHandler: {title: , message: , 2FA: true}',
    ),
    true,
  )
  assert.equal(
    logsIndicateTwoFa(
      '[.] credentialHandler: {title: , message: , 2FA: false}',
    ),
    false,
  )
})

test('keeps unexpected-exit fallbacks from being empty', () => {
  assert.equal(
    formatUnexpectedExitFallback({ twoFaDetected: false }),
    'Sign-in worker exited unexpectedly (twoFaDetected=0)',
  )
  assert.equal(
    formatUnexpectedExitFallback({ twoFaDetected: true, twoFaSubmitted: true }),
    'Sign-in ended without success after 2FA (twoFaDetected=1 twoFaSubmitted=1)',
  )
})

test('accepts only exactly six digits for 2FA codes', () => {
  assert.equal(validate2faCode('123456'), true)
  assert.equal(validate2faCode(' 123456 '), true)
  assert.equal(validate2faCode('12345'), false)
  assert.equal(validate2faCode('1234567'), false)
  assert.equal(validate2faCode('12a456'), false)
})

const realFetch = globalThis.fetch
test.before(() => {
  globalThis.fetch = (url, opts) =>
    String(url).startsWith('https://buy.itunes.apple.com/')
      ? Promise.resolve(new Response(null, { status: 200 }))
      : realFetch(url, opts)
})
test.after(() => {
  globalThis.fetch = realFetch
})

async function withSupervisor(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
  process.env.AMDL_WRAPPER_SUPERVISOR_PORT = String(server.address().port)
  try {
    await fn()
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}

async function waitFor(pred) {
  for (let i = 0; i < 100 && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.ok(pred())
}

// Opens the /login stream and resolves with the request once the supervisor
// has written the given lines, leaving the stream open.
function openLoginStream(lines, onRequest = () => {}) {
  return (req, res) => {
    if (req.url !== '/login' || req.method !== 'POST') return false
    req.resume()
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    for (const line of lines) res.write(`${line}\n`)
    onRequest(req, res)
    return true
  }
}

test('isWrapperReachable checks the supervisor health endpoint', async () => {
  await withSupervisor(
    (req, res) => {
      res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, mode: 'normal' }))
    },
    async () => assert.equal(await isWrapperReachable(), true),
  )
  assert.equal(await isWrapperReachable(), false)
})

test('startWrapperLogin resolves on success and closes the login stream', async () => {
  let closed = false
  const login = openLoginStream(['[+] logging in...', '[.] account info cached successfully'], (req) => {
    req.socket.on('close', () => { closed = true })
  })
  await withSupervisor(login, async () => {
    assert.deepEqual(await startWrapperLogin({ email: 'test@example.com', password: 'pass' }), { ok: true })
    assert.equal(getLoginStatus().inProgress, false)
    await waitFor(() => closed)
  })
})

test('startWrapperLogin rejects with the wrapper diagnostic when the stream ends', async () => {
  await withSupervisor(
    (req, res) => {
      openLoginStream([
        '[+] logging in...',
        '[.] dialogHandler: {title: Your Apple Account is disabled., message: Contact support.}',
      ])(req, res)
      res.end()
    },
    async () => {
      await assert.rejects(
        startWrapperLogin({ email: 'test@example.com', password: 'pass' }),
        /Apple Account is disabled/,
      )
      clearHardBlock()
    },
  )
})

test('submit2FA forwards the code to the supervisor', async () => {
  let receivedCode = null
  let loginRes = null
  const login = openLoginStream(
    ['[!] Enter your 2FA code into rootfs/data/data/com.apple.android.music/files/2fa.txt'],
    (_req, res) => { loginRes = res },
  )
  await withSupervisor(
    (req, res) => {
      if (login(req, res)) return
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        receivedCode = JSON.parse(body).code
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        loginRes.write('[.] account info cached successfully\n')
      })
    },
    async () => {
      const loginPromise = startWrapperLogin({ email: 'user@example.com', password: 'secretpassword' })
      await waitFor(() => getLoginStatus().status?.phase === '2fa-required')
      assert.deepEqual(await submit2FA(' 654321 '), { ok: true })
      assert.equal(receivedCode, '654321')
      assert.deepEqual(await loginPromise, { ok: true })
    },
  )
})

test('submit2FA can be retried after the supervisor rejects it', async () => {
  let attempts = 0
  const login = openLoginStream(['[!] Enter your 2FA code into rootfs/data/2fa.txt'])
  await withSupervisor(
    (req, res) => {
      if (login(req, res)) return
      req.resume()
      attempts++
      res.writeHead(attempts === 1 ? 409 : 200)
      res.end(attempts === 1 ? 'No sign-in in progress\n' : '{"ok":true}')
    },
    async () => {
      const loginPromise = startWrapperLogin({ email: 'user@example.com', password: 'pw' })
      await waitFor(() => getLoginStatus().status?.phase === '2fa-required')
      await assert.rejects(submit2FA('111111'), /^Error: No sign-in in progress$/)
      assert.deepEqual(await submit2FA('222222'), { ok: true })
      cancelLogin()
      await assert.rejects(loginPromise, /Cancelled/)
    },
  )
})

test('cancelLogin rejects the sign-in and closes the login stream', async () => {
  let closed = false
  const login = openLoginStream(['[+] logging in...'], (req) => {
    req.socket.on('close', () => { closed = true })
  })
  await withSupervisor(login, async () => {
    const loginPromise = startWrapperLogin({ email: 'user@example.com', password: 'secretpassword' })
    await waitFor(() => getLoginStatus().status?.phase === 'signing-in')
    assert.deepEqual(cancelLogin(), { ok: true })
    await assert.rejects(loginPromise, /Cancelled/)
    await waitFor(() => closed)
  })
})
