import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { fresh, invalidToken, refreshable, refreshRefused, renew } from './oauth.js'
import type { AccountPoolStore, PoolAccount } from './pool-store.js'
import {
  AFTER_TOOLS_REFUSED, commaPaused, commaPausedOn, gzipped, hideDsh, namesEffort,
  REFUSED, replyAfterTools, replyAfterToolsOn, systemAsUser, systemAsUserOn, systemKeyOf, withDefaultEffort,
} from './rewrite.js'
import { attendChat, reattend, scopeOf, sessionOf } from './session-ids.js'
import { chatHeaders, fallbackModels, liveModels, SITES, sign, type ModelSpec, type Realm, type SiteConfig } from './sites.js'
import { classifyUpstreamError, explained, renamed, unsaid, windowReset } from './stream-filter.js'
import { prepared } from './tools-stream.js'

const PRICE_TTL = 60_000

export interface GatewayOptions {
  pool: AccountPoolStore
  sites?: Record<Realm, SiteConfig>
}

export class LocalGatewayServer {
  readonly token = randomBytes(32).toString('hex')
  private server?: Server
  private port = 0
  private starting?: Promise<number>
  private readonly sites: Record<Realm, SiteConfig>
  private readonly modelCache = new Map<string, { at: number; list: ModelSpec[] }>()
  private readonly refusedSystems = new Set<string>()
  private readonly commaSystems = new Set<string>()
  private readonly endsAfterTools = new Set<string>()

  constructor(private readonly options: GatewayOptions) {
    this.sites = options.sites ?? SITES
  }

  get baseURL(): string { return this.port > 0 ? `http://127.0.0.1:${this.port}/v1` : '' }
  get listeningPort(): number { return this.port }

  async ensureStarted(preferredPort = 0): Promise<string> {
    if (this.port > 0 && this.server?.listening) return this.baseURL
    if (!this.starting) this.starting = this.listen(preferredPort).finally(() => { this.starting = undefined })
    await this.starting
    return this.baseURL
  }

