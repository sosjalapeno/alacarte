import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useAnimationControls } from 'framer-motion'
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react'

import { Button } from './Button'
import { Input } from './Input'
import { api, HttpError, setSetupToken } from '../api/client'
import { cx } from '../lib/cx'

type Mode = 'login' | 'setup'
type HintTone = 'dim' | 'warn' | 'error'

const TONE_COLOR: Record<HintTone, string> = {
  dim: 'text-white/45',
  warn: 'text-amber-300/85',
  error: 'text-rose-300',
}

type Props = {
  mode: Mode
  minPasswordLength: number
  usernameMinLength: number
  usernameMaxLength: number
  requiresSetupToken?: boolean
  onAuthenticated: () => void
}

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/

export function AuthScreen({
  mode,
  minPasswordLength,
  usernameMinLength,
  usernameMaxLength,
  requiresSetupToken = false,
  onAuthenticated,
}: Props) {
  const [setupTokenInput, setSetupTokenInput] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shakeControls = useAnimationControls()
  const usernameRef = useRef<HTMLInputElement | null>(null)
  const passwordRef = useRef<HTMLInputElement | null>(null)
  const setupTokenRef = useRef<HTMLInputElement | null>(null)
  const setupTokenId = useId()
  const usernameId = useId()
  const passwordId = useId()
  const confirmId = useId()

  useEffect(() => {
    if (mode === 'setup' && requiresSetupToken) {
      setupTokenRef.current?.focus()
      return
    }
    usernameRef.current?.focus()
  }, [mode, requiresSetupToken])

  const isSetup = mode === 'setup'
  const trimmedUser = username.trim()
  const usernameLengthBad =
    trimmedUser.length > 0 &&
    (trimmedUser.length < usernameMinLength || trimmedUser.length > usernameMaxLength)
  const usernameCharsBad =
    trimmedUser.length > 0 && !usernameLengthBad && !USERNAME_PATTERN.test(trimmedUser)
  const usernameValid =
    trimmedUser.length >= usernameMinLength &&
    trimmedUser.length <= usernameMaxLength &&
    USERNAME_PATTERN.test(trimmedUser)
  const usernameInvalid = isSetup && (usernameLengthBad || usernameCharsBad)
  const tooShort = isSetup && password.length > 0 && password.length < minPasswordLength
  const mismatch = isSetup && confirm.length > 0 && confirm !== password
  const setupTokenRequired = isSetup && requiresSetupToken
  const setupTokenMissing = setupTokenRequired && setupTokenInput.trim().length === 0
  const canSubmit = isSetup
    ? (!setupTokenRequired || !setupTokenMissing) &&
      usernameValid &&
      password.length >= minPasswordLength &&
      confirm === password &&
      !submitting
    : trimmedUser.length > 0 && password.length > 0 && !submitting

  const hint: { tone: HintTone; text: string } | null = error
    ? { tone: 'error', text: error }
    : isSetup && usernameLengthBad
      ? {
          tone: 'warn',
          text: `Username must be ${usernameMinLength}–${usernameMaxLength} characters.`,
        }
      : isSetup && usernameCharsBad
        ? {
            tone: 'warn',
            text: 'Username can use letters, digits, dots, underscores, and hyphens.',
          }
        : isSetup && tooShort
          ? { tone: 'warn', text: `Password: at least ${minPasswordLength} characters.` }
          : setupTokenMissing
            ? { tone: 'warn', text: 'Setup token is required for first-time setup.' }
          : isSetup && mismatch
            ? { tone: 'warn', text: 'Passwords don’t match.' }
            : isSetup && password.length === 0
              ? {
                  tone: 'dim',
                  text: `Pick a username and a password (min ${minPasswordLength} chars).`,
                }
              : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)
    setSubmitting(true)
    try {
      if (isSetup) {
        setSetupToken(setupTokenInput.trim() || null)
        await api.authSetup(trimmedUser, password)
        setSetupToken(null)
      } else {
        await api.authLogin(trimmedUser, password)
      }
      onAuthenticated()
    } catch (err) {
      let message =
        err instanceof HttpError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Something went wrong'
      if (err instanceof HttpError && err.status === 429) {
        if (typeof err.lockedUntil === 'number') {
          message = `Too many attempts. Locked until ${new Date(err.lockedUntil).toLocaleTimeString()}.`
        } else if (typeof err.retryAfter === 'number') {
          message = `Too many attempts. Retry in ${Math.max(1, Math.ceil(err.retryAfter))}s.`
        } else {
          message = 'Too many attempts. Please wait and try again.'
        }
      }
      setError(message)
      shakeControls.start({
        x: [0, -10, 10, -8, 8, -4, 4, 0],
        transition: { duration: 0.5, ease: 'easeOut' },
      })
      setSubmitting(false)
      if (isSetup) {
        setSetupToken(null)
      }
    }
  }

  return (
    <motion.div
      key={mode}
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -15 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="min-h-dvh w-full flex items-center justify-center px-4 py-10"
    >
      <div className="w-full max-w-[26rem]">
        <motion.div
          layout
          transition={{ layout: { type: 'spring', stiffness: 380, damping: 32 } }}
          className="overflow-hidden rounded-app border border-white/[0.08] bg-white/[0.04] backdrop-blur-md shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]"
        >
        <motion.div animate={shakeControls} className="p-8">
          <div className="flex flex-col items-center gap-3 mb-7">
            <motion.div
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
              className="h-14 w-14 rounded-2xl bg-[rgba(var(--accent),0.12)] border border-[rgba(var(--accent),0.25)] flex items-center justify-center text-[rgb(var(--accent))]"
              aria-hidden
            >
              {isSetup ? <ShieldCheck size={26} strokeWidth={2} /> : <Lock size={24} strokeWidth={2} />}
            </motion.div>
            <div className="text-center">
              <h1 className="text-xl font-semibold tracking-tight text-white">
                {isSetup ? 'Create your account' : 'Welcome back'}
              </h1>
              <p className="text-sm text-white/55 mt-1">
                {isSetup
                  ? 'Pick a username and password.'
                  : 'Sign in to continue.'}
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {isSetup && requiresSetupToken && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={setupTokenId} className="text-xs uppercase tracking-wide text-white/45 ml-1">
                  Setup token from server logs
                </label>
                <Input
                  id={setupTokenId}
                  ref={setupTokenRef}
                  type="text"
                  value={setupTokenInput}
                  onChange={(e) => {
                    setSetupTokenInput(e.target.value)
                    if (error) setError(null)
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  disabled={submitting}
                  className={cx(
                    setupTokenMissing &&
                      'border-rose-400/50 focus:border-rose-400/70 focus:shadow-[0_0_0_3px_rgba(244,63,94,0.18)]',
                  )}
                />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor={usernameId} className="text-xs uppercase tracking-wide text-white/45 ml-1">
                Username
              </label>
              <Input
                id={usernameId}
                ref={usernameRef}
                type="text"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value)
                  if (error) setError(null)
                }}
                autoComplete="username"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                disabled={submitting}
                className={cx(
                  (usernameInvalid || (!isSetup && !!error)) &&
                    'border-rose-400/50 focus:border-rose-400/70 focus:shadow-[0_0_0_3px_rgba(244,63,94,0.18)]',
                )}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={passwordId} className="text-xs uppercase tracking-wide text-white/45 ml-1">
                Password
              </label>
              <PasswordField
                id={passwordId}
                ref={passwordRef}
                value={password}
                onChange={(v) => {
                  setPassword(v)
                  if (error) setError(null)
                }}
                show={showPassword}
                toggleShow={() => setShowPassword((s) => !s)}
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                disabled={submitting}
                hasError={!isSetup && !!error}
              />
            </div>

            {isSetup && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={confirmId} className="text-xs uppercase tracking-wide text-white/45 ml-1">
                  Confirm password
                </label>
                <PasswordField
                  id={confirmId}
                  value={confirm}
                  onChange={setConfirm}
                  show={showConfirm}
                  toggleShow={() => setShowConfirm((s) => !s)}
                  autoComplete="new-password"
                  disabled={submitting}
                  hasError={mismatch}
                />
              </div>
            )}

            <AnimatePresence initial={false}>
              {hint && (
                <motion.div
                  key="hint-slot"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className={cx('pt-1 text-xs ml-1', TONE_COLOR[hint.tone])}>
                    {hint.text}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <Button
              type="submit"
              className={cx(
                'mt-2 justify-center bg-[rgba(var(--accent),0.18)] border-[rgba(var(--accent),0.4)] text-white hover:bg-[rgba(var(--accent),0.28)] hover:text-white',
                !canSubmit && 'opacity-50 cursor-not-allowed pointer-events-none',
              )}
              disabled={!canSubmit}
            >
              {submitting
                ? isSetup
                  ? 'Creating account…'
                  : 'Signing in…'
                : isSetup
                  ? 'Create account'
                  : 'Sign in'}
            </Button>
          </form>
        </motion.div>
        </motion.div>

        <p className="mt-5 text-center text-xs text-white/35">
          {isSetup ? (
            'You can change this later from Settings → Account.'
          ) : (
            <>
              ALACarte ·{' '}
              <a
                href="https://github.com/sosjalapeno/ALACarte/blob/main/README.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/55 underline decoration-white/35 underline-offset-2 hover:text-white"
              >
                README
              </a>
            </>
          )}
        </p>
      </div>
    </motion.div>
  )
}

type PasswordFieldProps = {
  id: string
  value: string
  onChange: (v: string) => void
  show: boolean
  toggleShow: () => void
  autoComplete: string
  disabled?: boolean
  hasError?: boolean
}

const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  ({ id, value, onChange, show, toggleShow, autoComplete, disabled, hasError }, ref) => (
    <div className="relative">
      <Input
        id={id}
        ref={ref}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        disabled={disabled}
        className={cx(
          'pr-12',
          hasError &&
            'border-rose-400/50 focus:border-rose-400/70 focus:shadow-[0_0_0_3px_rgba(244,63,94,0.18)]',
        )}
      />
      <button
        type="button"
        onClick={toggleShow}
        tabIndex={-1}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-white/45 hover:text-white/80 transition-colors"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={show ? 'on' : 'off'}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="block"
          >
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </motion.span>
        </AnimatePresence>
      </button>
    </div>
  ),
)
PasswordField.displayName = 'PasswordField'

