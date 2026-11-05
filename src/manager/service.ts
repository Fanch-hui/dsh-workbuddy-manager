import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import { managementURL } from '../address.js'
import { managerRequest, type ManagerRequest } from './contract.js'
import { SessionStore, validSession, type SessionCredentials } from './session-store.js'

type Dict = Record<string, unknown>
type CredentialSink = { describe(ref: string): Promise<{ configured: boolean; writable: boolean }>; set(ref: string, value: string): Promise<void> }
const MAX_REPLY = 2 * 1024 * 1024

function object(value: unknown): Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Dict : {}
}
function fail(message: string): never { throw new RemoteError('gateway/bad-request', message, {}) }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }

class SessionExpiredError extends RemoteError {
  constructor() { super('gateway/bad-request', '登录已失效，请重新登录。', {}) }
}

/** Keeps management sessions in the host credential provider and exposes fixed operations. */
export class ManagerRemote extends TypertRemoteService {
  private readonly sessions = new Map<string, string>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly sessionStore = new SessionStore(() => this.ctx.get('credentials' as never) as unknown as SessionCredentials | undefined)
  private readonly pending = new Map<string, { state: string; realm: string; region: string }>()

  constructor(ctx: Context) { super(ctx, 'workbuddyManager', { namespace: 'workbuddy' }) }

  @Remote
  async manage(input: ManagerRequest): Promise<unknown> {
    const invocation = (this.ctx as unknown as { invocation?: Parameters<typeof principalOf>[0] }).invocation
    if (principalOf(invocation)) fail('只有 DSH 所有者可以管理 WorkBuddy。')
    const request = managerRequest.safeParse(input)
    if (!request.success) fail('管理请求格式无效。')
    let base: string
    try { base = managementURL(request.data.address) } catch { fail('管理服务地址无效。') }
    // A prior renewal must settle before logout removes the stored session.
    const previous = this.operations.get(base) ?? Promise.resolve()
    const operation = previous.then(() => this.dispatch(base, request.data))
    const settled = operation.then(() => undefined, () => undefined)
    this.operations.set(base, settled)
    try { return await operation } finally { if (this.operations.get(base) === settled) this.operations.delete(base) }
  }

  private async dispatch(base: string, request: ManagerRequest): Promise<unknown> {
    switch (request.action) {
      case 'health': return this.health(base)
      case 'login': return this.login(base, request.username, request.password)
      case 'logout': return this.logout(base)
      case 'overview': return this.overview(base)
      case 'accountDisabled':
        await this.request(base, `/api/accounts/${encodeURIComponent(request.file)}/disabled`, 'POST', { disabled: request.disabled })
        return { ok: true }
      case 'authStart': return this.authStart(base, request.realm, request.region)
      case 'authPoll': return this.authPoll(base)
      case 'createKey':
        await this.request(base, '/api/keys', 'POST', { name: request.name, ...(request.realm ? { realm: request.realm } : {}) })
        return { ok: true }
      case 'keyEnabled':
        await this.request(base, `/api/keys/${request.id}`, 'PATCH', { enabled: request.enabled })
        return { ok: true }
      case 'renameKey':
        await this.request(base, `/api/keys/${request.id}`, 'PATCH', { name: request.name })
        return { ok: true }
      case 'useKey': return this.useKey(base, request.id, request.ref)
    }
  }

  private async savedSession(base: string): Promise<string | undefined> {
    const current = this.sessions.get(base)
    if (current) return current
    const saved = await this.sessionStore.read(base)
    if (saved) this.sessions.set(base, saved)
    return saved
  }

  private async health(base: string): Promise<unknown> {
    const reply = object(await this.request(base, '/api/healthz', 'GET', undefined, false))
    if (reply.ok !== true || reply.service !== 'workbuddy-manager') fail('该地址不是 WorkBuddy Manager 服务。')
    if (!await this.savedSession(base)) return { online: true, authenticated: false }
    try {
      const user = object(await this.request(base, '/api/me', 'GET'))
      return { online: true, authenticated: true, role: text(user.role) }
    } catch (error) {
      if (error instanceof SessionExpiredError) return { online: true, authenticated: false }
      throw error
    }
  }

  private async login(base: string, username: string, password: string): Promise<unknown> {
    this.sessions.delete(base)
    const reply = object(await this.request(base, '/api/login', 'POST', { username, password }, false))
    const session = this.sessions.get(base)
    if (reply.ok !== true || !session) fail('管理服务未建立登录会话。')
    try { await this.sessionStore.save(base, session) } catch (error) { this.sessions.delete(base); throw error }
    return { ok: true, role: text(reply.role) }
  }

  private async logout(base: string): Promise<unknown> {
    try { if (await this.savedSession(base)) await this.request(base, '/api/logout', 'POST') }
    finally { this.sessions.delete(base); this.pending.delete(base); await this.sessionStore.clear(base) }
    return { ok: true }
  }