  private async listen(preferredPort: number): Promise<number> {
    const tryListen = (port: number) => new Promise<number>((resolve, reject) => {
      const srv = createServer((req, res) => { void this.handleRequest(req, res) })
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', reject)
        this.server = srv
        this.port = (srv.address() as { port: number }).port
        resolve(this.port)
      })
    })
    if (preferredPort > 0) {
      try { return await tryListen(preferredPort) } catch {}
    }
    return tryListen(0)
  }

  async close(): Promise<void> {
    const srv = this.server
    this.server = undefined
    this.port = 0
    if (srv) await new Promise<void>(resolve => srv.close(() => resolve()))
  }

  private checkAuth(req: IncomingMessage): boolean {
    const match = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? '').trim())
    if (!match) return false
    const given = Buffer.from(match[1].trim())
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/api/healthz')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, service: 'workbuddy-local-gateway' }))
        return
      }
      if (!this.checkAuth(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'authentication_error', code: 401 } }))
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        const models = await this.discoverModels()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: models.map(m => ({
            id: m.id, object: 'model', name: m.name,
            contextWindow: m.context ?? 131072, maxOutputTokens: m.output || 32768,
            inputModalities: m.images === false ? ['text'] : ['text', 'image'],
          })),
        }))
        return
      }
      if (req.method === 'POST' && /\/chat\/completions$/.test(url.pathname)) {
        await this.handleChatCompletions(req, res)
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Not found: ${url.pathname}`, type: 'invalid_request_error', code: 404 } }))
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: 'server_error', code: 500 } }))
      } else res.end()
    }
  }

  private async modelsForAccount(a: PoolAccount): Promise<ModelSpec[]> {
    const site = this.sites[a.realm] ?? this.sites.cn
    const key = `${a.realm}|${a.uid}|${a.enterpriseId ?? ''}`
    const cached = this.modelCache.get(key)
    if (cached && Date.now() - cached.at < PRICE_TTL) return cached.list
    const list = await liveModels(site, await this.ensureFresh(site, a))
    if (list.length > 0) {
      this.modelCache.set(key, { at: Date.now(), list })
      if (this.modelCache.size > 64) this.modelCache.delete(this.modelCache.keys().next().value!)
      return list
    }
    return fallbackModels(site)
  }

  async discoverModels(): Promise<ModelSpec[]> {
    const candidates = await this.options.pool.selectCandidates()
    const merged = new Map<string, ModelSpec>()
    const addList = (list: ModelSpec[]) => { for (const m of list) if (!merged.has(m.id)) merged.set(m.id, m) }
    const realms = new Set<Realm>()
    for (const a of candidates) {
      if (realms.has(a.realm)) continue
      realms.add(a.realm)
      try { addList(await this.modelsForAccount(a)) }
      catch { addList(fallbackModels(this.sites[a.realm] ?? this.sites.cn)) }
    }
    if (merged.size === 0) {
      addList(fallbackModels(this.sites.cn))
      addList(fallbackModels(this.sites.global))
    }
    return [...merged.values()]
  }

  private preferredRealmForModel(model?: string): Realm | undefined {
    if (!model) return undefined
    const inCn = this.sites.cn.models.some(([id]) => id === model)
    const inGlobal = this.sites.global.models.some(([id]) => id === model)
    return inCn && !inGlobal ? 'cn' : inGlobal && !inCn ? 'global' : undefined
  }

  private async ensureFresh(site: SiteConfig, a: PoolAccount): Promise<PoolAccount> {
    const next = await fresh(site, a, async updated => { await this.options.pool.updateAccount(a.id, updated) })
    return { ...a, ...next }
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const incomingHeaders = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') incomingHeaders.set(k, v)
      else if (Array.isArray(v)) incomingHeaders.set(k, v.join(', '))
    }
    const session = sessionOf(incomingHeaders)
    let { body, chat, changed, names } = prepared(Buffer.concat(chunks).toString('utf8'))
    if (hideDsh(chat)) changed = true
    const model = typeof chat?.model === 'string' ? chat.model : undefined
    const candidates = await this.options.pool.selectCandidates(this.preferredRealmForModel(model))
    if (candidates.length === 0) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: 'WorkBuddy 账号池中没有可用账号，请在 DSH「设置 → WorkBuddy」中扫码或打开链接添加账号。', type: 'authentication_error', code: 401 },
      }))
      return
    }
    const sysKey = systemKeyOf(chat)
    if (sysKey && this.refusedSystems.has(sysKey) && systemAsUserOn(chat)) changed = true
    if (sysKey && this.commaSystems.has(sysKey) && commaPausedOn(chat)) changed = true
    if (model && this.endsAfterTools.has(model) && replyAfterToolsOn(chat)) changed = true
    if (changed && chat) body = JSON.stringify(chat)

    let lastResponse: Response | undefined
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      const site = this.sites[candidate.realm] ?? this.sites.cn
      const outcome = await this.sendWithAccount(site, candidate, body, chat, names, session, sysKey, model)
      lastResponse = outcome.response
      if (!outcome.failover || i === candidates.length - 1) break
    }
    await this.pipeResponse(lastResponse!, res)
  }

  private async sendWithAccount(
    site: SiteConfig, account: PoolAccount, initialBody: string, initialChat: Record<string, any> | null,
    names: Map<string, string>, session: string, sysKey: string, model?: string,
  ): Promise<{ response: Response; failover: boolean }> {
    let a = await this.ensureFresh(site, account)
    let body = initialBody
    if (initialChat && !namesEffort(initialChat)) {
      const list = await this.modelsForAccount(a).catch(() => null)
      const clone = structuredClone(initialChat)
      if (withDefaultEffort(clone, list)) body = JSON.stringify(clone)
    }
    const headers = new Headers({ 'Content-Type': 'application/json' })
    sign(site, a, headers); chatHeaders(site, headers)
    let who = scopeOf(a)
    let ids = attendChat(headers, initialChat, session, who)
    const post = (payload: string): Promise<Response> => {
      const z = gzipped(true, payload)
      if (z) headers.set('Content-Encoding', 'gzip')
      else headers.delete('Content-Encoding')
      return fetch(`${site.endpoint}/v2/chat/completions`, { method: 'POST', headers, body: z ?? payload })
    }
    let renewedOnce = false
    const send = async (payload: string): Promise<Response> => {
      const res = await post(payload)
      if (res.status !== 401) return res
      if (renewedOnce || !refreshable(a)) {
        if (invalidToken(res) || !refreshable(a)) await this.options.pool.updateAccount(a.id, { expired: true })
        return res
      }
      await res.body?.cancel().catch(() => {})
      try {
        const next = await renew(site, a, async u => { await this.options.pool.updateAccount(a.id, { ...u, expired: false }) })
        renewedOnce = true; a = { ...a, ...next }; sign(site, a, headers)
        ids = reattend(headers, ids, who, (who = scopeOf(a)))
        const again = await post(payload)
        if (again.status === 401 && invalidToken(again)) await this.options.pool.updateAccount(a.id, { expired: true })
        return again
      } catch (e) {
        if (refreshRefused(e)) await this.options.pool.updateAccount(a.id, { expired: true })
        return res
      }
    }
    let res = await send(body)
    if (res.status === 400) {
      const retried = await this.retryRefused(res, body, send, sysKey, model)
      if (retried.explained) return { response: retried.response, failover: false }
      res = retried.response
    }
    if (res.status >= 400) return this.classifyFailure(a, res)
    return { response: unsaid(await renamed(res, names)), failover: false }
  }

  private async retryRefused(
    initial: Response, initialBody: string, send: (payload: string) => Promise<Response>, sysKey: string, model?: string,
  ): Promise<{ response: Response; explained: boolean }> {
    const shaped = (b: string) => (model && this.endsAfterTools.has(model) ? replyAfterTools(b) ?? b : b)
    let res = initial; let body = initialBody; let text = await res.text()
    const roles = new Set<string>()
    const paused = REFUSED.test(text) ? commaPaused(body, roles) : null
    if (paused) {
      body = paused; res = await send(shaped(body))
      if (res.status === 400) text = await res.text()
      else if (sysKey && roles.has('system')) {
        this.commaSystems.add(sysKey)
        if (this.commaSystems.size > 256) this.commaSystems.delete(this.commaSystems.values().next().value!)
      }
    }
    const moved = res.status === 400 && REFUSED.test(text) && sysKey && !this.refusedSystems.has(sysKey) ? systemAsUser(body) : null
    if (moved) {
      this.refusedSystems.add(sysKey)
      if (this.refusedSystems.size > 256) this.refusedSystems.delete(this.refusedSystems.values().next().value!)
      body = moved; res = await send(shaped(body))
      if (res.status === 400) text = await res.text()
    }
    const again = res.status === 400 && model && !this.endsAfterTools.has(model) && AFTER_TOOLS_REFUSED.test(text) ? replyAfterTools(body) : null
    if (again && model) {
      this.endsAfterTools.add(model); res = await send(again)
    } else if (res.status === 400) {
      return { response: await explained(res, text), explained: true }
    }
    return { response: res, explained: false }
  }

  private async classifyFailure(a: PoolAccount, res: Response): Promise<{ response: Response; failover: boolean }> {
    const text = await res.text()
    const classified = classifyUpstreamError(text)
    if (res.status === 401) return { response: await explained(res, text), failover: true }
    if (classified.isRestricted) {
      await this.options.pool.updateAccount(a.id, { restricted: true })
      return { response: await explained(res, text), failover: true }
    }
    if (res.status === 429 || classified.isExhausted) {
      const resetAt = windowReset(text)
      const coolingUntil = Number.isFinite(resetAt) && resetAt > Date.now() ? resetAt : Date.now() + 60_000
      await this.options.pool.updateAccount(a.id, { coolingUntil })
      return { response: await explained(res, text), failover: true }
    }
    return { response: await explained(res, text), failover: false }
  }

  private async pipeResponse(upstream: Response, res: ServerResponse): Promise<void> {
    const outHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase()
      if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') outHeaders[key] = value
    })
    res.writeHead(upstream.status, outHeaders)
    if (!upstream.body) { res.end(); return }
    for await (const chunk of Readable.fromWeb(upstream.body as any)) res.write(chunk)
    res.end()
  }
}
