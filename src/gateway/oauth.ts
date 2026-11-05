import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

export type ReissueOutcome =
  | { a: AccountIdentity; why?: undefined; kind?: undefined }
  | { a?: undefined; why: string; kind: 'refresh refused' | 'nothing to renew with' | 'unknown' }

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

export const stale = (a: AccountIdentity): boolean => Boolean(a.expires && Date.now() >= a.expires - EARLY_MS)
export const refreshable = (a: AccountIdentity): boolean => Boolean(a.refresh && !(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt))
export const invalidToken = (res?: Response | null): boolean =>
  res?.status === 401 && /invalid_token/i.test(res.headers.get('www-authenticate') ?? '')
export const refreshRefused = (e: unknown): boolean =>
  e instanceof WBError && (e.status === 401 || /invalid_grant/i.test(e.message) || Number(e.code) === 12153 || Number(e.code) === 10000)

const renewing = new Map<string, Promise<AccountIdentity>>()
const renewed = new Map<string, { next: AccountIdentity; at: number }>()
export const desktopHeld = new Map<string, AccountIdentity>()

function merged(a: AccountIdentity, next: AccountIdentity): AccountIdentity {
  const out: Record<string, any> = { ...a }
  for (const k of TOKEN_FIELDS) if (k in next && next[k] !== undefined) out[k] = next[k]
  return out as AccountIdentity
}

export function desktopFile(site: SiteConfig): string {
  const override = process.env.WORKBUDDY_DESKTOP_AUTH_DIR
  if (override) return join(override, `${site.authID}.info`)
  const home = homedir()
  const base = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'CodeBuddyExtension')
    : process.platform === 'win32'
      ? join(home, 'AppData', 'Local', 'CodeBuddyExtension')
      : join(home, '.local', 'share', 'CodeBuddyExtension')
  return join(base, 'Data', 'Public', 'auth', `${site.authID}.info`)
}

export function readDesktop(site: SiteConfig): (AccountIdentity & { uid: string; name: string; source: 'desktop' }) | null {
  try {
    const f = JSON.parse(readFileSync(desktopFile(site), 'utf8'))
    const t = f?.auth ?? {}
    if (typeof t.accessToken !== 'string' || !t.accessToken || !f?.account?.uid) return null
    const now = Date.now()
    const acct = f.account
    return {
      access: t.accessToken,
      refresh: typeof t.refreshToken === 'string' ? t.refreshToken : '',
      expires: t.expiresAt > 0 ? t.expiresAt : t.expiresIn > 0 ? now + t.expiresIn * 1000 : 0,
      refreshExpiresAt: t.refreshExpiresAt > 0 ? t.refreshExpiresAt : t.refreshExpiresIn > 0 ? now + t.refreshExpiresIn * 1000 : 0,
      domain: typeof t.domain === 'string' ? t.domain : '',
      tokenType: typeof t.tokenType === 'string' ? t.tokenType : '',
      uid: String(acct.uid),
      ...(typeof acct.enterpriseId === 'string' && acct.enterpriseId.trim() ? { enterpriseId: acct.enterpriseId.trim() } : {}),
      name: String(acct.nickname || acct.phoneNumber || acct.uid),
      source: 'desktop',
    }
  } catch {
    return null
  }
}

export function notDesktop(site: SiteConfig): string {
  try {
    const t = JSON.parse(readFileSync(desktopFile(site), 'utf8'))?.auth ?? {}
    if (t.accessToken?.$wbEncrypted || t.refreshToken?.$wbEncrypted) {
      return `${site.name} 桌面端（5.6 及以上版本）对本地令牌进行了加密存储，无法直接读取，请使用扫码或链接方式登录。`
    }
  } catch {}
  return `未检测到 ${site.name} 桌面端登录状态。`
}

export function keyAccount(rawKey: string, realm: Realm, nickname?: string): SignedInAccount | null {
  const key = rawKey.trim()
  if (!key) return null
  const suffix = key.slice(-8)
  return {
    realm,
    uid: `anonymous_${suffix}`,
    nickname: nickname?.trim() || `API Key (${suffix})`,
    access: key,
    key,
    source: 'key',
  }
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
  if (a.source === 'key') return a
  if (a.source === 'desktop') {
    const d = readDesktop(site)
    if (!d) throw new Error(notDesktop(site))
    const k = `${site.id}|${d.uid}`
    const h = desktopHeld.get(k)
    const base = h && (h.expires ?? 0) >= (d.expires ?? 0) ? h : d
    const next = !stale(base) ? base : refreshable(base) ? await renew(site, base).catch(() => base) : base
    desktopHeld.set(k, next)
    return { ...a, ...next, source: 'desktop' }
  }
  if (!stale(a)) return a
  if (!refreshable(a)) {
    if (a.access) return a
    throw new Error('该 WorkBuddy 账号登录已过期，请重新扫码或打开链接授权。')
  }
  try {
    return await renew(site, a, save)
  } catch (e: any) {
    if (a.access) return a
    if (e?.bare) throw e
    throw new Error(`WorkBuddy token refresh: ${e?.said ?? e?.message ?? e}`)
  }
}

