import { fresh, gone, invalidToken, refusedText, reissued, type ReissueOutcome } from './oauth.js'
import { domainOf, enterpriseHeaders, type AccountIdentity, type SiteConfig } from './sites.js'

export const EDGE_READS = 2 * 1024 * 1024
export const edgeNotes = new WeakMap<Response, string>()

const CODE = (n: string, s: string) => `TCACA_code_${n}_${s}`
const PAID_CODES = [
  CODE('002', 'AkiJS3ZHF5'), CODE('005', 'maRGyrHhw1'), CODE('003', 'FAnt7lcmRT'), CODE('023', '4xbGhMrE6q'),
  CODE('026', 'BaESVICNoi'), CODE('027', '0FCGVA6vSa'), CODE('043', '6oIkxT7Z0S'), CODE('009', '0XmEQc2xOf'),
  CODE('038', 'OhvqZtiPKr'), CODE('036', 'lupO5WgNdG'),
]
const DAILY_CODE = CODE('001', 'PqouKr6QWV')
const FREE_MON = CODE('008', 'cfWoLwvjU4')
const FREE_CODES = [
  DAILY_CODE, FREE_MON, CODE('035', 'ArVxJcGDsm'), CODE('006', 'DbXS0lrypC'), CODE('039', 'KRcQj7wUat'),
  CODE('040', 'mi9rCYg46x'), CODE('007', 'nzdH5h4Nl0'), CODE('028', 'NtpWi0jzXs'), CODE('037', 'WxOD3MpI2o'),
  CODE('029', '6wCGEWquYy'), CODE('030', 'BjSt89qTvr'),
]
const PLAN_CODES = [
  CODE('002', 'AkiJS3ZHF5'), CODE('005', 'maRGyrHhw1'), CODE('003', 'FAnt7lcmRT'), CODE('023', '4xbGhMrE6q'),
  CODE('026', 'BaESVICNoi'), CODE('027', '0FCGVA6vSa'), CODE('043', '6oIkxT7Z0S'), CODE('035', 'ArVxJcGDsm'),
  CODE('039', 'KRcQj7wUat'), CODE('040', 'mi9rCYg46x'),
]
const EXTRA_CODES = [
  CODE('028', 'NtpWi0jzXs'), CODE('037', 'WxOD3MpI2o'), CODE('009', '0XmEQc2xOf'), CODE('038', 'OhvqZtiPKr'),
  CODE('036', 'lupO5WgNdG'), CODE('007', 'nzdH5h4Nl0'), CODE('029', '6wCGEWquYy'), CODE('030', 'BjSt89qTvr'),
]
const EXTRA_AI = [FREE_MON, CODE('006', 'DbXS0lrypC')]
const SLICE = '4'

const byteLength = (b: unknown): number =>
  typeof b === 'string' ? Buffer.byteLength(b) : b instanceof ArrayBuffer || ArrayBuffer.isView(b) ? b.byteLength : 0

export function meterAsked(
  site: SiteConfig,
  a: AccountIdentity,
  path: string,
  body: Record<string, unknown> = {},
  signal: AbortSignal = AbortSignal.timeout(20000),
): Promise<Response> {
  return fetch(`${site.endpoint}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `WorkBuddy/${site.app}`,
      Authorization: `Bearer ${a.access}`,
      'X-User-Id': a.uid ?? '',
      'X-Domain': domainOf(site, a),
      'X-Product': 'SaaS',
      'X-IDE-Type': 'WorkBuddy',
      ...enterpriseHeaders(a),
    },
    body: JSON.stringify(body),
    signal,
  })
}

export async function unanswered(
  site: SiteConfig,
  a: AccountIdentity,
  body: unknown,
  err: any,
  signal?: AbortSignal | null,
): Promise<Response> {
  if (signal?.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err
  const size = byteLength(body)
  if (size <= EDGE_READS || a.source === 'key') throw err
  let status = 0
  let challenge = ''
  try {
    const res = await meterAsked(site, a, '/billing/meter/get-user-resource-summary', {}, AbortSignal.timeout(20000))
    status = res.status
    challenge = res.headers.get('www-authenticate') ?? ''
    await res.body?.cancel().catch(() => {})
  } catch {
    throw err
  }
  if (status !== 401) throw err
  const mb = (size / (1024 * 1024)).toFixed(1)
  const note = `It closes the connection on a refused request over 2 MiB (this one was ${mb} MiB) instead of answering, which is why it read as ECONNRESET.`
  const message =
    `${site.name} refused this account's sign-in (401). ${note} ` +
    (a.source === 'desktop' ? `Sign in to ${site.name} desktop again.` : `Sign in to ${site.name} again in DSH Settings → WorkBuddy.`)
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(challenge ? { 'www-authenticate': challenge } : {}) }
  const res = new Response(JSON.stringify({ error: { message, type: 'authentication_error', code: 401 } }), {
    status: 401,
    statusText: 'Unauthorized',
    headers,
  })
  edgeNotes.set(res, note)
  return res
}

