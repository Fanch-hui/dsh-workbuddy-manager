import { randomBytes } from 'node:crypto'

export type Realm = 'cn' | 'global'

export type ModelTuple = readonly [string, string, number, (readonly string[])?]

export interface SiteConfig {
  id: string
  realm: Realm
  name: string
  endpoint: string
  platform: string
  ai: boolean
  app: string
  cli: string
  appName: string
  runtime: string
  models: ReadonlyArray<ModelTuple>
  noImages?: RegExp
  messages?: boolean
}

export interface ModelSpec {
  id: string
  name: string
  context?: number
  output?: number
  images?: boolean
  free?: boolean
  rate?: number
  rateWas?: number
  efforts?: string[]
  effort?: string
}

export interface AccountIdentity {
  access: string
  refresh?: string
  expires?: number
  refreshExpiresAt?: number
  uid?: string
  domain?: string
  enterpriseId?: string
  enterpriseName?: string
  tokenType?: string
  source?: string
  key?: string
}

export const CN_MODELS: ReadonlyArray<ModelTuple> = [
  ['auto', 'Auto', 168000],
  ['hy4-preview-f', 'Hy4 preview', 1000000, ['high']],
  ['hy3', 'Hy3', 192000, ['low', 'high']],
  ['hy3-x', 'Hy3-X', 192000, ['low', 'high']],
  ['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash', 1000000, ['none', 'low', 'high', 'max']],
  ['glm-5.3', 'GLM-5.3', 1000000, ['low', 'high', 'max']],
  ['glm-5.3-flash', 'GLM-5.3-Flash', 1000000, ['low', 'high', 'max']],
  ['glm-5.2', 'GLM-5.2', 1000000, ['high', 'xhigh']],
  ['glm-5.1', 'GLM-5.1', 200000],
  ['glm-5v-turbo', 'GLM-5v-Turbo', 200000],
  ['minimax-m3', 'MiniMax-M3', 512000],
  ['kimi-k3-1', 'Kimi-K3', 1000000, ['low', 'high', 'xhigh']],
  ['kimi-k2.7', 'Kimi-K2.7-Code', 256000],
  ['kimi-k2.6', 'Kimi-K2.6', 256000],
  ['deepseek-v4-pro', 'Deepseek-V4-Pro', 1000000, ['none', 'high', 'xhigh']],
]

export const AI_MODELS: ReadonlyArray<ModelTuple> = [
  ['default-model', 'Default', 176000],
  ['fast-model', 'Fast', 200000],
  ['balanced-model', 'Balanced', 256000],
  ['primary-model', 'Primary', 272000],
  ['deep-model', 'Deep', 176000],
  ['gpt-5.5', 'GPT-5.5', 1000000],
  ['gpt-5.4', 'GPT-5.4', 272000],
  ['gpt-5.3-codex', 'GPT-5.3-Codex', 272000],
  ['gemini-3.1-pro', 'Gemini-3.1-Pro', 400000],
  ['gemini-3.5-flash', 'Gemini-3.5-Flash', 1000000],
  ['glm-5.3', 'GLM-5.3', 1000000, ['low', 'high', 'max']],
  ['glm-5.2', 'GLM-5.2', 1000000, ['high', 'xhigh']],
  ['hy3', 'Hy3', 192000, ['low', 'high']],
  ['kimi-k3', 'Kimi-K3', 1000000],
  ['kimi-k2.6', 'Kimi-K2.6', 256000],
  ['minimax-m3', 'MiniMax-M3', 512000],
]

export const SITES: Record<Realm, SiteConfig> = {
  cn: {
    id: 'workbuddy',
    realm: 'cn',
    name: 'WorkBuddy',
    endpoint: 'https://copilot.tencent.com',
    platform: 'workbuddy',
    ai: false,
    app: '5.9.3',
    cli: '2.165.0',
    appName: 'WorkBuddy',
    runtime: 'local-agent',
    models: CN_MODELS,
    messages: true,
  },
  global: {
    id: 'workbuddy-ai',
    realm: 'global',
    name: 'WorkBuddy AI',
    endpoint: 'https://www.workbuddy.ai',
    platform: 'workbuddy-ai',
    ai: true,
    app: '5.9.3',
    cli: '2.165.0',
    appName: 'workbuddy-ai',
    runtime: 'local-agent',
    models: AI_MODELS,
    noImages: /^glm-/,
  },
}

export const OFF_TAKEN = new Set(['deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg'])
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']
const OPENAI_SDK = '6.25.0'
const NODE_RUNTIME = 'v22.21.1'
const SDK_OS: Record<string, string> = { darwin: 'MacOS', win32: 'Windows', linux: 'Linux', freebsd: 'FreeBSD', openbsd: 'OpenBSD', android: 'Android' }
const SDK_ARCH: Record<string, string> = { x64: 'x64', arm64: 'arm64', arm: 'arm', ia32: 'x32', x32: 'x32' }

export const hex = (): string => randomBytes(16).toString('hex')
export const textOnly = (site: SiteConfig, model: string): boolean => Boolean(site.noImages?.test(model))
export const domainOf = (site: SiteConfig, a: AccountIdentity): string => a.domain || new URL(`${site.endpoint}/v2`).host

export function enterpriseHeaders(a?: AccountIdentity): Record<string, string> {
  const id = typeof a?.enterpriseId === 'string' ? a.enterpriseId.trim() : ''
  return id ? { 'X-Enterprise-Id': id, 'X-Tenant-Id': id } : {}
}