  private async overview(base: string): Promise<unknown> {
    const [accountData, keyData] = await Promise.all([
      this.request(base, '/api/accounts', 'GET'), this.request(base, '/api/keys', 'GET'),
    ])
    const pool = object(accountData)
    const accounts = Array.isArray(pool.accounts) ? pool.accounts.map(item => {
      const account = object(item)
      return {
        file: text(account.file), nickname: text(account.nickname), note: text(account.note), realm: text(account.realm),
        disabled: account.disabled_by_panel === true || account.manual_disabled === true,
        blocked: account.disabled === true, expired: account.is_expired === true,
        inPool: account.in_pool === true, cooling: account.cooling === true,
        credits: number(account.credits),
      }
    }) : []
    const keys = Array.isArray(keyData) ? keyData.map(item => {
      const key = object(item)
      return { id: number(key.id), name: text(key.name), realm: text(key.realm), enabled: key.enabled === true, quota: number(key.quota), usedTokens: number(key.used_tokens), quotaCredit: number(key.quota_credit), usedCredit: number(key.used_credit) }
    }).filter(item => item.id !== null) : []
    return { accounts, keys, poolAvailable: pool.pool_available === true, manageable: pool.manageable === true }
  }

  private async authStart(base: string, realm: 'cn' | 'global', region: string): Promise<unknown> {
    const reply = object(await this.request(base, '/api/auth/start', 'POST', { realm, region }))
    const state = text(reply.state)
    const authUrl = text(reply.authUrl)
    let url: URL
    try { url = new URL(authUrl) } catch { fail('管理服务没有返回有效的授权地址。') }
    if (url.protocol !== 'https:' || url.username || url.password || authUrl.length > 2048 || !state) fail('管理服务返回的授权地址无效。')
    this.pending.set(base, { state, realm, region })
    return { authUrl }
  }

  private async authPoll(base: string): Promise<unknown> {
    const pending = this.pending.get(base)
    if (!pending) fail('请先发起扫码授权。')
    const query = new URLSearchParams({ state: pending.state, realm: pending.realm })
    if (pending.region) query.set('region', pending.region)
    const reply = object(await this.request(base, `/api/auth/poll?${query}`, 'GET'))
    const status = text(reply.status)
    if (status === 'success' || status === 'expired' || status === 'invalid') this.pending.delete(base)
    return { status }
  }

  private async useKey(base: string, id: number, ref: string): Promise<unknown> {
    const credentials = this.ctx.get('credentials' as never) as unknown as CredentialSink | undefined
    if (!credentials) fail('DSH 凭据存储不可用。')
    let status: { configured: boolean; writable: boolean }
    try { status = await credentials.describe(ref) } catch { fail('DSH 凭据存储不可用。') }
    if (!status.writable || status.configured) fail('新凭据引用不可写或已被占用。')
    const reply = object(await this.request(base, `/api/keys/${id}/reveal`, 'POST'))
    const key = text(reply.key)
    if (!key) fail('这把密钥无法取回，请创建新的网关密钥。')
    try { await credentials.set(ref, key) } catch { fail('DSH 凭据保存失败。') }
    return { ok: true }
  }

  private async request(base: string, path: string, method: string, body?: object, authenticated = true): Promise<unknown> {
    const session = authenticated ? await this.savedSession(base) : undefined
    if (authenticated && !session) fail('请先登录 WorkBuddy 管理服务。')
    let response: Response
    try {
      response = await fetch(`${base}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { ...(session && authenticated ? { cookie: session } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch { fail('无法连接 WorkBuddy 管理服务，请检查服务状态和地址。') }
    if (response.status === 401) {
      if (!authenticated) fail('用户名或密码不正确。')
      this.sessions.delete(base)
      await this.sessionStore.clear(base)
      throw new SessionExpiredError()
    }
    if (response.ok && (authenticated || path === '/api/login')) for (const cookie of response.headers.getSetCookie()) {
      const next = cookie.split(';', 1)[0]
      if (!validSession(next) || next === session) continue
      this.sessions.set(base, next)
      if (authenticated) {
        try { await this.sessionStore.save(base, next) } catch { fail('操作已完成，但无法保存更新后的管理会话。') }
      }
    }
    if (response.status === 429) fail('登录尝试过多，请稍后再试。')
    if (response.status === 409 && path.endsWith('/reveal')) fail('旧密钥无法取回，请创建新的网关密钥。')
    if (response.status === 409) fail('管理服务无法完成该操作，请检查目标状态。')
    if (!response.ok) fail(`管理服务请求失败（HTTP ${response.status}）。`)
    const reader = response.body?.getReader()
    if (!reader) fail('管理服务没有返回数据。')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.length
        if (length > MAX_REPLY) { await reader.cancel(); fail('管理服务返回的数据过大。') }
        chunks.push(part.value)
      }
    } catch (error) {
      if (error instanceof RemoteError) throw error
      fail('读取管理服务响应失败。')
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { fail('管理服务返回的数据格式错误。') }
  }
}
