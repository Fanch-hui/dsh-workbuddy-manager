import { normalizeURL } from '../address.js'
export { normalizeURL, managementURL } from '../address.js'

export const PROVIDER = 'workbuddy-manager'
export const CREDENTIAL_REF = 'WORKBUDDY_MANAGER_API_KEY'
export const DEFAULT_URL = 'http://127.0.0.1:7864/v1'
const NAMESPACE = 'llm-pi-ai'

type Dictionary = Record<string, unknown>
type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }
interface NamespaceView { ns: string; value: Dictionary; revision: unknown }
export interface Model { id: string; name?: string; contextWindow?: number; maxTokens?: number; input?: string[] }
export interface Remote {
  settings: {
    describe(): Promise<RemoteResult<{ writable: boolean; namespaces: NamespaceView[] }>>
    mutate(ns: string, operations: Array<{ op: 'set'; path: string[]; value: unknown }>, revision: unknown): Promise<RemoteResult<NamespaceView>>
  }
  credentials: {
    describe(refs: string[]): Promise<RemoteResult<Record<string, { configured: boolean; writable: boolean }>>>
    set(ref: string, value: string): Promise<RemoteResult<unknown>>
    unset(ref: string): Promise<RemoteResult<unknown>>
  }
  llm: {
    discoverModels(ns: string, request: { provider?: string; baseURL: string; api: string; apiKey?: string }): Promise<RemoteResult<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; inputModalities?: string[] }>>>
  }
}
export interface Connection {
  providerId: string
  candidates: Array<{ id: string; label: string }>
  url: string
  keyRef: string
  keyConfigured: boolean
  keyWritable: boolean
  writable: boolean
  existing: boolean
  models: Model[]
  revision: unknown
}

function record(value: unknown): Dictionary {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Dictionary : {}
}

function result<T>(answer: RemoteResult<T>): T {
  if (!answer.ok) throw new Error(answer.error.message)
  return answer.value
}

function modelsOf(value: unknown): Model[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Model => typeof item === 'object' && item !== null && typeof item.id === 'string')
}

/** Plugin-owned references and explicit names identify a WorkBuddy provider on any host and port. */
function isWorkbuddyProvider(value: unknown): boolean {
  const provider = record(value)
  if (provider.api !== 'openai-responses' || typeof provider.baseURL !== 'string') return false
  const keyRef = provider.apiKeyEnv
  if (typeof keyRef === 'string' && /^WORKBUDDY_MANAGER(?:_KEY_[A-F0-9]{32}|_API_KEY)$/.test(keyRef)) return true
  if (typeof provider.displayName === 'string' && /workbuddy/i.test(provider.displayName)) return true
  try {
    const url = new URL(normalizeURL(provider.baseURL))
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && url.port === '7864' && url.pathname.endsWith('/v1')
  } catch { return false }
}

export async function loadConnection(remote: Remote, selectedId?: string): Promise<Connection> {
  const settings = result(await remote.settings.describe())
  const namespace = settings.namespaces.find(item => item.ns === NAMESPACE)
  if (!namespace) throw new Error('找不到 DSH 的模型适配器，请检查 llm-pi-ai 是否启用。')
  const providers = record(namespace.value.providers)
  const candidates = Object.entries(providers)
    .filter(([id, value]) => id === PROVIDER || isWorkbuddyProvider(value))
    .map(([id, value]) => ({ id, label: typeof record(value).displayName === 'string' ? `${record(value).displayName} (${id})` : id }))
  if (selectedId && !candidates.some(candidate => candidate.id === selectedId)) throw new Error('所选提供方已不存在，请重新载入。')
  let providerId = selectedId ?? ''
  if (!providerId && candidates.some(candidate => candidate.id === PROVIDER)) providerId = PROVIDER
  if (!providerId && candidates.length === 1) providerId = candidates[0].id
  if (!providerId && candidates.length === 0) providerId = PROVIDER
  const raw = record(providers[providerId])
  const existing = Object.keys(raw).length > 0
  const keyRef = typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv ? raw.apiKeyEnv : CREDENTIAL_REF
  const credential = result(await remote.credentials.describe([keyRef]))[keyRef]
  return {
    providerId,
    candidates,
    url: typeof raw.baseURL === 'string' ? raw.baseURL : DEFAULT_URL,
    keyRef,
    keyConfigured: credential?.configured === true,
    keyWritable: credential?.writable === true,
    writable: settings.writable,
    existing,
    models: modelsOf(raw.models),
    revision: namespace.revision,
  }
}

/** Ask the host's official pi-ai discovery endpoint; a typed key is one-shot. */
export async function discover(remote: Remote, connection: Connection, address: string, key: string): Promise<Model[]> {
  const baseURL = normalizeURL(address)
  if (!connection.providerId) throw new Error('请先选择已有的 WorkBuddy 提供方。')
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error('密钥不能包含空格、换行或非 ASCII 字符。')
  if (!key && (!connection.existing || !connection.keyConfigured)) throw new Error('请输入 WorkBuddy Manager 创建的网关密钥。')
  const request = {
    ...(connection.existing ? { provider: connection.providerId } : {}),
    baseURL,
    api: 'openai-responses',
    ...(key ? { apiKey: key } : {}),
  }
  let found: Awaited<ReturnType<Remote['llm']['discoverModels']>>
  try {
    found = await remote.llm.discoverModels(NAMESPACE, request)
    if (!found.ok) throw new Error(found.error.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : '连接失败。'
    throw new Error(key ? message.split(key).join('[已隐藏]') : message)
  }
  const models = found.value.filter(item => typeof item.id === 'string' && item.id.length > 0).map(item => ({
    id: item.id,
    ...(item.name ? { name: item.name } : {}),
    ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
    ...(item.maxTokens ? { maxTokens: item.maxTokens } : {}),
    ...(item.inputModalities?.length ? { input: item.inputModalities } : {}),
  }))
  if (models.length === 0) throw new Error('网关没有返回可用模型，请检查账号及密钥的模型权限。')
  const unique = new Map<string, Model>()
  for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model)
  return [...unique.values()]
}

