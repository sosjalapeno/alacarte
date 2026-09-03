import { useEffect, useRef, type MutableRefObject } from 'react'

type Handler = (type: string, data: any) => void
export type EventStreamStatus = 'connecting' | 'open' | 'reconnecting'

type Options = {
  onStatusChange?: (status: EventStreamStatus) => void
}

type Subscriber = {
  handler: MutableRefObject<Handler>
  options: MutableRefObject<Options | undefined>
}

const EVENT_TYPES = [
  'job.created',
  'job.update',
  'job.log',
  'wrapper.login',
  'wrapper.login.log',
] as const

// One shared EventSource per tab: browsers allow ~6 connections per host,
// so a stream per component starves every other fetch to the backend.
const subscribers = new Set<Subscriber>()
let source: EventSource | null = null
let status: EventStreamStatus = 'connecting'
let backoff = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let visibilityBound = false

function setStatus(next: EventStreamStatus) {
  status = next
  for (const sub of subscribers) {
    try {
      sub.options.current?.onStatusChange?.(next)
    } catch {}
  }
}

function dispatch(type: string, raw: unknown) {
  let data: unknown
  try {
    data = JSON.parse(String(raw))
  } catch {
    return
  }
  for (const sub of subscribers) {
    try {
      sub.handler.current(type, data)
    } catch {}
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function connect() {
  if (source || subscribers.size === 0) return
  clearReconnectTimer()
  setStatus(backoff > 1000 ? 'reconnecting' : 'connecting')

  const es = new EventSource('/api/events')
  source = es
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (e) => {
      if (source !== es) return
      dispatch(type, (e as MessageEvent).data)
    })
  }
  es.onopen = () => {
    if (source !== es) return
    backoff = 1000
    setStatus('open')
  }
  es.onerror = () => {
    if (source !== es) return
    es.close()
    source = null
    if (subscribers.size === 0) return
    setStatus('reconnecting')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    backoff = Math.min(backoff * 2, 30_000)
  }
}

function disconnect() {
  clearReconnectTimer()
  source?.close()
  source = null
  backoff = 1000
}

function handleVisibility() {
  if (document.visibilityState === 'visible' && !source && subscribers.size > 0) {
    connect()
  }
}

function subscribe(sub: Subscriber): () => void {
  subscribers.add(sub)
  if (!visibilityBound) {
    document.addEventListener('visibilitychange', handleVisibility)
    visibilityBound = true
  }
  if (source) {
    try {
      sub.options.current?.onStatusChange?.(status)
    } catch {}
  } else {
    connect()
  }
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0) disconnect()
  }
}

export function useEventStream(handler: Handler, options?: Options) {
  const handlerRef = useRef(handler)
  const optionsRef = useRef(options)
  handlerRef.current = handler
  optionsRef.current = options

  useEffect(() => subscribe({ handler: handlerRef, options: optionsRef }), [])
}
