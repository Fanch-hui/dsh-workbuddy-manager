import { createHash } from 'node:crypto'

type StoredRecord = { kind: 'grant'; payload: { version: 1; session: string } }
export interface SessionCredentials {
  readRecord(key: string): Promise<unknown>
  modifyRecord(key: string, update: (current: unknown) => Promise<StoredRecord>): Promise<unknown>
  deleteRecord(key: string): Promise<void>
}

function keyFor(base: string): string {
  const digest = createHash('sha256').update(base).digest('hex')
  return `dsh-workbuddy-manager/session-${digest}`
}

export function validSession(value: unknown): value is string {
  return typeof value === 'string' && /^wb_session=[\x21-\x3a\x3c-\x7e]{1,4096}$/.test(value)
}

/** Store each management session in the host credential provider, never in client state. */
export class SessionStore {
  constructor(private readonly credentials: () => SessionCredentials | undefined) {}

  private provider(): SessionCredentials {
    const provider = this.credentials()
    if (!provider?.readRecord || !provider.modifyRecord || !provider.deleteRecord) throw new Error('DSH 凭据存储不可用，无法保存管理会话。')
    return provider
  }

  async read(base: string): Promise<string | undefined> {
    const provider = this.provider()
    let record: unknown
    try { record = await provider.readRecord(keyFor(base)) } catch { throw new Error('无法读取已保存的管理会话。') }
    if (record === undefined) return undefined
    if (typeof record === 'object' && record !== null && 'kind' in record && record.kind === 'grant' && 'payload' in record) {
      const payload = record.payload
      if (typeof payload === 'object' && payload !== null && 'version' in payload && payload.version === 1 && 'session' in payload && validSession(payload.session)) return payload.session
    }
    throw new Error('已保存的管理会话格式无效，请检查 DSH 凭据存储。')
  }

  async save(base: string, session: string): Promise<void> {
    if (!validSession(session)) throw new Error('管理服务返回的会话格式无效。')
    const provider = this.provider()
    const record: StoredRecord = { kind: 'grant', payload: { version: 1, session } }
    try { await provider.modifyRecord(keyFor(base), async () => record) } catch { throw new Error('无法保存管理会话，请检查 DSH 凭据存储。') }
  }

  async clear(base: string): Promise<void> {
    const provider = this.provider()
    try { await provider.deleteRecord(keyFor(base)) } catch { throw new Error('无法清除已保存的管理会话。') }
  }
}
