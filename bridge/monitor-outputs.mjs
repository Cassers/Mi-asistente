import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)

/** niri also lists disabled/disconnected outputs. Never select one of those. */
export function selectOutputs(all) {
  const active = Object.entries(all).filter(([, value]) => value.logical && value.current_mode != null)
  const main = active.find(([, value]) => /ultragear/i.test(value.model || '')) ||
    active.find(([, value]) => value.logical.width === 1920) || active[0]
  return { principal: main?.[0], secundario: active.find(([name]) => name !== main?.[0])?.[0] }
}

export async function monitorOutputs() {
  const { stdout } = await run('niri', ['msg', '-j', 'outputs'], { timeout: 3000 })
  return selectOutputs(JSON.parse(stdout))
}
