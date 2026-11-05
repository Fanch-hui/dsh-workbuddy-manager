import { BRIDGE_PROVIDER, bridgeManagementURL, bridgeURL } from '../address.js'
import type { ManagerRequest } from '../manager/contract.js'
import { attachCredential, loadConnection, normalizeURL, sync, type Remote } from './connection.js'

export interface BridgeRemote extends Remote {
  workbuddy: { manage(request: ManagerRequest): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }> }
}

/** A dedicated provider preserves any existing gateway-key configuration. */
export async function connectBridge(remote: BridgeRemote, address: string, active: () => boolean): Promise<number | undefined> {
  const baseURL = bridgeURL(address)
  let connection = await loadConnection(remote, BRIDGE_PROVIDER)
  if (!active()) return undefined
  if (!connection.writable) throw new Error('当前 DSH 模型配置不可写。')
  if (connection.existing && (!bridgeManagementURL(connection.url) || !/^WORKBUDDY_MANAGER_BRIDGE_[A-F0-9]{32}$/.test(connection.keyRef))) {
    throw new Error('桥接提供方标识已被其他配置占用。')
  }
  const answer = await remote.workbuddy.manage({ action: 'bridge', address })
  if (!answer.ok) throw new Error(answer.error.message)
  const value = answer.value as { ref?: unknown }
  if (typeof value?.ref !== 'string' || !/^WORKBUDDY_MANAGER_BRIDGE_[A-F0-9]{32}$/.test(value.ref)) throw new Error('桥接凭据引用无效。')
  if (!active()) return undefined
  if (!connection.existing || connection.keyRef !== value.ref || normalizeURL(connection.url) !== baseURL) {
    connection = await attachCredential(remote, connection, baseURL, value.ref)
  }
  if (!active()) return undefined
  return sync(remote, connection, baseURL, '')
}
