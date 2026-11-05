import type { AccountIdentity, Realm } from './sites.js'
import type { SignedInAccount } from './oauth.js'

const RECORD_KEY = 'workbuddy-manager/pool'
const SHARED_MODEL_WINDOWS: ReadonlyArray<readonly string[]> = [
  ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg'],
]

export interface PoolAccount extends AccountIdentity {
  id: string
  realm: Realm
  uid: string
  nickname: string
  note?: string
  disabled: boolean
  expired?: boolean
  restricted?: boolean
  coolingUntil?: number
  modelCooling?: Record<string, number>
  credits?: number | null
  creditsUpdatedAt?: number
  creditsError?: string
  cycleEnd?: string
  runsOutAt?: string
}

export interface AccountItem {
  file: string
  nickname: string
  note: string
  realm: Realm
  source?: string
  disabled: boolean
  blocked: boolean
  expired: boolean
  inPool: boolean
  cooling: boolean
  coolingModels?: string[]
  credits: number | null
  creditsUpdatedAt?: number
  creditsError?: string
  cycleEnd?: string
  runsOutAt?: string
}

export interface GatewaySwitchOptions {
  freeOnly: boolean
  hideDsh: boolean
}

export interface SelectCandidatesOptions {
  preferredRealm?: Realm
  allowedRealms?: ReadonlySet<Realm>
  model?: string
  advanceCursor?: boolean
}

interface StoredPayload {
  accounts?: PoolAccount[]
  gatewayPort?: number
  gatewayKeyRef?: string
  freeOnly?: boolean
  hideDsh?: boolean
}

export interface CredentialStoreLike {
  readRecord?(key: string): Promise<unknown>
  modifyRecord?(key: string, mutate: (current: unknown) => Promise<unknown> | unknown): Promise<unknown>
  deleteRecord?(key: string): Promise<void>
  describe?(refs: string[]): Promise<Record<string, { configured: boolean; writable: boolean }> | { configured: boolean; writable: boolean }>
  set?(ref: string, value: string): Promise<void>
  unset?(ref: string): Promise<void>
  resolve?(ref: string): Promise<{ value: string } | undefined>
}

export function sharedWindowModels(model: string): string[] {
  const m = model.trim()
  for (const group of SHARED_MODEL_WINDOWS) {
    if (group.includes(m)) return [...group]
  }
  return m ? [m] : []
}

export function isModelCooled(account: PoolAccount, model?: string, now = Date.now()): boolean {
  if (!model || !account.modelCooling) return false
  for (const m of sharedWindowModels(model)) {
    const until = account.modelCooling[m]
    if (typeof until === 'number' && until > now) return true
  }
  return false
}

function readPayload(record: unknown): StoredPayload {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {}
  const r = record as Record<string, any>
  const payload = r.kind === 'grant' && r.payload && typeof r.payload === 'object' ? r.payload : r
  return payload && typeof payload === 'object' ? payload as StoredPayload : {}
}

function writeEnvelope(payload: StoredPayload): Record<string, unknown> {
  return {
    kind: 'grant',
    payload: JSON.parse(JSON.stringify(payload)),
  }
}

export function accountIdOf(realm: Realm, uid: string, enterpriseId?: string): string {
  const safeUid = uid.replace(/[^A-Za-z0-9_.-]/g, '_') || 'user'
  const safeEnt = enterpriseId ? `-${enterpriseId.replace(/[^A-Za-z0-9_.-]/g, '_')}` : ''
  return `workbuddy-${realm}-${safeUid}${safeEnt}.json`
}

