import type { WorkbuddyManagerClient } from './client.js'

export interface SnapshotPart {
  ok: boolean
  data?: unknown
  error?: string
}

/** One failing endpoint must not hide the rest of the snapshot. */
export async function snapshot(client: WorkbuddyManagerClient): Promise<Record<string, SnapshotPart>> {
  const [health, models, usage] = await Promise.allSettled([
    client.health(), client.models(), client.usage(),
  ])
  return {
    health: settle(health),
    models: settle(models),
    usage: settle(usage),
  }
}

function settle(result: PromiseSettledResult<unknown>): SnapshotPart {
  return result.status === 'fulfilled'
    ? { ok: true, data: result.value }
    : { ok: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
}
