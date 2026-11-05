import { domainOf, enterpriseHeaders, hex, type AccountIdentity, type Realm, type SiteConfig } from './sites.js'

const EARLY_MS = 60 * 1000
const KEEP_RENEWED_MS = 60 * 1000
const TOKEN_FIELDS = ['access', 'refresh', 'expires', 'refreshExpiresAt', 'domain', 'tokenType'] as const

export class WBError extends Error {
  constructor(
    message: string,
    readonly code?: number | string,
    readonly status?: number,
    readonly said?: string,
  ) {
    super(message)
    this.name = 'WBError'
  }
}

export interface PendingAuth {
  realm: Realm
  state: string
  authUrl: string
  createdAt: number
  token?: AccountIdentity
}

export interface SignedInAccount extends AccountIdentity {
  realm: Realm
  uid: string
  nickname: string
  enterpriseId?: string
  enterpriseName?: string
}

export async function call(
  site: SiteConfig,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${site.endpoint}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `WorkBuddy/${site.app}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let env: Record<string, any> = {}
  try { env = JSON.parse(text) ?? {} } catch {}
  const code = Number.parseInt(String(env.code ?? ''), 10) || 0
  if (!res.ok) {
    const why = env.msg || env.message || env.error?.message || text.slice(0, 200) || res.statusText || `HTTP ${res.status}`
    const said = code ? env.msg || `error ${code}` : env.msg || `HTTP ${res.status}`
    throw new WBError(`${site.name}: ${why} (HTTP ${res.status}${env.code ? `, code ${env.code}` : ''})`, code || env.code, res.status, said)
  }
  if (code) throw new WBError(`${site.name}: ${env.msg || 'error'} (${code})`, code, res.status, env.msg || `error ${code}`)
  return env.data
}

export function mergeToken(a: AccountIdentity, got: Record<string, any>): AccountIdentity {
  const now = Date.now()
  const out: AccountIdentity = { ...a, access: String(got.accessToken ?? a.access ?? '') }
  if (got.refreshToken) out.refresh = String(got.refreshToken)
  if (got.domain) out.domain = String(got.domain)
  if (got.tokenType) out.tokenType = String(got.tokenType)
  if (got.expiresAt > 0) out.expires = Number(got.expiresAt)
  else if (got.expiresIn > 0) out.expires = now + Number(got.expiresIn) * 1000
  if (got.refreshExpiresAt > 0) out.refreshExpiresAt = Number(got.refreshExpiresAt)
  else if (got.refreshExpiresIn > 0) out.refreshExpiresAt = now + Number(got.refreshExpiresIn) * 1000
  return out
}

export function stale(a: AccountIdentity): boolean {
  return Boolean(a.expires && Date.now() >= a.expires - EARLY_MS)
}

export function refreshable(a: AccountIdentity): boolean {
  return Boolean(a.refresh && !(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt))
}

export const invalidToken = (res?: Response | null): boolean =>
  res?.status === 401 && /invalid_token/i.test(res.headers.get('www-authenticate') ?? '')

export const refreshRefused = (e: unknown): boolean =>
  e instanceof WBError && (e.status === 401 || /invalid_grant/i.test(e.message) || Number(e.code) === 12153 || Number(e.code) === 10000)

const renewing = new Map<string, Promise<AccountIdentity>>()
const renewed = new Map<string, { next: AccountIdentity; at: number }>()

function merged(a: AccountIdentity, next: AccountIdentity): AccountIdentity {
  const out: Record<string, any> = { ...a }
  for (const k of TOKEN_FIELDS) if (k in next && next[k] !== undefined) out[k] = next[k]
  return out as AccountIdentity
}

export function renew(
  site: SiteConfig,
  a: AccountIdentity,
  save?: (next: AccountIdentity) => Promise<void> | void,
): Promise<AccountIdentity> {
  const key = `${site.id}\n${a.refresh ?? ''}`
  const done = renewed.get(key)
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) return Promise.resolve(merged(a, done.next))
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const got = await call(site, 'POST', '/v2/plugin/auth/token/refresh', {
        'X-Refresh-Token': a.refresh ?? '',
        'X-Auth-Refresh-Source': 'plugin',
        'X-Domain': domainOf(site, a),
        ...enterpriseHeaders(a),
      }, {})
      if (!got?.accessToken) throw Object.assign(new Error('WorkBuddy gave no refreshed token'), { bare: true })
      const next = mergeToken(a, got)
      renewed.set(key, { next, at: Date.now() })
      await save?.(next)
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  return r.then(next => merged(a, next))
}

export async function fresh(
  site: SiteConfig,
  a: AccountIdentity,
  save?: (next: AccountIdentity) => Promise<void> | void,
): Promise<AccountIdentity> {
  if (!stale(a)) return a
  if (!refreshable(a)) {
    if (a.access) return a
    throw new Error('该 WorkBuddy 账号登录已过期，请重新扫码或打开链接授权。')
  }
  try {
    return await renew(site, a, save)
  } catch (e: any) {
    if (a.access && !refreshRefused(e)) return a
    throw e
  }
}

export async function enterpriseOf(
  site: SiteConfig,
  a: AccountIdentity,
  who: Record<string, any>,
): Promise<{ id: string; name: string }> {
  const name = (x: any) => (typeof x?.enterpriseName === 'string' ? x.enterpriseName.trim() : '')
  const own = typeof who?.enterpriseId === 'string' ? who.enterpriseId.trim() : ''
  const type = String(who?.type ?? '').trim().toLowerCase()
  if (!own && (!type || type === 'personal')) return { id: '', name: '' }
  if (own && name(who)) return { id: own, name: name(who) }
  let list: any
  try {
    list = await call(site, 'GET', '/v2/plugin/accounts', {
      Authorization: `Bearer ${a.access}`,
      'X-Domain': domainOf(site, a),
    })
  } catch {
    return { id: own, name: '' }
  }
  const mine = (list?.accounts ?? []).filter(
    (x: any) => x?.uid === who.uid && typeof x.enterpriseId === 'string' && x.enterpriseId.trim(),
  )
  if (own) return { id: own, name: name(mine.find((x: any) => x.enterpriseId.trim() === own)) }
  const same = mine.filter((x: any) => String(x.type ?? '').trim().toLowerCase() === type)
  const last = mine.filter((x: any) => x.lastLogin)
  const pick = same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : undefined
  return pick ? { id: pick.enterpriseId.trim(), name: name(pick) } : { id: '', name: '' }
}

export function accountName(who: Record<string, any>, ent?: { id?: string; name?: string }): string {
  const person = who?.nickname || who?.phoneNumber || who?.uid || ''
  if (!ent?.id) return person
  const team = ent.name || `enterprise ${ent.id.slice(-6)}`
  return person ? `${person} · ${team}` : team
}

export async function startBrowserAuth(site: SiteConfig): Promise<PendingAuth> {
  const state = await call(
    site,
    'POST',
    `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`,
    {
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
    },
    {},
  )
  if (!state?.state || !state?.authUrl) throw new Error(`${site.name} 未返回登录授权地址`)
  const url = new URL(String(state.authUrl))
  if (url.protocol !== 'https:') throw new Error(`${site.name} 登录链接必须使用 HTTPS`)
  url.searchParams.set('version', site.app)
  url.searchParams.set('loginSessionId', hex())
  return {
    realm: site.realm,
    state: String(state.state),
    authUrl: url.toString(),
    createdAt: Date.now(),
  }
}

export async function pollBrowserAuthStep(
  site: SiteConfig,
  pending: PendingAuth,
): Promise<{ status: 'pending' | 'scanned' | 'success' | 'expired'; account?: SignedInAccount; error?: string }> {
  if (Date.now() - pending.createdAt > 5 * 60 * 1000) return { status: 'expired' }
  const q = encodeURIComponent(pending.state)
  if (!pending.token) {
    try {
      const token = await call(site, 'GET', `/v2/plugin/auth/token?state=${q}`)
      if (!token || !Object.keys(token).length) return { status: 'pending' }
      if (!token.accessToken) return { status: 'expired', error: `${site.name} 未返回访问令牌` }
      pending.token = mergeToken({ access: '' }, token)
    } catch (e: any) {
      if (Number(e?.code) === 11217 || e?.status === 408 || e?.status === 429) return { status: 'pending' }
      throw e
    }
  }
  try {
    const a = pending.token
    const who = await call(site, 'GET', `/v2/plugin/login/account?state=${q}`, {
      Authorization: `Bearer ${a.access}`,
      'X-Domain': domainOf(site, a),
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
    })
    if (!who || !Object.keys(who).length) return { status: 'scanned' }
    const uid = String(who.uid ?? '')
    const ent = await enterpriseOf(site, a, who)
    const nickname = accountName(who, ent) || site.name
    return {
      status: 'success',
      account: {
        ...a,
        realm: site.realm,
        uid,
        nickname,
        ...(ent.id ? { enterpriseId: ent.id } : {}),
        ...(ent.name ? { enterpriseName: ent.name } : {}),
      },
    }
  } catch (e: any) {
    if (Number(e?.code) === 12151 || e?.status === 408 || e?.status === 429) return { status: 'scanned' }
    throw e
  }
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export async function fetchAccountCredits(site: SiteConfig, a: AccountIdentity): Promise<number | null> {
  try {
    const sum = await call(site, 'POST', '/billing/meter/get-user-resource-summary', {
      Authorization: `Bearer ${a.access}`,
      'X-User-Id': a.uid ?? '',
      'X-Domain': domainOf(site, a),
      'X-Product': 'SaaS',
      'X-IDE-Type': 'WorkBuddy',
      ...enterpriseHeaders(a),
    }, {})
    const packages = Array.isArray(sum?.Packages) ? sum.Packages : []
    if (packages.length > 0) {
      let remain = 0
      for (const p of packages) remain += num(p?.CycleRemainCapacity ?? p?.CycleCapacityRemainPrecise)
      return Math.round(remain * 100) / 100
    }
    if (a.enterpriseId) {
      const ent = await call(site, 'POST', '/billing/meter/get-enterprise-user-usage', {
        Authorization: `Bearer ${a.access}`,
        'X-User-Id': a.uid ?? '',
        'X-Domain': domainOf(site, a),
        'X-Product': 'SaaS',
        'X-IDE-Type': 'WorkBuddy',
        ...enterpriseHeaders(a),
      }, {})
      const limit = num(ent?.limitNum)
      if (limit > 0) return Math.max(0, Math.round((limit - num(ent?.credit)) * 100) / 100)
    }
    return null
  } catch {
    return null
  }
}