export async function reissued(
  site: SiteConfig,
  getAccount: () => Promise<AccountIdentity | null | undefined>,
  saveAccount: ((next: AccountIdentity) => Promise<void> | void) | undefined,
  a: AccountIdentity,
  began?: string,
): Promise<ReissueOutcome> {
  if (a.source === 'desktop') {
    desktopHeld.delete(`${site.id}|${a.uid ?? ''}`)
    const d = readDesktop(site)
    if (!d) return { why: notDesktop(site), kind: 'unknown' }
    if (d.access !== a.access) {
      desktopHeld.set(`${site.id}|${a.uid ?? ''}`, d)
      return { a: { ...a, ...d, source: 'desktop' } }
    }
    return { why: `${site.name} desktop's own sign-in is the one refused`, kind: 'unknown' }
  }
  const newer = async (): Promise<AccountIdentity | null> => {
    const now = await getAccount().catch(() => null)
    return now && now.source !== 'desktop' && now.source !== 'key' && now.access && now.access !== began && now.access !== a.access
      ? now
      : null
  }
  const saved = await newer()
  if (saved) return { a: saved }
  if (!refreshable(a)) {
    return { why: a.refresh ? 'its refresh token has ended' : 'there is no refresh token to renew it with', kind: 'nothing to renew with' }
  }
  try {
    const next = await renew(site, a, saveAccount)
    return next.access !== a.access ? { a: next } : { why: 'renewing it gave the same token', kind: 'unknown' }
  } catch (e: any) {
    if (refreshRefused(e)) {
      const concurrent = await newer()
      if (concurrent) return { a: concurrent }
      return { why: `it refused the refresh token too (${e?.said ?? e?.message})`, kind: 'refresh refused' }
    }
    return { why: `renewing it failed: ${e?.said ?? e?.message ?? e}`, kind: 'unknown' }
  }
}

export const gone = (a: AccountIdentity, r: { kind?: string }, tokenRefused: boolean): boolean =>
  a.source !== 'desktop' && (r.kind === 'refresh refused' || (r.kind === 'nothing to renew with' && Boolean(tokenRefused)))

export function refusedText(site: SiteConfig, a: AccountIdentity, why?: string, note?: string): string {
  return (
    `${site.name} refused this account's sign-in (401)${why ? `; ${why}` : ''}. ${note ? `${note} ` : ''}` +
    (a.source === 'desktop'
      ? `Sign in to ${site.name} desktop again; the gateway reads its sign-in on the next request.`
      : `Sign in to ${site.name} again in DSH Settings → WorkBuddy.`)
  )
}

export function keyRefused(site: SiteConfig, expired: boolean, note?: string): Response {
  const message = `${site.name} refused this API key (401). ${note ? `${note} ` : ''}Check the key at ${site.keys}, then add it again in DSH Settings → WorkBuddy.`
  return new Response(JSON.stringify({ error: { message, type: 'authentication_error', code: 401 } }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json', 'X-Magpie-Sign-In': expired ? 'expired' : 'kept' },
  })
}

export function signedOut(site: SiteConfig, a: AccountIdentity, why: string, expired: boolean, note?: string): Response {
  const message = refusedText(site, a, why, note)
  return new Response(JSON.stringify({ error: { message, type: 'authentication_error', code: 401 } }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json', 'X-Magpie-Sign-In': expired ? 'expired' : 'kept' },
  })
}

export function kept(res: Response, said: 'kept' | 'renewed' = 'kept'): Response {
  const headers = new Headers(res.headers)
  headers.set('X-Magpie-Sign-In', said)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
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
  const state = await call(site, 'POST', `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`, {
    'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true',
  }, {})
  if (!state?.state || !state?.authUrl) throw new Error(`${site.name} 未返回登录授权地址`)
  const url = new URL(String(state.authUrl))
  if (url.protocol !== 'https:') throw new Error(`${site.name} 登录链接必须使用 HTTPS`)
  url.searchParams.set('version', site.app)
  url.searchParams.set('loginSessionId', hex())
  return { realm: site.realm, state: String(state.state), authUrl: url.toString(), createdAt: Date.now() }
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
      pending.token = mergeToken({ access: '', source: 'browser' }, token)
    } catch (e: any) {
      if (Number(e?.code) === 11217 || e?.status === 408 || e?.status === 429) return { status: 'pending' }
      throw e
    }
  }
  try {
    const a = pending.token
    const who = await call(site, 'GET', `/v2/plugin/login/account?state=${q}`, {
      Authorization: `Bearer ${a.access}`, 'X-Domain': domainOf(site, a), 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true',
    })
    if (!who || !Object.keys(who).length) return { status: 'scanned' }
    const uid = String(who.uid ?? '')
    const ent = await enterpriseOf(site, a, who)
    const nickname = accountName(who, ent) || site.name
    return {
      status: 'success',
      account: { ...a, realm: site.realm, uid, nickname, ...(ent.id ? { enterpriseId: ent.id } : {}), ...(ent.name ? { enterpriseName: ent.name } : {}) },
    }
  } catch (e: any) {
    if (Number(e?.code) === 12151 || e?.status === 408 || e?.status === 429) return { status: 'scanned' }
    throw e
  }
}

export { checkinOf, edgeNotes, fetchAccountCredits, fetchAccountUsage, unanswered } from './billing.js'
