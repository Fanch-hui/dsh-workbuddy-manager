import { WorkbuddyError, WorkbuddyManagerClient } from './client.js'
import type { CliOptions } from './config.js'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

/** Diagnose the deployment without writing anything to it. */
export async function runDoctor(
  client: WorkbuddyManagerClient,
  options: CliOptions,
): Promise<CheckResult[]> {
  const checks = [
    await check('服务存活 /healthz', () => client.health()),
    await check('网关密钥 /v1/models', () => client.models()),
    await check('额度自查 /v1/usage', () => client.usage()),
  ]
  checks.push(options.apiToken
    ? await check('只读令牌 /api/me', () => client.me())
    : { name: '只读令牌 /api/me', ok: true, detail: '跳过：未配置 WORKBUDDY_MANAGER_READONLY_TOKEN' })
  return checks
}

async function check(name: string, run: () => Promise<unknown>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: summarize(await run()) }
  } catch (error) {
    if (error instanceof WorkbuddyError) return { name, ok: false, detail: `${error.code}: ${error.message}` }
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Report response shape only — upstream field values may contain account data. */
function summarize(value: unknown): string {
  if (Array.isArray(value)) return `返回数组（${value.length} 项）`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    const list = Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : undefined
    return `返回对象（字段: ${keys.slice(0, 8).join(', ') || '空'}${list ? `；data ${list.length} 项` : ''}）`
  }
  return `返回 ${typeof value}`
}
