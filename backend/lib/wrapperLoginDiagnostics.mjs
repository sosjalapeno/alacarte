const RESPONSE_TYPE_HINTS = {
  4: 'Apple sign-in failed inside StoreServices (wrapper response type 4). This is a generic failure code, not proof that the email or password is wrong. Wait before retrying, then check Apple Music on the same network.',
}
// TODO: response types 0/1/2/3/5/7 are still empirically unknown.

function cleanWrapperDiagnostic(value, maxLength = 320) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim()
  if (!cleaned || /^none|null|undefined$/i.test(cleaned)) return ''
  return cleaned.slice(0, maxLength)
}

const UNREADABLE_CODE_THRESHOLD = 100_000

function isReadableStoreServicesCode(code) {
  return Number.isFinite(code) && Math.abs(code) <= UNREADABLE_CODE_THRESHOLD
}

function formatAuthErrorDetail(authError) {
  const { code, external, status, message } = authError
  let errorText = 'StoreServices error'
  if (Number.isFinite(code)) {
    errorText = isReadableStoreServicesCode(code)
      ? `StoreServices error ${code}`
      : 'StoreServices error (code unreadable)'
  }
  if (isReadableStoreServicesCode(code)) {
    const extras = []
    if (external != null && external !== 0) extras.push(`external ${external}`)
    if (status != null && status !== 0) extras.push(`status ${status}`)
    if (extras.length) errorText += ` (${extras.join(', ')})`
  }
  return message ? `${errorText}: ${message}` : errorText
}

export function extractWrapperFailureReason(s) {
  const lines = s
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const DIALOG_RE =
    /^\[\.\]\s*dialogHandler:\s*\{title:\s*(.*?),\s*message:\s*(.*?)\}$/i
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(DIALOG_RE)
    if (!m) continue
    const title = m[1].trim()
    const message = m[2].trim()
    if (!title || /^sign in$/i.test(title)) continue
    if (/disabled/i.test(title)) {
      return `Your Apple Account is disabled. ${message || 'Reset it at iforgot.apple.com, then try again.'}`
    }
    if (/account information/i.test(title)) {
      return 'Apple rejected the email or password. Double-check both and try again.'
    }
    if (/locked/i.test(title)) {
      return `Apple Account locked. ${message || 'Reset it at iforgot.apple.com before retrying.'}`
    }
    if (/billing|payment/i.test(title)) {
      return `Apple Music sign-in needs attention: ${title}. ${message}`
    }
    const joined = [title, message].filter(Boolean).join(' — ')
    if (joined) return joined.slice(0, 240)
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\[!\] Failed to get 2FA Code/i.test(lines[i])) {
      return '2FA code wasn’t entered in time. Try again.'
    }
  }

  let serverMessage = ''
  let authError = null
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!serverMessage) {
      const messageMatch = lines[i].match(/^\[!\]\s*server message:\s*(.+)$/i)
      if (messageMatch) serverMessage = cleanWrapperDiagnostic(messageMatch[1])
    }
    if (!authError) {
      const errorMatch = lines[i].match(
        /^\[!\]\s*auth error:\s*code=(-?\d+)(?:,\s*external=(-?\d+))?(?:,\s*status=(-?\d+))?,\s*message=(.*)$/i,
      )
      if (errorMatch) {
        authError = {
          code: Number(errorMatch[1]),
          external:
            errorMatch[2] != null && errorMatch[2] !== ''
              ? Number(errorMatch[2])
              : null,
          status:
            errorMatch[3] != null && errorMatch[3] !== ''
              ? Number(errorMatch[3])
              : null,
          message: cleanWrapperDiagnostic(errorMatch[4]),
        }
      }
    }
  }
  if (serverMessage || authError) {
    const details = []
    if (serverMessage) details.push(serverMessage)
    if (authError) {
      details.push(formatAuthErrorDetail(authError))
    }
    return `Apple sign-in failed: ${details.join(' — ')}`.slice(0, 480)
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    const m = l.match(/\[\.\]\s*response type\s+(\d+)/i)
    if (m) {
      const type = Number(m[1])
      if (Number.isFinite(type) && RESPONSE_TYPE_HINTS[type]) {
        return RESPONSE_TYPE_HINTS[type]
      }
      return `Apple sign-in failed (wrapper response type ${type}). Check the wrapper details in the failure log.`
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!/^__bionic_|^\[\+\] initializing|^\[\+\] starting/i.test(l)) {
      return `Sign-in failed: ${l.slice(0, 180)}`
    }
  }
  return null
}

export function buildFailureTail(collected) {
  return String(collected)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^__bionic_|^\[\+\]\s*starting|^\[\+\]\s*initializing/i.test(line),
    )
    .slice(-15)
}

export function redactWrapperOutput(text, email, password) {
  let redacted = String(text || '')
  if (email) redacted = redacted.replaceAll(email, '[redacted-email]')
  if (password) redacted = redacted.replaceAll(password, '[redacted-password]')
  return redacted
}
