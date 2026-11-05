import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import { BRIDGE_CREDENTIAL_REF, BRIDGE_PROVIDER } from '../address.js'
import {
  fetchAccountCredits,
  fresh,
  pollBrowserAuthStep,
  refreshRefused,
  startBrowserAuth,
  type PendingAuth,
} from '../gateway/oauth.js'
import { AccountPoolStore, toAccountItem, type CredentialStoreLike } from '../gateway/pool-store.js'
import { LocalGatewayServer } from '../gateway/server.js'
import { SESSION } from '../gateway/session-ids.js'
import { SITES, type Realm, type SiteConfig } from '../gateway/sites.js'
import { managerRequest, type ManagerRequest } from './contract.js'

export interface ManagerOptions {
  sites?: Partial<Record<Realm, Partial<SiteConfig>>>
}

function fail(message: string): never {
  throw new RemoteError('gateway/bad-request', message, {})
}

function resolveSites(overrides?: Partial<Record<Realm, Partial<SiteConfig>>>): Record<Realm, SiteConfig> {
  return {
    cn: { ...SITES.cn, ...overrides?.cn },
    global: { ...SITES.global, ...overrides?.global },
  }
}

/** Manages the in-host WorkBuddy account pool and local gateway, restricted to the DSH owner. */
export class ManagerRemote extends TypertRemoteService {
  readonly pool: AccountPoolStore
  readonly gateway: LocalGatewayServer
  private readonly sites: Record<Realm, SiteConfig>
  private pending?: PendingAuth
  private operation: Promise<void> = Promise.resolve()

  constructor(ctx: Context, options?: ManagerOptions) {
    super(ctx, 'workbuddyManager', { namespace: 'workbuddy' })
    this.sites = resolveSites(options?.sites)
    this.pool = new AccountPoolStore(() => this.ctx.get('credentials' as never) as unknown as CredentialStoreLike | undefined)
    this.gateway = new LocalGatewayServer({ pool: this.pool, sites: this.sites })

    ctx.effect(() => () => { void this.gateway.close() })

    const events = ctx as unknown as {
      on(name: string, listener: (request: { provider?: string; baseURL?: string; sessionId?: string }, headers: Headers, next: () => Headers) => Headers): void
    }
    events.on('llm-pi-ai/request-headers', (request, _headers, next) => {
      const headers = next()
      if (!this.isGatewayRequest(request)) return headers
      if (request.sessionId) headers.set(SESSION, String(request.sessionId).slice(0, 128))
      headers.set('authorization', `Bearer ${this.gateway.token}`)
      return headers
    })
  }

  private isGatewayRequest(request: { provider?: string; baseURL?: string }): boolean {
    if (request.provider === BRIDGE_PROVIDER) return true
    return Boolean(this.gateway.baseURL && request.baseURL === this.gateway.baseURL)
  }

  @Remote
  async manage(input: ManagerRequest): Promise<unknown> {
    const invocation = (this.ctx as unknown as { invocation?: Parameters<typeof principalOf>[0] }).invocation
    if (principalOf(invocation)) fail('只有 DSH 所有者可以管理 WorkBuddy。')
    const request = managerRequest.safeParse(input)
    if (!request.success) fail('管理请求格式无效。')
    return this.serialized(() => this.dispatch(request.data))
  }