export function cliAgent(site: SiteConfig): string {
  return `WorkBuddy/${site.app} ${site.appName}/${site.app} CLI/${site.cli}`
}

export function sign(site: SiteConfig, a: AccountIdentity, headers: Headers): void {
  headers.set('Authorization', `Bearer ${a.access}`)
  headers.set('X-User-Id', a.uid ?? '')
  if (a.source === 'key' && a.key) {
    headers.set('X-API-Key', a.key)
    headers.delete('X-Domain')
  } else {
    headers.delete('X-API-Key')
    headers.set('X-Domain', domainOf(site, a))
  }
  headers.set('X-Product', 'SaaS')
  headers.set('X-IDE-Type', 'WorkBuddy')
  headers.set('User-Agent', cliAgent(site))
  headers.set('X-Requested-With', 'XMLHttpRequest')
  headers.set('X-Agent-Intent', 'craft')
  headers.set('X-Agent-Purpose', 'conversation')
  headers.set('X-IDE-Name', 'WorkBuddy')
  headers.set('X-IDE-Version', site.app)
  for (const [k, v] of Object.entries(enterpriseHeaders(a))) headers.set(k, v)
}

export function chatHeaders(site: SiteConfig, headers: Headers): void {
  headers.set('X-Agent-Type', 'main')
  if (site.runtime) headers.set('X-Agent-Runtime', site.runtime)
  else headers.delete('X-Agent-Runtime')
  headers.set('Accept', 'application/json')
  headers.set('X-Stainless-Retry-Count', '0')
  headers.set('X-Stainless-Timeout', '1200')
  headers.set('X-Stainless-Lang', 'js')
  headers.set('X-Stainless-Package-Version', OPENAI_SDK)
  headers.set('X-Stainless-OS', SDK_OS[process.platform] ?? (process.platform ? `Other:${process.platform}` : 'Unknown'))
  headers.set('X-Stainless-Arch', SDK_ARCH[process.arch] ?? (process.arch ? `other:${process.arch}` : 'unknown'))
  headers.set('X-Stainless-Runtime', 'node')
  headers.set('X-Stainless-Runtime-Version', NODE_RUNTIME)
}

export function fallbackModels(site: SiteConfig): ModelSpec[] {
  return site.models.map(([id, name, context, efforts]) => ({
    id,
    name,
    context,
    images: !textOnly(site, id),
    ...(efforts ? { efforts: [...efforts] } : {}),
  }))
}

function effortsOf(d: Record<string, any>, site: SiteConfig, id: string): string[] {
  const said = d.reasoning?.supportedEfforts
  if (Array.isArray(said) && said.length) {
    if (site.messages && /^claude-/i.test(id) && !said.includes('max')) return [...said, 'max']
    return said
  }
  if (d.supportsReasoning !== true) return []
  const own = d.reasoning?.effort
  const set = new Set(['low', 'high', 'max', ...(typeof own === 'string' && EFFORT_ORDER.includes(own) ? [own] : [])])
  return EFFORT_ORDER.filter(e => set.has(e))
}

export function defaultEffortOf(d: Record<string, any>, efforts: string[]): string | undefined {
  const own = d.reasoning?.defaultEffort ?? d.reasoning?.effort
  return typeof own === 'string' && efforts.includes(own) ? own : undefined
}

export async function liveModels(site: SiteConfig, a: AccountIdentity): Promise<ModelSpec[]> {
  const headers = new Headers()
  sign(site, a, headers)
  headers.set('User-Agent', cliAgent(site))
  headers.set('X-Requested-With', 'XMLHttpRequest')
  headers.set('Accept', 'application/json')
  const res = await fetch(`${site.endpoint}/v3/config`, { headers, signal: AbortSignal.timeout(15000) })
  const env = await res.json().catch(() => ({})) as Record<string, any>
  if (!res.ok) throw new Error(`${site.name}'s config: HTTP ${res.status}`)
  if (env.code) throw new Error(`${site.name}'s config: ${env.msg} (${env.code})`)
  const cfg = env.data ?? {}
  const out: ModelSpec[] = []
  for (const agent of cfg.agents ?? []) {
    if (agent.name !== 'cli') continue
    for (const id of agent.models ?? []) {
      const d = (cfg.models ?? []).find((x: any) => x.id === id)
      const m: ModelSpec = { id, name: d?.name || id }
      if (d) {
        if (typeof d.maxInputTokens === 'number' && d.maxInputTokens > 0) m.context = d.maxInputTokens
        if (typeof d.maxOutputTokens === 'number' && d.maxOutputTokens > 0) m.output = d.maxOutputTokens
        m.images = d.supportsImages === true && !textOnly(site, id)
        const es = effortsOf(d, site, id)
        if (es.length) {
          const canOff = d.reasoning?.canDisableThinking
          const off = (!d.onlyReasoning && (canOff == null || canOff)) || OFF_TAKEN.has(id)
          m.efforts = [...(off ? ['none'] : []), ...es]
          const def = defaultEffortOf(d, es)
          if (def) m.effort = def
        }
      }
      out.push(m)
    }
  }
  const first = new Map<string, string>()
  for (const m of out) {
    const id = first.get(m.name)
    if (id === undefined) {
      first.set(m.name, m.id)
      continue
    }
    const rest = m.id.startsWith(`${id}-`) ? m.id.slice(id.length + 1) : ''
    m.name = `${m.name} (${rest ? rest.toUpperCase() : m.id})`
  }
  return out
}
