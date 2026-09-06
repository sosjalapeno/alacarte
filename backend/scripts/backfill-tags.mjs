// One-off CLI entry for the tag backfill (the Settings page drives the same
// engine over HTTP):
//   podman exec alacarte-web node scripts/backfill-tags.mjs [--dry-run]
import { onEvent } from '../lib/eventBus.mjs'

const { startTagBackfill, getTagBackfillStatus } = await import(
    '../lib/tagBackfill.mjs'
)

const dryRun = process.argv.includes('--dry-run')

onEvent((evt) => {
    if (evt.type !== 'tags.backfill.progress') return
    const s = evt.data || {}
    const counts = `scanned ${s.scanned}/${s.total} · stamped ${s.stamped} · skipped ${s.skipped} · unmatched ${s.noMatch} · failed ${s.failed}`
    if (s.done) {
        console.log(`done${s.dryRun ? ' (dry run)' : ''}: ${counts}`)
        if (s.error) console.error(`error: ${s.error}`)
    } else {
        console.log(`${counts}${s.current ? ` · ${s.current}` : ''}`)
    }
})

await startTagBackfill({ dryRun })

await new Promise((resolve) => {
    const timer = setInterval(() => {
        if (!getTagBackfillStatus().running) {
            clearInterval(timer)
            resolve()
        }
    }, 500)
})