  private async serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.then(run)
    this.operation = next.then(() => undefined, () => undefined)
    return next
  }

  private async dispatch(request: ManagerRequest): Promise<unknown> {
    switch (request.action) {
      case 'health': return this.health()
      case 'overview': return this.overview()
      case 'bridge': return this.issueBridge()
      case 'authStart': return this.authStart(request.realm)
      case 'authPoll': return this.authPoll()
      case 'accountDisabled': return this.accountDisabled(request.file, request.disabled)
      case 'accountDelete': return this.accountDelete(request.file)
      case 'accountRefresh': return this.accountRefresh(request.file)
    }
  }

  async ensureGateway(): Promise<string> {
    if (this.gateway.baseURL) return this.gateway.baseURL
    const meta = await this.pool.gatewayMeta()
    return this.gateway.ensureStarted(meta.port ?? 0)
  }

  private async health(): Promise<unknown> {
    const gatewayURL = await this.ensureGateway()
    const accounts = await this.pool.listAccountItems()
    return {
      online: true,
      gatewayURL,
      poolAvailable: accounts.some(a => a.inPool),
      accountCount: accounts.length,
    }
  }

  private async overview(): Promise<unknown> {
    const gatewayURL = await this.ensureGateway()
    const accounts = await this.pool.listAccountItems()
    return {
      accounts,
      gatewayURL,
      poolAvailable: accounts.some(a => a.inPool),
      manageable: true,
    }
  }

  private async issueBridge(): Promise<{ url: string; ref: string }> {
    const credentials = this.ctx.get('credentials' as never) as unknown as CredentialStoreLike | undefined
    if (!credentials?.describe || !credentials.set) fail('DSH 凭据存储不可用。')
    const ref = BRIDGE_CREDENTIAL_REF
    let writable = false
    try {
      const described = await credentials.describe(ref as never) as Record<string, any> | undefined
      writable = typeof described?.writable === 'boolean' ? described.writable : Boolean(described?.[ref]?.writable)
    } catch {
      fail('DSH 凭据存储不可用。')
    }
    if (!writable) fail('DSH 凭据存储不可写。')
    const url = await this.ensureGateway()
    try {
      await credentials.set(ref, this.gateway.token)
    } catch {
      fail('无法保存本地网关临时密钥。')
    }
    await this.pool.saveGatewayMeta(this.gateway.listeningPort, ref)
    return { url, ref }
  }

  private async authStart(realm: Realm): Promise<unknown> {
    const site = this.sites[realm] ?? this.sites.cn
    let pending: PendingAuth
    try {
      pending = await startBrowserAuth(site)
    } catch (error) {
      fail(error instanceof Error ? error.message : '获取登录链接失败。')
    }
    this.pending = pending
    return { authUrl: pending.authUrl }
  }

  private async authPoll(): Promise<unknown> {
    const pending = this.pending
    if (!pending) fail('请先获取登录链接或二维码。')
    const site = this.sites[pending.realm] ?? this.sites.cn
    let step: Awaited<ReturnType<typeof pollBrowserAuthStep>>
    try {
      step = await pollBrowserAuthStep(site, pending)
    } catch (error) {
      fail(error instanceof Error ? error.message : '轮询登录状态失败。')
    }
    if (step.status === 'expired') {
      this.pending = undefined
      return { status: 'expired', ...(step.error ? { error: step.error } : {}) }
    }
    if (step.status === 'success' && step.account) {
      this.pending = undefined
      const credits = await fetchAccountCredits(site, step.account)
      const saved = await this.pool.upsertSignedIn(step.account, credits)
      return { status: 'success', account: toAccountItem(saved) }
    }
    return { status: step.status }
  }

  private async accountDisabled(file: string, disabled: boolean): Promise<unknown> {
    const updated = await this.pool.updateAccount(file, {
      disabled,
      ...(disabled ? {} : { restricted: false, coolingUntil: undefined }),
    })
    if (!updated) fail('找不到指定的 WorkBuddy 账号。')
    return { ok: true }
  }

  private async accountDelete(file: string): Promise<unknown> {
    const removed = await this.pool.removeAccount(file)
    if (!removed) fail('找不到指定的 WorkBuddy 账号。')
    return { ok: true }
  }

  private async accountRefresh(file?: string): Promise<unknown> {
    const accounts = await this.pool.listAccounts()
    const targets = file ? accounts.filter(a => a.id === file) : accounts
    if (file && targets.length === 0) fail('找不到指定的 WorkBuddy 账号。')
    for (const a of targets) {
      const site = this.sites[a.realm] ?? this.sites.cn
      try {
        const next = await fresh(site, a, async u => {
          await this.pool.updateAccount(a.id, { ...u, expired: false })
        })
        const credits = await fetchAccountCredits(site, { ...a, ...next })
        await this.pool.updateAccount(a.id, {
          ...next,
          expired: false,
          ...(credits !== null ? { credits } : {}),
        })
      } catch (error) {
        if (refreshRefused(error)) await this.pool.updateAccount(a.id, { expired: true })
      }
    }
    return { ok: true }
  }
}
