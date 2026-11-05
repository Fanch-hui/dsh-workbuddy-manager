import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { edgeNotes, unanswered } from './billing.js'
import { fresh, gone, invalidToken, kept, keyRefused, refreshRefused, reissued, signedOut } from './oauth.js'
import type { AccountPoolStore, PoolAccount } from './pool-store.js'
import {
  AFTER_TOOLS_REFUSED, BAD_SIGNATURE, commaPaused, commaPausedOn, gzipped, hideDsh, isMessages,
  namesEffort, REFUSED, replyAfterTools, replyAfterToolsOn, systemAsUser, systemAsUserOn,
  systemKeyOf, withDefaultEffort, withoutSignedThinking,
} from './rewrite.js'
import { attendChat, reattend, scopeOf, sessionOf } from './session-ids.js'
import {
  chatHeaders, fallbackModels, liveModels, nativeOf, notFree, remoteConfig,
  SITES, sign, type ModelSpec, type Realm, type SiteConfig,
} from './sites.js'
import { classifyUpstreamError, explained, inspectStreamForFailover, renamed, windowReset } from './stream-filter.js'
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
  private readonly unlisted = new Map<string, number>()
  private readonly realmModels = new Map<Realm, Set<string>>()
  private readonly refusedSystems = new Set<string>()
  private readonly commaSystems = new Set<string>()
  private readonly endsAfterTools = new Set<string>()
  private readonly activeRequests = new Set<AbortController>()

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
    for (const ctl of this.activeRequests) ctl.abort()
    this.activeRequests.clear()
    const srv = this.server
    this.server = undefined
    this.port = 0
    if (srv) await new Promise<void>(resolve => srv.close(() => resolve()))
  }

  private checkAuth(req: IncomingMessage): boolean {
    const raw = (req.headers.authorization ?? req.headers['x-api-key'] ?? '')
    const text = (Array.isArray(raw) ? raw[0] : raw).trim()
    const givenToken = /^Bearer\s+(.+)$/i.exec(text)?.[1]?.trim() ?? text
    if (!givenToken) return false
    const given = Buffer.from(givenToken)
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
            ...(m.free !== undefined ? { free: m.free } : {}),
            ...(m.rate !== undefined ? { rate: m.rate } : {}),
            ...(m.rateWas !== undefined ? { rateWas: m.rateWas } : {}),
            ...(m.efforts?.length ? { efforts: m.efforts } : {}),
            ...(m.effort ? { effort: m.effort } : {}),
            ...(m.native ? { native: true } : {}),
          })),
        }))
        return
      }
      if (req.method === 'POST' && (/\/chat\/completions$/.test(url.pathname) || /\/messages(\/count_tokens)?$/.test(url.pathname))) {
        await this.handleModelRequest(req, res, url.pathname)
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

  private listKey(a: PoolAccount): string {
    return `${a.realm}|${a.uid ?? ''}|${a.enterpriseId ?? ''}|${a.source === 'key' ? a.key ?? '' : ''}`
  }

  private async modelsForAccount(a: PoolAccount, strict = false): Promise<ModelSpec[]> {
    const site = this.sites[a.realm] ?? this.sites.cn
    if (a.source === 'key' && !remoteConfig(a.key)) {
      if (strict) throw new Error(`${site.name} lists no prices for this API key`)
      return fallbackModels(site)
    }
    const key = this.listKey(a)
    const cached = this.modelCache.get(key)
    if (cached && Date.now() - cached.at < PRICE_TTL) return cached.list
    const list = await liveModels(site, await this.ensureFresh(site, a))
    if (list.length > 0) {
      this.unlisted.delete(key)
      this.modelCache.set(key, { at: Date.now(), list })
      if (this.modelCache.size > 64) this.modelCache.delete(this.modelCache.keys().next().value!)
      let known = this.realmModels.get(a.realm)
      if (!known) { known = new Set(); this.realmModels.set(a.realm, known) }
      for (const m of list) known.add(m.id)
      return list
    }
    if (strict) return []
    return fallbackModels(site)
  }

  private async effortList(a: PoolAccount): Promise<ModelSpec[] | null> {
    if (a.source === 'key' && !remoteConfig(a.key)) return null
    const key = this.listKey(a)
    if (Date.now() - (this.unlisted.get(key) ?? 0) < PRICE_TTL) return null
    try {
      return await this.modelsForAccount(a, true)
    } catch {
      this.unlisted.set(key, Date.now())
      if (this.unlisted.size > 64) this.unlisted.delete(this.unlisted.keys().next().value!)
      return null
    }
  }

  async discoverModels(): Promise<ModelSpec[]> {
    const [candidates, gwOpts] = await Promise.all([
      this.options.pool.selectCandidates({ advanceCursor: false }),
      this.options.pool.getGatewayOptions(),
    ])
    const merged = new Map<string, ModelSpec>()
    const addList = (list: ModelSpec[]) => {
      const filtered = gwOpts.freeOnly ? list.filter(m => m.free) : list
      for (const m of filtered) if (!merged.has(m.id)) merged.set(m.id, m)
    }
    const realms = new Set<Realm>()
    for (const a of candidates) {
      if (realms.has(a.realm)) continue
      realms.add(a.realm)
      try { addList(await this.modelsForAccount(a, gwOpts.freeOnly)) }
      catch { if (!gwOpts.freeOnly) addList(fallbackModels(this.sites[a.realm] ?? this.sites.cn)) }
    }
    if (merged.size === 0 && !gwOpts.freeOnly) {
      addList(fallbackModels(this.sites.cn))
      addList(fallbackModels(this.sites.global))
    }
    return [...merged.values()]
  }

  private routingScopeForModel(model: string | undefined, native: boolean): { preferredRealm?: Realm; allowedRealms?: Set<Realm> } {
    if (native) return { preferredRealm: 'cn', allowedRealms: new Set<Realm>(['cn']) }
    if (!model) return {}
    const inRealm = (r: Realm) =>
      this.realmModels.get(r)?.has(model) || this.sites[r].models.some(([id]) => id === model) || (r === 'cn' && nativeOf(this.sites.cn, model))
    const inCn = inRealm('cn')
    const inGlobal = inRealm('global')
    if (inCn && !inGlobal) return { preferredRealm: 'cn', allowedRealms: new Set<Realm>(['cn']) }
    if (inGlobal && !inCn) return { preferredRealm: 'global', allowedRealms: new Set<Realm>(['global']) }
    return {}
  }

  private async ensureFresh(site: SiteConfig, a: PoolAccount): Promise<PoolAccount> {
    const next = await fresh(site, a, async updated => { await this.options.pool.updateAccount(a.id, updated) })
    return { ...a, ...next }
  }

  private async handleModelRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const abortCtl = new AbortController()
    this.activeRequests.add(abortCtl)
    res.once('close', () => { if (!res.writableEnded) abortCtl.abort() })
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const incomingHeaders = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') incomingHeaders.set(k, v)
        else if (Array.isArray(v)) incomingHeaders.set(k, v.join(', '))
      }
      const session = sessionOf(incomingHeaders)
      const native = isMessages(pathname, rawBody)
      let { body, chat, changed, names } = prepared(rawBody, native)
      const gwOpts = await this.options.pool.getGatewayOptions()
      if (gwOpts.hideDsh && hideDsh(chat)) changed = true
      const model = typeof chat?.model === 'string' ? chat.model : undefined

      const scope = this.routingScopeForModel(model, native)
      let candidates = await this.options.pool.selectCandidates({ ...scope, model })
      if (candidates.length === 0 && scope.allowedRealms && !native) {
        candidates = await this.options.pool.selectCandidates({ preferredRealm: scope.preferredRealm, model })
      }
      if (candidates.length === 0) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          error: { message: 'WorkBuddy 账号池中没有可用账号，请在 DSH「设置 → WorkBuddy」中扫码或打开链接添加账号。', type: 'authentication_error', code: 401 },
        }))
        return
      }
      const sysKey = native ? '' : systemKeyOf(chat)
      if (!native) {
        if (sysKey && this.refusedSystems.has(sysKey) && systemAsUserOn(chat)) changed = true
        if (sysKey && this.commaSystems.has(sysKey) && commaPausedOn(chat)) changed = true
        if (model && this.endsAfterTools.has(model) && replyAfterToolsOn(chat)) changed = true
      }
      if (changed && chat) body = JSON.stringify(chat)

      let chosenResponse: Response | undefined
      let chosenAccountId: string | undefined
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]
        const site = this.sites[candidate.realm] ?? this.sites.cn
        this.options.pool.acquireInFlight(candidate.id)
        let keepInFlight = false
        try {
          const outcome = await this.sendWithAccount(
            site, candidate, body, chat, names, session, sysKey, model,
            native, pathname, gwOpts.freeOnly, abortCtl.signal,
          )
          chosenResponse = outcome.response
          if (!outcome.failover || i === candidates.length - 1) {
            chosenAccountId = candidate.id
            keepInFlight = true
            break
          }
          await outcome.response.body?.cancel().catch(() => {})
        } finally {
          if (!keepInFlight) this.options.pool.releaseInFlight(candidate.id)
        }
      }
      try {
        if (chosenResponse && !abortCtl.signal.aborted) await this.pipeResponse(chosenResponse, res)
      } finally {
        if (chosenAccountId) this.options.pool.releaseInFlight(chosenAccountId)
      }
    } finally {
      this.activeRequests.delete(abortCtl)
    }
  }

  private async sendWithAccount(
    site: SiteConfig, account: PoolAccount, initialBody: string, initialChat: Record<string, any> | null,
    names: Map<string, string>, session: string, sysKey: string, model: string | undefined,
    native: boolean, pathname: string, freeOnly: boolean, signal: AbortSignal,
  ): Promise<{ response: Response; failover: boolean }> {
    const storedAccess = account.access
    let a: PoolAccount
    try {
      a = await this.ensureFresh(site, account)
    } catch (e: any) {
      if (signal.aborted || e?.name === 'AbortError') throw e
      const exp = refreshRefused(e) && account.source !== 'desktop'
      if (exp) await this.options.pool.updateAccount(account.id, { expired: true })
      return { response: signedOut(site, account, e?.said ?? e?.message ?? String(e), exp), failover: true }
    }
    if (freeOnly) {
      let list: ModelSpec[]
      try { list = await this.modelsForAccount(a, true) }
      catch (e: any) { return { response: notFree(site, model, e?.message ?? String(e)), failover: true } }
      if (!list.some(m => m.id === model && m.free)) return { response: notFree(site, model), failover: false }
    }
    let body = initialBody
    if (!native && initialChat && !namesEffort(initialChat)) {
      const list = await this.effortList(a)
      const clone = structuredClone(initialChat)
      if (withDefaultEffort(clone, list)) body = JSON.stringify(clone)
    }
    const headers = new Headers({ 'Content-Type': 'application/json' })
    sign(site, a, headers); chatHeaders(site, headers)
    let who = scopeOf(a)
    let ids = attendChat(headers, initialChat, session, who)
    const targetUrl = native
      ? `${site.endpoint}${pathname.startsWith('/v1/') ? pathname : `/v1${pathname.startsWith('/') ? pathname : `/${pathname}`}`}`
      : `${site.endpoint}/v2/chat/completions`
    const post = (payload: string): Promise<Response> => {
      const z = gzipped(!native, payload)
      if (z) headers.set('Content-Encoding', 'gzip')
      else headers.delete('Content-Encoding')
      return fetch(targetUrl, { method: 'POST', headers, body: z ?? payload, signal })
        .catch(e => unanswered(site, a, z ?? payload, e, signal))
    }
    let renewedOnce = false
    const ours = new WeakSet<Response>()
    const out = (why: string, expired: boolean, res: Response): Response => {
      const r = signedOut(site, a, why, expired && a.source !== 'desktop', edgeNotes.get(res))
      ours.add(r)
      return r
    }
    const send = async (payload: string): Promise<Response> => {
      const res = await post(payload)
      if (res.status !== 401) return res
      if (renewedOnce) {
        const exp = invalidToken(res) && a.source !== 'desktop'
        if (exp) await this.options.pool.updateAccount(a.id, { expired: true })
        return out('it refused the token renewed for it too', exp, res)
      }
      if (a.source === 'key') {
        const exp = invalidToken(res)
        if (exp) await this.options.pool.updateAccount(a.id, { expired: true })
        const r = keyRefused(site, exp, edgeNotes.get(res))
        ours.add(r)
        return r
      }
      await res.body?.cancel().catch(() => {})
      const r = await reissued(
        site,
        () => this.options.pool.getAccount(a.id),
        async u => { await this.options.pool.updateAccount(a.id, { ...u, expired: false }) },
        a,
        storedAccess,
      )
      if (!r.a) {
        const exp = gone(a, r, invalidToken(res))
        if (exp) await this.options.pool.updateAccount(a.id, { expired: true })
        return out(r.why, exp, res)
      }
      renewedOnce = true
      a = { ...a, ...r.a }
      await this.options.pool.updateAccount(a.id, { ...r.a, expired: false })
      sign(site, a, headers)
      ids = reattend(headers, ids, who, (who = scopeOf(a)))
      const again = await post(payload)
      if (again.status !== 401) return again
      const exp = invalidToken(again) && a.source !== 'desktop'
      if (exp) await this.options.pool.updateAccount(a.id, { expired: true })
      return out('it refused the token renewed for it too', exp, again)
    }

    let res: Response
    try {
      res = await send(body)
    } catch (e: any) {
      if (signal.aborted || e?.name === 'AbortError') throw e
      return {
        response: new Response(JSON.stringify({ error: { message: e?.message ?? String(e), type: 'api_error', code: 502 } }), {
          status: 502, headers: { 'content-type': 'application/json' },
        }),
        failover: true,
      }
    }
    if (ours.has(res)) return { response: res, failover: true }
    let preReadText: string | undefined
    if (native && res.status >= 400) {
      const text = await res.text()
      const again = BAD_SIGNATURE.test(text) ? withoutSignedThinking(body) : null
      if (again) {
        try { res = await send(again) } catch (e: any) {
          if (signal.aborted || e?.name === 'AbortError') throw e
          return { response: new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers }), failover: true }
        }
        if (ours.has(res)) return { response: res, failover: true }
      } else {
        preReadText = text
      }
    }
    if (!native && res.status === 400) {
      const retried = await this.retryRefused(res, body, send, sysKey, model)
      res = retried.response
      preReadText = retried.preReadText
      if (ours.has(res)) return { response: res, failover: true }
    }
    if (res.status >= 400) return this.classifyFailure(a, res, model, preReadText)
    if (native) return { response: kept(res, renewedOnce ? 'renewed' : 'kept'), failover: false }
    const renamedRes = await renamed(res, names)
    const inspected = await inspectStreamForFailover(renamedRes)
    if (inspected.streamErrorText) {
      const errRes = new Response(inspected.streamErrorText, { status: 502, headers: { 'content-type': 'application/json' } })
      return this.classifyFailure(a, errRes, model, inspected.streamErrorText)
    }
    return {
      response: kept(inspected.response, renewedOnce ? 'renewed' : 'kept'),
      failover: inspected.filterRefused,
    }
  }

  private async retryRefused(
    initial: Response, initialBody: string, send: (payload: string) => Promise<Response>, sysKey: string, model?: string,
  ): Promise<{ response: Response; preReadText?: string }> {
    const shaped = (b: string) => (model && this.endsAfterTools.has(model) ? replyAfterTools(b) ?? b : b)
    let res = initial; let body = initialBody; let text: string | undefined = await res.text()
    const roles = new Set<string>()
    const paused = REFUSED.test(text) ? commaPaused(body, roles) : null
    if (paused) {
      body = paused; text = undefined; res = await send(shaped(body))
      if (res.status === 400) text = await res.text()
      else if (sysKey && roles.has('system')) {
        this.commaSystems.add(sysKey)
        if (this.commaSystems.size > 256) this.commaSystems.delete(this.commaSystems.values().next().value!)
      }
    }
    const moved = res.status === 400 && text !== undefined && REFUSED.test(text) && sysKey && !this.refusedSystems.has(sysKey)
      ? systemAsUser(body) : null
    if (moved) {
      this.refusedSystems.add(sysKey)
      if (this.refusedSystems.size > 256) this.refusedSystems.delete(this.refusedSystems.values().next().value!)
      body = moved; text = undefined; res = await send(shaped(body))
      if (res.status === 400) text = await res.text()
    }
    const again = res.status === 400 && text !== undefined && model && !this.endsAfterTools.has(model) && AFTER_TOOLS_REFUSED.test(text)
      ? replyAfterTools(body) : null
    if (again && model) {
      this.endsAfterTools.add(model); text = undefined; res = await send(again)
    }
    return { response: res, preReadText: text }
  }

  private async classifyFailure(a: PoolAccount, res: Response, model?: string, preReadText?: string): Promise<{ response: Response; failover: boolean }> {
    const text = preReadText ?? await res.text()
    const classified = classifyUpstreamError(text)
    if (res.status === 401) return { response: await explained(res, text), failover: true }
    if (classified.isRestricted) {
      await this.options.pool.updateAccount(a.id, { restricted: true })
      return { response: await explained(res, text), failover: true }
    }
    if (res.status === 429 || classified.isExhausted) {
      const resetAt = windowReset(text)
      const coolingUntil = Number.isFinite(resetAt) && resetAt > Date.now() ? resetAt : Date.now() + 60_000
      if (res.status === 429 && classified.isModelRateLimit && model) {
        await this.options.pool.coolModel(a.id, model, coolingUntil)
      } else {
        await this.options.pool.updateAccount(a.id, { coolingUntil })
      }
      return { response: await explained(res, text), failover: true }
    }
    const shouldFailover = res.status >= 500 || res.status === 408 || res.status === 403
    return { response: await explained(res, text), failover: shouldFailover }
  }

  private async pipeResponse(upstream: Response, res: ServerResponse): Promise<void> {
    const outHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase()
      if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') outHeaders[key] = value
    })
    res.writeHead(upstream.status, outHeaders)
    if (!upstream.body) { res.end(); return }
    for await (const chunk of Readable.fromWeb(upstream.body as any)) {
      if (res.destroyed || res.writableEnded) break
      if (!res.write(chunk)) await once(res, 'drain')
    }
    if (!res.writableEnded) res.end()
  }
}
