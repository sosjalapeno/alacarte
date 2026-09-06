import { useState } from 'react'
import { CheckCircle2, AlertCircle, Loader2, XCircle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

import { api } from '../api/client'
import { useQueue } from '../hooks/useQueue'
import { QueueItem } from '../components/QueueItem'
import { Card } from '../components/Card'
import { StaggeredList, StaggeredItem } from '../components/StaggeredList'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'

function SkeletonCard() {
  return (
    <Card className="flex items-center gap-3 p-3">
      <motion.div
        className="h-10 w-10 rounded-lg bg-white/10"
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="flex-1 min-w-0">
        <motion.div
          className="h-4 bg-white/10 rounded w-2/3 mb-2"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
        />
        <motion.div
          className="h-3 bg-white/10 rounded w-1/2"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
        />
      </div>
    </Card>
  )
}

export function HomePage() {
  const { active, recent, loading } = useQueue()
  const recentList = recent.slice(0, 50)
  const [confirmAbortAll, setConfirmAbortAll] = useState(false)
  const [abortingAll, setAbortingAll] = useState(false)

  return (
    <div className="mx-auto w-full max-w-6xl pt-4 md:pt-6 space-y-8">
      <section>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          Good listening
        </h1>
      </section>

      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="space-y-8"
          >
            <section>
              <div className="mb-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Loader2 className="h-4 w-4 text-accent" /> Active
                </h2>
              </div>
              <div className="flex flex-col gap-2">
                <SkeletonCard />
              </div>
            </section>
            <section>
              <div className="mb-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Recently imported
                </h2>
              </div>
              <div className="flex flex-col gap-2">
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </div>
            </section>
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-8"
          >
            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Loader2 className="h-4 w-4 text-accent" /> Active
                </h2>
                {active.length > 0 && (
                  <Button
                    onClick={() => setConfirmAbortAll(true)}
                    className="border-rose-400/35 bg-rose-500/[0.18] text-rose-300 hover:border-rose-400/50 hover:bg-rose-500/[0.28] hover:text-rose-200"
                  >
                    <XCircle className="h-4 w-4" />
                    Abort all
                  </Button>
                )}
              </div>
              {active.length === 0 ? (
                <Card className="p-6 text-sm text-white/55">
                  Nothing downloading right now.
                </Card>
              ) : (
                <StaggeredList className="flex flex-col gap-2">
                  {active.map((j) => (
                    <StaggeredItem key={j.id}>
                      <QueueItem job={j} />
                    </StaggeredItem>
                  ))}
                </StaggeredList>
              )}
            </section>

            <section>
              <div className="mb-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Recently imported
                </h2>
              </div>
              {recentList.length === 0 ? (
                <Card className="flex items-center gap-2 p-6 text-sm text-white/55">
                  <AlertCircle className="h-4 w-4" />
                  No completed downloads yet.
                </Card>
              ) : (
                <StaggeredList className="flex flex-col gap-2">
                  {recentList.map((j) => (
                    <StaggeredItem key={j.id}>
                      <QueueItem job={j} />
                    </StaggeredItem>
                  ))}
                </StaggeredList>
              )}
            </section>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={confirmAbortAll}
        onClose={() => {
          if (!abortingAll) setConfirmAbortAll(false)
        }}
        className="max-w-md p-6"
        label="Confirm abort all"
        placement="center"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge variant="bad">
              <XCircle className="h-3.5 w-3.5" />
              Abort downloads
            </Badge>
          </div>
          <h3 className="text-lg font-semibold leading-tight">
            Abort {active.length} active download{active.length === 1 ? '' : 's'}?
          </h3>
          <p className="text-sm text-white/60">
            This cancels every queued and running download. Completed history is kept.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmAbortAll(false)} disabled={abortingAll}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                setAbortingAll(true)
                try {
                  await api.cancelAll()
                  setConfirmAbortAll(false)
                } finally {
                  setAbortingAll(false)
                }
              }}
              disabled={abortingAll || active.length === 0}
              className="border-rose-400/35 bg-rose-500/[0.18] text-rose-300 hover:border-rose-400/50 hover:bg-rose-500/[0.28] hover:text-rose-200"
            >
              {abortingAll ? 'Aborting…' : 'Abort all'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
