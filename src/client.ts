import type { CliOptions } from './config.js'

export class WorkbuddyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'WorkbuddyError'
  }
}

export type AuthKind = 'gateway' | 'api' | 'none'

interface RequestSpec {
  path: string
  auth: AuthKind
}

type ClientOptions = Pick<CliOptions, 'baseURL' | 'gatewayKey' | 'apiToken' | 'timeoutMs'>

/** Read-only HTTP client for a deployed WorkBuddy Manager instance. */
export class WorkbuddyManagerClient {
  constructor(private readonly options: ClientOptions) {}

  health(): Promise<unknown> {
    return this.get({ path: '/healthz', auth: 'none' })
  }

  models(): Promise<unknown> {
    return this.get({ path: '/v1/models', auth: 'gateway' })
  }

  usage(): Promise<unknown> {
    return this.get({ path: '/v1/usage', auth: 'gateway' })
  }

  me(): Promise<unknown> {
    return this.get({ path: '/api/me', auth: 'api' })
  }

  accounts(): Promise<unknown> {
    return this.get({ path: '/api/accounts', auth: 'api' })
  }

  credits(): Promise<unknown> {
    return this.get({ path: '/api/accounts/credits-snapshot', auth: 'api' })
  }

  private async get(spec: RequestSpec): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = this.tokenFor(spec.auth)
    if (token) headers.authorization = `Bearer ${token}`

    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}${spec.path}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new WorkbuddyError('TRANSPORT', `${spec.path} 请求失败：${reason}`)
    }

    const body = await response.text()
    if (!response.ok) {
      const detail = truncate(redact(body, [this.options.gatewayKey, this.options.apiToken]))
      throw new WorkbuddyError(
        `HTTP_${response.status}`,
        `${spec.path} 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      )
    }
    try {
      return JSON.parse(body) as unknown
    } catch {
      return body
    }
  }

  private tokenFor(auth: AuthKind): string | undefined {
    if (auth === 'none') return undefined
    const key = auth === 'gateway' ? this.options.gatewayKey : this.options.apiToken
    const variable = auth === 'gateway'
      ? 'WORKBUDDY_MANAGER_API_KEY'
      : 'WORKBUDDY_MANAGER_READONLY_TOKEN'
    if (!key) {
      throw new WorkbuddyError('MISSING_CREDENTIAL', `缺少${auth === 'gateway' ? '网关密钥' : '只读令牌'}，请设置 ${variable}`)
    }
    return key
  }
}

/** A gateway error body may echo the submitted key; never surface it. */
function redact(text: string, secrets: Array<string | undefined>): string {
  let result = text
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[redacted]')
  }
  return result
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}
