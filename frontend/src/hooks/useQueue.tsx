import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { api, type Job } from '../api/client'
import { useEventStream } from './useEventStream'

type QueueContextValue = {
  jobs: Job[]
  active: Job[]
  recent: Job[]
  loading: boolean
}

const QueueContext = createContext<QueueContextValue | null>(null)

export function QueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Record<string, Job>>({})
  const [loading, setLoading] = useState(true)
  const requestIdRef = useRef(0)
  const wasOpenRef = useRef(false)

  const loadSnapshot = () => {
    const requestId = ++requestIdRef.current
    return api
      .queue()
      .then((r) => {
        if (requestId !== requestIdRef.current) return
        setJobs((prev) => {
          const next: Record<string, Job> = {}
          for (const j of r.jobs) next[j.id] = j
          return { ...next, ...prev }
        })
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false)
      })
  }

  useEffect(() => {
    void loadSnapshot()
    return () => {
      requestIdRef.current += 1
    }
  }, [])

  useEventStream(
    (type, data) => {
      if (type === 'job.created' || type === 'job.update') {
        setJobs((prev) => ({ ...prev, [data.id]: { ...prev[data.id], ...data } }))
      }
    },
    {
      onStatusChange: (s) => {
        if (s !== 'open') return
        if (wasOpenRef.current) void loadSnapshot()
        wasOpenRef.current = true
      },
    },
  )

  const value = useMemo<QueueContextValue>(() => {
    const list = Object.values(jobs).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    )
    return {
      jobs: list,
      active: list.filter((j) => j.status === 'queued' || j.status === 'running'),
      recent: list.filter((j) => j.status === 'done' || j.status === 'failed'),
      loading,
    }
  }, [jobs, loading])

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>
}

export function useQueue(): QueueContextValue {
  const ctx = useContext(QueueContext)
  if (!ctx) throw new Error('useQueue must be used within QueueProvider')
  return ctx
}
