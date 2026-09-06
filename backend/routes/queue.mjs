import express from 'express'

import { listJobs, listHistory } from '../lib/queue.mjs'

export const queueRouter = express.Router()

queueRouter.get('/', (_req, res) => {
  res.json({ jobs: listJobs() })
})

queueRouter.get('/history', (req, res) => {
  res.json({ jobs: listHistory(req.query?.limit) })
})