export function toAccountItem(account: PoolAccount, now = Date.now()): AccountItem {
  const cooling = Boolean(account.coolingUntil && account.coolingUntil > now)
  const coolingModels = account.modelCooling
    ? Object.entries(account.modelCooling).filter(([, until]) => typeof until === 'number' && until > now).map(([m]) => m)
    : []
  const blocked = Boolean(account.restricted)
  const expired = Boolean(account.expired)
  const hasAuth = Boolean(account.access || account.source === 'desktop')
  const inPool = !account.disabled && !blocked && !expired && hasAuth
  return {
    file: account.id,
    nickname: account.nickname || account.uid,
    note: account.note ?? '',
    realm: account.realm,
    ...(account.source ? { source: account.source } : {}),
    disabled: Boolean(account.disabled),
    blocked,
    expired,
    inPool,
    cooling,
    ...(coolingModels.length > 0 ? { coolingModels } : {}),
    credits: account.credits ?? null,
    ...(account.creditsUpdatedAt ? { creditsUpdatedAt: account.creditsUpdatedAt } : {}),
    ...(account.creditsError ? { creditsError: account.creditsError } : {}),
    ...(account.cycleEnd ? { cycleEnd: account.cycleEnd } : {}),
    ...(account.runsOutAt ? { runsOutAt: account.runsOutAt } : {}),
  }
}

export class AccountPoolStore {
  private memory: StoredPayload = {}
  private queue: Promise<unknown> = Promise.resolve()
  private cursor = 0
  private readonly inFlight = new Map<string, number>()

