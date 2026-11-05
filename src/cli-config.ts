export interface CliOptions {
  baseURL: string
  gatewayKey?: string
  apiToken?: string
  timeoutMs: number
  json: boolean
}

export interface CliInvocation {
  command: string
  options: CliOptions
  help: boolean
}

export const COMMANDS = [
  'doctor', 'status', 'models', 'usage', 'me', 'accounts', 'credits',
] as const

const DEFAULT_BASE_URL = 'http://127.0.0.1:7864'
const DEFAULT_TIMEOUT_MS = 10_000

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

/** Connection settings come from one place: the environment, overridden by flags. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliInvocation {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : ''
  const flags = command ? argv.slice(1) : argv
  let baseURL = env.WORKBUDDY_MANAGER_URL ?? DEFAULT_BASE_URL
  let gatewayKey = env.WORKBUDDY_MANAGER_API_KEY
  let apiToken = env.WORKBUDDY_MANAGER_READONLY_TOKEN
  let timeoutMs = Number(env.WORKBUDDY_MANAGER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  let json = false
  let help = false

  for (let i = 0; i < flags.length; i += 1) {
    const [flag, inline] = splitFlag(flags[i])
    switch (flag) {
      case '-h':
      case '--help':
        help = true
        break
      case '--json':
        json = true
        break
      case '--url':
        baseURL = inline ?? takeValue(flags, ++i, flag)
        break
      case '--gateway-key':
        gatewayKey = inline ?? takeValue(flags, ++i, flag)
        break
      case '--api-token':
        apiToken = inline ?? takeValue(flags, ++i, flag)
        break
      case '--timeout':
        timeoutMs = Number(inline ?? takeValue(flags, ++i, flag))
        break
      default:
        throw new CliError(`未知参数：${flag}\n${HELP_TEXT}`)
    }
  }

  if (help) return { command, options: defaults(), help: true }
  if (!command) return { command: '', options: defaults(), help: true }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new CliError(`未知命令：${command}\n${HELP_TEXT}`)
  }

  let normalizedURL: string
  try {
    const url = new URL(baseURL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('only http/https are supported')
    }
    normalizedURL = url.toString().replace(/\/+$/, '')
  } catch {
    throw new CliError(`无效的服务地址：${baseURL}`)
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new CliError(`超时时间必须在 1000–600000 毫秒之间：${timeoutMs}`)
  }
  return {
    command,
    options: { baseURL: normalizedURL, gatewayKey, apiToken, timeoutMs, json },
    help: false,
  }
}

function defaults(): CliOptions {
  return { baseURL: DEFAULT_BASE_URL, timeoutMs: DEFAULT_TIMEOUT_MS, json: false }
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=')
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)]
}

function takeValue(flags: string[], index: number, flag: string): string {
  const value = flags[index]
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`参数 ${flag} 缺少取值`)
  }
  return value
}

export const HELP_TEXT = `dsh-workbuddy — WorkBuddy Manager 只读运维工具

用法:
  dsh-workbuddy <命令> [--url <地址>] [--gateway-key <wbk_...>]
                [--api-token <wbt_...>] [--timeout <毫秒>] [--json]

命令:
  doctor     逐项检查服务存活、网关密钥、额度自查与只读令牌
  status     聚合 healthz / models / usage 的状态快照
  models     GET /v1/models           （网关密钥）
  usage      GET /v1/usage            （网关密钥）
  me         GET /api/me              （只读令牌）
  accounts   GET /api/accounts        （只读令牌）
  credits    GET /api/accounts/credits-snapshot（只读令牌）

环境变量（命令行参数优先）:
  WORKBUDDY_MANAGER_URL              服务根地址，默认 http://127.0.0.1:7864
  WORKBUDDY_MANAGER_API_KEY          网关密钥 wbk_...，与 DSH 的 apiKeyEnv 同名
  WORKBUDDY_MANAGER_READONLY_TOKEN   管理面只读令牌 wbt_...
  WORKBUDDY_MANAGER_TIMEOUT_MS       单次请求超时，默认 10000

说明:
  本工具只读，不做扫码纳管、签到、账号增删或密钥管理。
  仅用于管理本人及亲属自愿授权的账号；禁止批量注册、账号交易、
  绕过平台风控以及任何商业转售用途。密钥不会写入日志或输出。
`
