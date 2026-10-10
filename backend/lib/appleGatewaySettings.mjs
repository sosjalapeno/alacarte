import { appleGateway } from './appleGateway.mjs'
import { readSettings } from './settingsStore.mjs'

// Pushes the pacing settings into the running gateway. At boot the pace the gateway
// has adapted to is kept; when the user saves new values the starting gap applies at once.
export async function applyAppleGatewaySettings({ resetPace = true } = {}) {
  const s = await readSettings()
  appleGateway.configure(
    {
      intervalMs: s.appleGatewayIntervalMs,
      minIntervalMs: s.appleGatewayMinIntervalMs,
      adaptive: s.appleGatewayAdaptive,
      cooldownMinutes: s.appleGatewayCooldownMinutes,
    },
    { resetPace },
  )
}