/** Preserve existing model settings; append newly advertised models. */
export function mergeModels(current: Model[], discovered: Model[]): Model[] {
  const models = new Map(current.map(model => [model.id, model]))
  for (const model of discovered) {
    if (!models.has(model.id)) models.set(model.id, model)
  }
  return [...models.values()]
}

function newProvider(fields: Dictionary): Dictionary {
  return {
    displayName: 'WorkBuddy Manager', ...fields,
    compat: { supportsMaxOutputTokens: false },
    defaultContextWindow: 131072, defaultMaxTokens: 32768,
  }
}

/** Bind a separately stored key without changing any other credential reference. */
export async function attachCredential(remote: Remote, connection: Connection, address: string, ref: string): Promise<Connection> {
  const baseURL = normalizeURL(address)
  if (!connection.providerId) throw new Error('请先选择已有的 WorkBuddy 提供方。')
  if (!connection.writable) throw new Error('当前 DSH 配置不可写。')
  const path = connection.existing ? ['providers', connection.providerId, 'apiKeyEnv'] : ['providers', connection.providerId]
  const value = connection.existing ? ref : newProvider({ baseURL, api: 'openai-responses', apiKeyEnv: ref, models: [] })
  const updated = await remote.settings.mutate(NAMESPACE, [{ op: 'set', path, value }], connection.revision)
  if (!updated.ok) throw new Error(updated.error.code === 'settings/conflict' ? '模型配置已被修改，请重新载入后再试。' : updated.error.message)
  return loadConnection(remote, connection.providerId)
}

export function newCredentialRef(): string {
  return `WORKBUDDY_MANAGER_KEY_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`
}

/** Update only this provider's fields, with the revision captured at load time. */
export async function sync(remote: Remote, connection: Connection, address: string, key: string): Promise<number> {
  const baseURL = normalizeURL(address)
  if (!connection.providerId) throw new Error('请先选择已有的 WorkBuddy 提供方。')
  if (!connection.writable) throw new Error('当前 DSH 配置不可写。')
  if (key && !connection.keyWritable) throw new Error('当前凭据存储不可写。')
  let current = connection
  if (!key && !current.existing && current.keyConfigured) {
    const value = newProvider({ baseURL, api: 'openai-responses', apiKeyEnv: current.keyRef, models: [] })
    const restored = await remote.settings.mutate(NAMESPACE, [{ op: 'set', path: ['providers', current.providerId], value }], current.revision)
    if (!restored.ok) throw new Error(restored.error.code === 'settings/conflict' ? '模型配置已被修改，请重新载入后再试。' : restored.error.message)
    current = await loadConnection(remote, current.providerId)
  }
  let discovered: Model[]
  try { discovered = await discover(remote, current, baseURL, key) }
  catch (error) {
    if (current !== connection) throw new Error(`连接配置已恢复，但模型同步失败：${safeMessage(error, key)}`)
    throw error
  }
  let keyRef = current.keyRef
  if (key) {
    keyRef = newCredentialRef()
    const status = result(await remote.credentials.describe([keyRef]))[keyRef]
    if (!status?.writable || status.configured) throw new Error('新凭据引用不可写或已被占用。')
  }
  const models = mergeModels(current.models, discovered)
  const fields: Dictionary = { baseURL, api: 'openai-responses', apiKeyEnv: keyRef, models }
  const operations: Array<{ op: 'set'; path: string[]; value: unknown }> = current.existing
    ? Object.entries(fields).map(([field, value]) => ({ op: 'set', path: ['providers', current.providerId, field], value }))
    : [{ op: 'set', path: ['providers', current.providerId], value: newProvider(fields) }]
  if (key) {
    try { result(await remote.credentials.set(keyRef, key)) }
    catch (error) {
      throw new Error(`密钥保存失败，模型配置未改动：${safeMessage(error, key)}${await discardUnusedCredential(remote, keyRef)}`)
    }
  }
  const updated = await remote.settings.mutate(NAMESPACE, operations, current.revision)
  if (!updated.ok) {
    const reason = updated.error.code === 'settings/conflict' ? '模型配置已被修改，请重新载入后再试。' : updated.error.message
    const hint = key ? await discardUnusedCredential(remote, keyRef) : ''
    throw new Error(`${reason}${hint}`)
  }
  return models.length
}

/** Remove a credential written for a change that did not take effect; report a failed cleanup to the user. */
export async function discardUnusedCredential(remote: Remote, ref: string): Promise<string> {
  try {
    const answer = await remote.credentials.unset(ref)
    if (answer.ok) return ''
    return `；未使用的密钥清理失败：${answer.error.message}`
  } catch (error) {
    return `；未使用的密钥清理失败：${safeMessage(error, '')}`
  }
}

export function safeMessage(error: unknown, key: string): string {
  const message = error instanceof Error ? error.message : '操作失败，请重试。'
  return key ? message.split(key).join('[已隐藏]') : message
}
