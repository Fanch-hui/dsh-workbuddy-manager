import type { Context } from '@deepseek-ai/cordis'
import { ManagerRemote } from './manager/service.js'

export { WorkbuddyError, WorkbuddyManagerClient } from './client.js'
export { ManagerRemote } from './manager/service.js'
export type { AuthKind } from './client.js'

/** Mount the private management Remote for the desktop settings page. */
export function apply(ctx: Context): void {
  ctx.plugin(ManagerRemote)
}
