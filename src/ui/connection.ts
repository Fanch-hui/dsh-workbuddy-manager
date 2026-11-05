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
  }
  llm: {
    discoverModels(ns: string, request: { provider?: string; baseURL: string; api: string; apiKey?: string }): Promise<RemoteResult<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; inputModalities?: string[] }>>>
  }
}
export interface Connection {
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

/** URLs never carry credentials; plaintext is restricted to the local machine. */
export function normalizeURL(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('请输入有效的网关地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('地址必须是 HTTP(S) 地址，不能包含账号、密码、查询参数或片段。')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'http:' && !loopback) throw new Error('非本机网关请使用 HTTPS 地址。')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  return url.toString().replace(/\/$/, '')
}

export function managementURL(input: string): string {
  return normalizeURL(input).replace(/\/v1$/, '')
}

function modelsOf(value: unknown): Model[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Model => typeof item === 'object' && item !== null && typeof item.id === 'string')
}

export async function loadConnection(remote: Remote): Promise<Connection> {
  const settings = result(await remote.settings.describe())
  const namespace = settings.namespaces.find(item => item.ns === NAMESPACE)
  if (!namespace) throw new Error('找不到 DSH 的模型适配器，请检查 llm-pi-ai 是否启用。')
  const raw = record(record(namespace.value.providers)[PROVIDER])
  const existing = Object.keys(raw).length > 0
  const keyRef = typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv ? raw.apiKeyEnv : CREDENTIAL_REF
  const credential = result(await remote.credentials.describe([keyRef]))[keyRef]
  return {
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
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error('密钥不能包含空格、换行或非 ASCII 字符。')
  if (!key && (!connection.existing || !connection.keyConfigured)) throw new Error('请输入 WorkBuddy Manager 创建的网关密钥。')
  const request = {
    ...(connection.existing ? { provider: PROVIDER } : {}),
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

/** Update only this provider's fields, with the revision captured at load time. */
export async function sync(remote: Remote, connection: Connection, address: string, key: string): Promise<number> {
  const baseURL = normalizeURL(address)
  if (!connection.writable) throw new Error('当前 DSH 配置不可写。')
  if (key && !connection.keyWritable) throw new Error('当前凭据存储不可写。')
  const discovered = await discover(remote, connection, baseURL, key)
  const models = mergeModels(connection.models, discovered)
  const fields: Dictionary = { baseURL, api: 'openai-responses', apiKeyEnv: connection.keyRef, models }
  const operations: Array<{ op: 'set'; path: string[]; value: unknown }> = connection.existing
    ? Object.entries(fields).map(([field, value]) => ({ op: 'set', path: ['providers', PROVIDER, field], value }))
    : [{ op: 'set', path: ['providers', PROVIDER], value: { displayName: 'WorkBuddy Manager', ...fields } }]
  const updated = await remote.settings.mutate(NAMESPACE, operations, connection.revision)
  if (!updated.ok) throw new Error(updated.error.code === 'settings/conflict' ? '模型配置已被修改，请重新载入后再试。' : updated.error.message)
  if (key) {
    try {
      result(await remote.credentials.set(connection.keyRef, key))
    } catch (error) {
      throw new Error(`模型配置已更新，但密钥保存失败：${safeMessage(error, key)}`)
    }
  }
  return models.length
}

export function safeMessage(error: unknown, key: string): string {
  const message = error instanceof Error ? error.message : '操作失败，请重试。'
  return key ? message.split(key).join('[已隐藏]') : message
}
