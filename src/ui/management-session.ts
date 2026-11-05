import type { ManagerRequest } from '../manager/contract.js'

export interface ManagerStatus { online: boolean; authenticated: boolean; role?: string }
type Call = (request: ManagerRequest) => Promise<unknown>

/** Check the host session before loading the management overview. */
export async function restoreManagement(call: Call, address: string, accept: (status: ManagerStatus) => boolean): Promise<unknown> {
  const status = await call({ action: 'health', address }) as ManagerStatus
  if (!accept(status) || !status.authenticated) return undefined
  return call({ action: 'overview', address })
}