export async function meter(site: SiteConfig, a: AccountIdentity, path: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await meterAsked(site, a, path, body)
  const raw = await res.text()
  let env: Record<string, any> = {}
  let parsed = true
  try { env = JSON.parse(raw) ?? {} } catch { parsed = false }
  if (res.ok && !parsed) {
    const unreadable = raw.trim().slice(0, 120) || '(empty)'
    throw Object.assign(new Error(`unreadable reply ${unreadable}`), { status: res.status, code: 0, unreadable: true })
  }
  const code = Number.parseInt(String(env.code ?? ''), 10) || 0
  const said: Record<string, any> = { status: res.status, code }
  if (!res.ok) said.invalidToken = invalidToken(res)
  const err = (message: string) => Object.assign(new Error(message), said)
  if (!res.ok) {
    if (code) throw err(env.msg || `error ${code}`)
    if (env.msg) throw err(env.msg)
    throw err(res.statusText || `HTTP ${res.status}`)
  }
  if (code) throw err(env.msg || `error ${code}`)
  return env.data ?? null
}

export function capacity(v: unknown): number {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).trim()
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function planCodes(sum: any, site: SiteConfig): (code?: string) => boolean {
  const sub = sum?.SubscriptionPackageCode
  return (code?: string) => Boolean(code && (code === sub || PLAN_CODES.includes(code) || (!site.ai && code === FREE_MON)))
}

export function kindsOf(sum: any, site: SiteConfig): { plan: { total: number; used: number }; extra: { total: number; used: number }; left: number; bags: number } {
  const ofPlan = planCodes(sum, site)
  const kinds = { plan: { total: 0, used: 0 }, extra: { total: 0, used: 0 }, left: 0, bags: 0 }
  const hasTotal = (p: any) => p?.CycleTotalCapacity != null && p.CycleTotalCapacity !== ''
  const add = (k: { total: number; used: number }, p: any) => {
    const total = capacity(p.CycleTotalCapacity)
    k.total += total
    if (p?.CycleUsedCapacity != null && p.CycleUsedCapacity !== '') {
      k.used += capacity(p.CycleUsedCapacity)
    } else if (p?.CycleRemainCapacity != null || p?.CycleCapacityRemainPrecise != null) {
      k.used += Math.max(0, total - capacity(p.CycleRemainCapacity ?? p.CycleCapacityRemainPrecise))
    }
  }
  const groups = (Array.isArray(sum?.CreditGroups) ? sum.CreditGroups : []).filter(hasTotal)
  for (const g of groups) add(kinds[g?.Kind === 'plan_base' ? 'plan' : 'extra'], g)
  for (const p of sum?.Packages ?? []) {
    if (hasTotal(p)) {
      if (!groups.length) add(kinds[ofPlan(p?.PackageCode) ? 'plan' : 'extra'], p)
    } else if ((p?.CycleRemainCapacity != null && p.CycleRemainCapacity !== '') || (p?.CycleCapacityRemainPrecise != null && p.CycleCapacityRemainPrecise !== '')) {
      kinds.left += capacity(p.CycleRemainCapacity ?? p.CycleCapacityRemainPrecise)
      kinds.bags++
    }
  }
  return kinds
}

function endOf(p: any): number {
  const ms = Number(p?.DeductionEndTime)
  if (ms > 0) return ms
  for (const v of [p?.ExpiredTime, p?.CycleEndTime]) {
    if (typeof v !== 'string' || !v.trim()) continue
    const s = v.trim()
    const t = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? Date.parse(`${s.replace(' ', 'T')}+08:00`) : Date.parse(s)
    if (t > 0) return t
  }
  return 0
}

export function listedExtra(sum: any, packages: any[], site: SiteConfig, now = Date.now()): { total: number; used: number; runsOutAt?: string } | null {
  const summed = new Set((sum?.Packages ?? []).map((p: any) => p?.PackageCode))
  const codes = site.ai ? [...EXTRA_CODES, ...EXTRA_AI] : EXTRA_CODES
  let total = 0; let left = 0; let at = 0
  for (const p of packages ?? []) {
    const code = p?.PackageCode
    if (!codes.includes(code) || summed.has(code)) continue
    const end = endOf(p)
    if (end > 0 && end <= now) continue
    const slice = String(p?.CapacityType) === SLICE ? p?.SlicePeriodUsageDetails?.[0] : null
    const t = Math.max(0, capacity(slice ? slice.SlicePeriodCapacitySizePrecise : p?.CycleCapacitySizePrecise))
    const l = Math.min(t, Math.max(0, capacity(slice ? slice.SlicePeriodCapacityRemainPrecise : p?.CycleCapacityRemainPrecise)))
    if (!(t > 0)) continue
    total += t; left += l
    if (l > 0 && end > 0 && !slice && (!at || end < at)) at = end
  }
  if (!(total > 0)) return null
  return { total, used: total - left, ...(at ? { runsOutAt: new Date(at).toISOString() } : {}) }
}