  constructor(private readonly credentials: () => CredentialStoreLike | undefined) {}

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn, fn)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async readState(): Promise<StoredPayload> {
    const store = this.credentials()
    if (!store?.readRecord) return structuredClone(this.memory)
    const raw = await store.readRecord(RECORD_KEY)
    if (raw === undefined || raw === null) {
      this.memory = {}
      return {}
    }
    const parsed = readPayload(raw)
    this.memory = structuredClone(parsed)
    return structuredClone(this.memory)
  }

  private async updateState(mutate: (state: StoredPayload) => Promise<void> | void): Promise<StoredPayload> {
    return this.runExclusive(async () => {
      const store = this.credentials()
      if (store?.modifyRecord) {
        let result: StoredPayload = {}
        await store.modifyRecord(RECORD_KEY, async current => {
          const state = current === undefined || current === null ? {} : readPayload(current)
          await mutate(state)
          this.memory = structuredClone(state)
          result = structuredClone(state)
          return writeEnvelope(state)
        })
        return result
      }
      const state = structuredClone(this.memory)
      await mutate(state)
      this.memory = structuredClone(state)
      return state
    })
  }

  async listAccounts(): Promise<PoolAccount[]> {
    const state = await this.readState()
    return Array.isArray(state.accounts) ? state.accounts : []
  }

  async getAccount(id: string): Promise<PoolAccount | undefined> {
    const accounts = await this.listAccounts()
    return accounts.find(a => a.id === id)
  }

  async listAccountItems(): Promise<AccountItem[]> {
    const accounts = await this.listAccounts()
    const now = Date.now()
    return accounts.map(a => toAccountItem(a, now))
  }

  async upsertSignedIn(signedIn: SignedInAccount, credits: number | null = null, extra?: Partial<PoolAccount>): Promise<PoolAccount> {
    const id = accountIdOf(signedIn.realm, signedIn.uid, signedIn.enterpriseId)
    let saved!: PoolAccount
    await this.updateState(state => {
      const list = Array.isArray(state.accounts) ? state.accounts : []
      const existing = list.find(a => a.id === id)
      saved = {
        ...existing,
        ...signedIn,
        ...extra,
        id,
        disabled: existing?.disabled ?? false,
        expired: false,
        restricted: false,
        coolingUntil: undefined,
        modelCooling: undefined,
        credits: credits ?? extra?.credits ?? existing?.credits ?? null,
      }
      const idx = list.findIndex(a => a.id === id)
      if (idx >= 0) list[idx] = saved
      else list.push(saved)
      state.accounts = list
    })
    return saved
  }

  async updateAccount(id: string, patch: Partial<PoolAccount>): Promise<PoolAccount | undefined> {
    let updated: PoolAccount | undefined
    await this.updateState(state => {
      const list = Array.isArray(state.accounts) ? state.accounts : []
      const idx = list.findIndex(a => a.id === id)
      if (idx < 0) return
      updated = { ...list[idx], ...patch, id }
      list[idx] = updated
      state.accounts = list
    })
    return updated
  }

  async coolModel(id: string, model: string, coolingUntil: number): Promise<PoolAccount | undefined> {
    const now = Date.now()
    return this.updateAccount(id, {
      modelCooling: await (async () => {
        const current = (await this.getAccount(id))?.modelCooling ?? {}
        const next: Record<string, number> = {}
        for (const [k, v] of Object.entries(current)) {
          if (typeof v === 'number' && v > now) next[k] = v
        }
        for (const m of sharedWindowModels(model)) next[m] = coolingUntil
        return next
      })(),
    })
  }

  async removeAccount(id: string): Promise<boolean> {
    let removed = false
    await this.updateState(state => {
      const list = Array.isArray(state.accounts) ? state.accounts : []
      const next = list.filter(a => a.id !== id)
      removed = next.length !== list.length
      state.accounts = next
    })
    return removed
  }

  async gatewayMeta(): Promise<{ port?: number; keyRef?: string }> {
    const state = await this.readState()
    return { port: state.gatewayPort, keyRef: state.gatewayKeyRef }
  }

  async saveGatewayMeta(port: number, keyRef: string): Promise<void> {
    await this.updateState(state => {
      state.gatewayPort = port
      state.gatewayKeyRef = keyRef
    })
  }

  async getGatewayOptions(): Promise<GatewaySwitchOptions> {
    const state = await this.readState()
    return {
      freeOnly: state.freeOnly === true,
      hideDsh: state.hideDsh !== false,
    }
  }

  async saveGatewayOptions(patch: Partial<GatewaySwitchOptions>): Promise<GatewaySwitchOptions> {
    const state = await this.updateState(s => {
      if (patch.freeOnly !== undefined) s.freeOnly = patch.freeOnly
      if (patch.hideDsh !== undefined) s.hideDsh = patch.hideDsh
    })
    return {
      freeOnly: state.freeOnly === true,
      hideDsh: state.hideDsh !== false,
    }
  }

  acquireInFlight(id: string): void {
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1)
  }

  releaseInFlight(id: string): void {
    const next = (this.inFlight.get(id) ?? 0) - 1
    if (next > 0) this.inFlight.set(id, next)
    else this.inFlight.delete(id)
  }

  inFlightCount(id: string): number {
    return this.inFlight.get(id) ?? 0
  }

  async selectCandidates(input?: Realm | SelectCandidatesOptions): Promise<PoolAccount[]> {
    const opts: SelectCandidatesOptions = typeof input === 'string' ? { preferredRealm: input } : (input ?? {})
    const accounts = await this.listAccounts()
    const now = Date.now()
    const eligible = accounts.filter(a => {
      if (a.disabled || a.expired || a.restricted) return false
      if (!(a.access || a.source === 'desktop')) return false
      if (a.coolingUntil && a.coolingUntil > now) return false
      if (isModelCooled(a, opts.model, now)) return false
      if (opts.allowedRealms && opts.allowedRealms.size > 0 && !opts.allowedRealms.has(a.realm)) return false
      return true
    })
    if (eligible.length === 0) return []
    const rawIndex = opts.advanceCursor === false ? this.cursor : this.cursor++
    const start = rawIndex % eligible.length
    const rotated = [...eligible.slice(start), ...eligible.slice(0, start)]
    const order = new Map<string, number>()
    rotated.forEach((a, idx) => order.set(a.id, idx))
    return [...rotated].sort((a, b) => {
      if (opts.preferredRealm) {
        const aPref = a.realm === opts.preferredRealm ? 0 : 1
        const bPref = b.realm === opts.preferredRealm ? 0 : 1
        if (aPref !== bPref) return aPref - bPref
      }
      const busyDiff = this.inFlightCount(a.id) - this.inFlightCount(b.id)
      if (busyDiff !== 0) return busyDiff
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    })
  }
}
