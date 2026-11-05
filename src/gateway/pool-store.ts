import type { AccountIdentity, Realm } from './sites.js'
import type { SignedInAccount } from './oauth.js'

const RECORD_KEY = 'workbuddy-manager/pool'

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
  credits?: number | null
}

export interface AccountItem {
  file: string
  nickname: string
  note: string
  realm: Realm
  disabled: boolean
  blocked: boolean
  expired: boolean
  inPool: boolean
  cooling: boolean
  credits: number | null
}

interface StoredPayload {
  accounts?: PoolAccount[]
  gatewayPort?: number
  gatewayKeyRef?: string
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
  const blocked = Boolean(account.restricted)
  const expired = Boolean(account.expired)
  const inPool = !account.disabled && !blocked && !expired && Boolean(account.access)
  return {
    file: account.id,
    nickname: account.nickname || account.uid,
    note: account.note ?? '',
    realm: account.realm,
    disabled: Boolean(account.disabled),
    blocked,
    expired,
    inPool,
    cooling,
    credits: account.credits ?? null,
  }
}

export class AccountPoolStore {
  private memory: StoredPayload = {}
  private queue: Promise<unknown> = Promise.resolve()
  private cursor = 0

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
    const parsed = readPayload(raw)
    if (Array.isArray(parsed.accounts) || parsed.gatewayPort || parsed.gatewayKeyRef) {
      this.memory = structuredClone(parsed)
    }
    return structuredClone(this.memory)
  }

  private async updateState(mutate: (state: StoredPayload) => Promise<void> | void): Promise<StoredPayload> {
    return this.runExclusive(async () => {
      const store = this.credentials()
      if (store?.modifyRecord) {
        let result: StoredPayload = {}
        await store.modifyRecord(RECORD_KEY, async current => {
          const state = readPayload(current)
          if (!Array.isArray(state.accounts) && Array.isArray(this.memory.accounts)) {
            Object.assign(state, structuredClone(this.memory))
          }
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

  async listAccountItems(): Promise<AccountItem[]> {
    const accounts = await this.listAccounts()
    const now = Date.now()
    return accounts.map(a => toAccountItem(a, now))
  }

  async upsertSignedIn(signedIn: SignedInAccount, credits: number | null = null): Promise<PoolAccount> {
    const id = accountIdOf(signedIn.realm, signedIn.uid, signedIn.enterpriseId)
    let saved!: PoolAccount
    await this.updateState(state => {
      const list = Array.isArray(state.accounts) ? state.accounts : []
      const existing = list.find(a => a.id === id)
      saved = {
        ...existing,
        ...signedIn,
        id,
        disabled: existing?.disabled ?? false,
        expired: false,
        restricted: false,
        coolingUntil: undefined,
        credits: credits ?? existing?.credits ?? null,
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

  async selectCandidates(preferredRealm?: Realm): Promise<PoolAccount[]> {
    const accounts = await this.listAccounts()
    const now = Date.now()
    const eligible = accounts.filter(
      a => !a.disabled && !a.expired && !a.restricted && !(a.coolingUntil && a.coolingUntil > now) && Boolean(a.access),
    )
    if (eligible.length === 0) return []
    const start = this.cursor++ % eligible.length
    const rotated = [...eligible.slice(start), ...eligible.slice(0, start)]
    if (!preferredRealm) return rotated
    return [
      ...rotated.filter(a => a.realm === preferredRealm),
      ...rotated.filter(a => a.realm !== preferredRealm),
    ]
  }
}