export function cycleOf(sum: any, packages: any[], now = Date.now()): { resetsAt: string; span?: number } | null {
  const code = sum?.SubscriptionPackageCode
  const parseAt = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v.trim()) ? Date.parse(`${v.trim().replace(' ', 'T')}+08:00`) : 0
  const ofPkg = (p: any) => {
    const end = parseAt(p?.CycleEndTime); const start = parseAt(p?.CycleStartTime)
    if (!(end > now)) return null
    return { resetsAt: new Date(end).toISOString(), ...(start > 0 && start < end ? { span: (end - start) / 1000 } : {}) }
  }
  if (code) {
    for (const p of packages ?? []) if (p?.PackageCode === code) return ofPkg(p)
    return null
  }
  for (const p of packages ?? []) if (String(p?.CapacityType) === SLICE) return ofPkg(p)
  return null
}

export function runsOutOf(sum: any, packages: any[], now = Date.now()): { runsOutAt: string; runsOut: number } | null {
  const counted = new Set((sum?.Packages ?? []).map((p: any) => p?.PackageCode))
  let at = 0; let amount = 0
  for (const p of packages ?? []) {
    if (!counted.has(p?.PackageCode) || p?.PackageCode === DAILY_CODE || String(p?.CapacityType) === SLICE) continue
    const left = capacity(p?.CycleCapacityRemainPrecise ?? p?.CycleCapacityRemain)
    const end = endOf(p)
    if (!(left > 0) || end <= now) continue
    if (!at || end < at) { at = end; amount = left }
    else if (end === at) amount += left
  }
  return at ? { runsOutAt: new Date(at).toISOString(), runsOut: amount } : null
}

async function packagesOf(site: SiteConfig, a: AccountIdentity, now = Date.now()): Promise<any[]> {
  const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
  const lists: Array<[string, Record<string, unknown>]> = [
    ['/billing/meter/get-user-resource-paid-packages', { PackageCodes: PAID_CODES, NeedRenewInfo: true }],
    ['/billing/meter/get-user-resource-free-packages', { PackageCodes: FREE_CODES, SlicePeriodStartTime: `${day} 00:00:00`, SlicePeriodEndTime: `${day} 23:59:59` }],
  ]
  const out: any[] = []
  for (const [path, extra] of lists) {
    for (let page = 1; page <= 10; page++) {
      const d = await meter(site, a, path, { PageNumber: page, PageSize: 200, Status: [0, 3], ...extra })
      const got = Array.isArray(d?.Accounts) ? d.Accounts : []
      out.push(...got)
      if (got.length < 200 || out.length >= (d?.TotalCount ?? 0)) break
    }
  }
  return out
}

export interface UsageLookupOptions {
  getAccount?: () => Promise<AccountIdentity | null | undefined>
  saveAccount?: (next: AccountIdentity) => Promise<void> | void
}

export interface AccountUsageResult {
  credits: number | null
  cycleEnd?: string
  runsOutAt?: string
  error?: string
  signIn: 'kept' | 'renewed' | 'expired'
  updatedAccount?: AccountIdentity
}

