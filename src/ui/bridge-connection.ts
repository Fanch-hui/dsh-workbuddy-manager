import { BRIDGE_PROVIDER } from '../address.js'
import type { ManagerRequest } from '../manager/contract.js'
import { attachCredential, loadConnection, normalizeURL, sync, type Model, type Remote } from './connection.js'

export interface BridgeRemote extends Remote {
  workbuddy: { manage(request: ManagerRequest): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }> }
}

/** Connects the in-host local gateway provider to llm-pi-ai without touching other providers. */
export async function connectBridge(remote: BridgeRemote, active: () => boolean = () => true): Promise<number | undefined> {
  let connection = await loadConnection(remote, BRIDGE_PROVIDER)
  if (!active()) return undefined
  if (!connection.writable) throw new Error('当前 DSH 模型配置不可写。')
  if (connection.existing && !/^WORKBUDDY_MANAGER_BRIDGE_[A-F0-9]{32}$/.test(connection.keyRef)) {
    throw new Error('桥接提供方标识已被其他配置占用。')
  }
  const answer = await remote.workbuddy.manage({ action: 'bridge' })
  if (!answer.ok) throw new Error(answer.error.message)
  const value = answer.value as { url?: unknown; ref?: unknown; models?: unknown }
  if (typeof value?.url !== 'string' || typeof value?.ref !== 'string' || !/^WORKBUDDY_MANAGER_BRIDGE_[A-F0-9]{32}$/.test(value.ref)) {
    throw new Error('本地网关返回的配置无效。')
  }
  const seedModels = Array.isArray(value.models)
    ? (value.models as Model[]).filter(m => m && typeof m.id === 'string' && m.id.length > 0)
    : undefined
  const baseURL = normalizeURL(value.url)
  if (!active()) return undefined
  if (!connection.existing || connection.models.length === 0 || connection.keyRef !== value.ref || normalizeURL(connection.url) !== baseURL || connection.api !== 'openai-completions') {
    connection = await attachCredential(remote, connection, baseURL, value.ref, seedModels)
  }
  if (!active()) return undefined
  return sync(remote, connection, baseURL, '')
}