export async function fetchAccountUsage(site: SiteConfig, initial: AccountIdentity, options?: UsageLookupOptions): Promise<AccountUsageResult> {
  if (initial.source === 'key') {
    return { credits: null, signIn: 'kept' }
  }
  try {
    let a = await fresh(site, initial, options?.saveAccount)
    let signIn: 'kept' | 'renewed' | 'expired' = 'kept'
    let sum: any
    try {
      sum = await meter(site, a, '/billing/meter/get-user-resource-summary')
    } catch (e: any) {
      if (e?.status !== 401) throw e
      const r: ReissueOutcome = await reissued(site, options?.getAccount ?? (async () => a), options?.saveAccount, a, initial.access)
      if (!r.a) {
        return { credits: null, error: refusedText(site, a, r.why), signIn: gone(a, r, Boolean(e.invalidToken)) ? 'expired' : 'kept' }
      }
      a = r.a
      try {
        sum = await meter(site, a, '/billing/meter/get-user-resource-summary')
      } catch (e2: any) {
        if (e2?.status !== 401) throw e2
        const why = 'it refused the token renewed for it too'
        return { credits: null, error: refusedText(site, a, why), signIn: a.source !== 'desktop' && e2.invalidToken ? 'expired' : 'kept', updatedAccount: a }
      }
      signIn = 'renewed'
    }
    const kinds = kindsOf(sum, site)
    const hasSummaryCredits = kinds.plan.total > 0 || kinds.extra.total > 0 || kinds.bags > 0
    if (!hasSummaryCredits) {
      try {
        const ent = await meter(site, a, '/billing/meter/get-enterprise-user-usage')
        const limit = capacity(ent?.limitNum)
        if (limit > 0) {
          const remain = Math.max(0, Math.round((limit - capacity(ent?.credit)) * 100) / 100)
          return { credits: remain, signIn, updatedAccount: a }
        }
      } catch {}
      return { credits: null, signIn, updatedAccount: a }
    }
    let remain = Math.max(0, kinds.plan.total - kinds.plan.used) + Math.max(0, kinds.extra.total - kinds.extra.used) + Math.max(0, kinds.left)
    let cycleEnd: string | undefined
    let runsOutAt: string | undefined
    if (kinds.plan.total > 0 || kinds.extra.total > 0) {
      try {
        const pkgs = await packagesOf(site, a)
        cycleEnd = cycleOf(sum, pkgs)?.resetsAt
        runsOutAt = runsOutOf(sum, pkgs)?.runsOutAt
        if (kinds.plan.total > 0 && kinds.extra.total === 0) {
          const more = listedExtra(sum, pkgs, site)
          if (more) {
            remain += Math.max(0, more.total - more.used)
            if (!runsOutAt && more.runsOutAt) runsOutAt = more.runsOutAt
          }
        }
      } catch {}
    }
    return {
      credits: Math.round(remain * 100) / 100,
      ...(cycleEnd ? { cycleEnd } : {}),
      ...(runsOutAt ? { runsOutAt } : {}),
      signIn,
      updatedAccount: a,
    }
  } catch (e: any) {
    return { credits: null, error: e?.message ?? String(e), signIn: 'kept' }
  }
}

export async function fetchAccountCredits(site: SiteConfig, a: AccountIdentity, options?: UsageLookupOptions): Promise<number | null> {
  const res = await fetchAccountUsage(site, a, options)
  return res.credits
}

export async function checkinOf(
  site: SiteConfig,
  a: AccountIdentity,
  { waits = [0, 0] }: { waits?: number[] } = {},
): Promise<{ outcome: 'claimed' | 'done' | 'inactive' | 'ineligible' | 'failed'; credit?: number; streak?: number; message?: string }> {
  if (a.source === 'key') return { outcome: 'ineligible', message: 'API Key 账号不支持每日签到。' }
  let status: any
  try {
    status = await meter(site, a, '/v2/billing/meter/checkin-activity-status')
  } catch (e: any) {
    if (e?.code === 1001) return { outcome: 'done' }
    if (e?.status !== undefined || e?.code !== undefined) return { outcome: 'failed', message: e.message }
    throw e
  }
  if (!status?.active) return { outcome: 'inactive' }
  if (status.today_checked_in ?? status.todayCheckedIn) {
    const credit = Number(status.today_credit ?? status.daily_credit)
    return { outcome: 'done', ...(Number.isFinite(credit) && credit > 0 ? { credit } : {}) }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const got = await meter(site, a, '/v2/billing/meter/daily-checkin')
      const credit = Number(got?.credit)
      const streak = Number(got?.streak_days)
      return {
        outcome: 'claimed',
        ...(Number.isFinite(credit) && credit > 0 ? { credit } : {}),
        ...(Number.isFinite(streak) && streak > 0 ? { streak } : {}),
        ...(got?.message ? { message: String(got.message) } : {}),
      }
    } catch (e: any) {
      if (e?.code === 1001) return { outcome: 'done' }
      if (e?.code === 1002) return { outcome: 'ineligible', message: e.message }
      if (e?.code === 1003) return { outcome: 'inactive', message: e.message }
      if (e?.status === 401) {
        try { await meter(site, a, '/billing/meter/get-user-resource-summary') } catch { throw e }
        return { outcome: 'ineligible', message: "WorkBuddy's check-in takes WorkBuddy's own app" }
      }
      if (e?.unreadable) return { outcome: 'failed', message: `check-in: ${e.message}` }
      const transient = e?.status >= 500 || e?.code === 10000
      if (transient && attempt < waits.length) {
        await new Promise(r => setTimeout(r, waits[attempt]))
        continue
      }
      if (e?.status !== undefined || e?.code !== undefined) return { outcome: 'failed', message: e.message }
      throw e
    }
  }
}
