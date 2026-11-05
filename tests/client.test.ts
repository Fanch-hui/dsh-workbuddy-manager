import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { WorkbuddyError, WorkbuddyManagerClient } from '../src/client.js'
import { CliError, parseArgs, type CliOptions } from '../src/config.js'
import { runDoctor } from '../src/doctor.js'
import { snapshot } from '../src/status.js'

interface Reply { status: number; body: string }
interface Recorded { path: string; auth?: string }

async function serve(handler: (path: string, auth?: string) => Reply) {
  const requests: Recorded[] = []
  const server = createServer((req, res) => {
    const auth = req.headers.authorization
    requests.push({ path: req.url ?? '', auth })
    const reply = handler(req.url ?? '', auth)
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(reply.body)
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>(ok => server.close(() => ok())),
  }
}

function client(
  baseURL: string,
  overrides: Partial<Pick<CliOptions, 'gatewayKey' | 'apiToken' | 'timeoutMs'>> = {},
) {
  return new WorkbuddyManagerClient({
    baseURL, timeoutMs: 3000, gatewayKey: 'wbk_test', apiToken: 'wbt_test', ...overrides,
  })
}

const ok = (body: unknown): Reply => ({ status: 200, body: JSON.stringify(body) })

test('healthz 不带鉴权，网关与管理面请求分别使用对应密钥', async t => {
  const server = await serve(() => ok({ data: [] }))
  t.after(server.close)
  const c = client(server.baseURL)
  await c.health()
  await c.models()
  await c.usage()
  await c.accounts()
  await c.credits()
  await c.me()
  assert.deepEqual(server.requests.map(r => r.path), [
    '/healthz', '/v1/models', '/v1/usage', '/api/accounts',
    '/api/accounts/credits-snapshot', '/api/me',
  ])
  assert.equal(server.requests[0].auth, undefined)
  assert.equal(server.requests[1].auth, 'Bearer wbk_test')
  assert.equal(server.requests[3].auth, 'Bearer wbt_test')
})

test('响应 JSON 被解析，非 JSON 响应保留原文', async t => {
  const server = await serve(path => path === '/healthz'
    ? { status: 200, body: 'plain text' }
    : ok({ data: [{ id: 'glm-5.2' }] }))
  t.after(server.close)
  assert.equal(await client(server.baseURL).health(), 'plain text')
  assert.deepEqual(await client(server.baseURL).models(), { data: [{ id: 'glm-5.2' }] })
})

test('缺少密钥时在发起请求前失败', async t => {
  const server = await serve(() => ok({}))
  t.after(server.close)
  const c = client(server.baseURL, { gatewayKey: undefined, apiToken: undefined })
  await assert.rejects(() => c.models(), (error: unknown) =>
    error instanceof WorkbuddyError && error.code === 'MISSING_CREDENTIAL')
  await assert.rejects(() => c.accounts(), (error: unknown) =>
    error instanceof WorkbuddyError && error.code === 'MISSING_CREDENTIAL')
  assert.equal(server.requests.length, 0)
})

test('HTTP 错误带状态码，且不回显密钥', async t => {
  const server = await serve(path => path === '/v1/models'
    ? { status: 401, body: '{"detail":"invalid key wbk_test"}' }
    : ok({}))
  t.after(server.close)
  await assert.rejects(
    () => client(server.baseURL).models(),
    (error: unknown) => error instanceof WorkbuddyError
      && error.code === 'HTTP_401' && !error.message.includes('wbk_test'),
  )
})

test('连接失败映射为 TRANSPORT', async () => {
  await assert.rejects(
    () => client('http://127.0.0.1:1', { timeoutMs: 1000 }).health(),
    (error: unknown) => error instanceof WorkbuddyError && error.code === 'TRANSPORT',
  )
})

test('status 聚合时单个端点失败不影响其它端点', async t => {
  const server = await serve(path => path === '/v1/models'
    ? { status: 500, body: '{}' }
    : ok({ healthy: true }))
  t.after(server.close)
  const result = await snapshot(client(server.baseURL))
  assert.deepEqual(result.health, { ok: true, data: { healthy: true } })
  assert.equal(result.models.ok, false)
  assert.match(result.models.error ?? '', /HTTP 500/)
  assert.deepEqual(result.usage, { ok: true, data: { healthy: true } })
})

test('doctor 报告每一项连通性与凭据状态', async t => {
  const server = await serve(() => ok({ data: [{ id: 'glm-5.2' }] }))
  t.after(server.close)
  const c = client(server.baseURL)
  const checks = await runDoctor(c, {
    baseURL: server.baseURL, gatewayKey: 'wbk_test', apiToken: 'wbt_test',
    timeoutMs: 3000, json: false,
  })
  assert.equal(checks.length, 4)
  assert.ok(checks.every(item => item.ok))
  assert.ok(checks[1].detail.includes('data 1 项'))
})

test('doctor 在缺少网关密钥时给出可执行的提示', async t => {
  const server = await serve(() => ok({}))
  t.after(server.close)
  const checks = await runDoctor(client(server.baseURL, { gatewayKey: undefined }), {
    baseURL: server.baseURL, apiToken: 'wbt_test', timeoutMs: 3000, json: false,
  })
  assert.equal(checks[1].ok, false)
  assert.match(checks[1].detail, /WORKBUDDY_MANAGER_API_KEY/)
})

test('命令行参数覆盖环境变量并归一化地址', () => {
  const invocation = parseArgs(
    ['models', '--url', 'http://127.0.0.1:9999/', '--json'],
    { WORKBUDDY_MANAGER_API_KEY: 'wbk_env', WORKBUDDY_MANAGER_URL: 'http://localhost:7864' },
  )
  assert.equal(invocation.command, 'models')
  assert.equal(invocation.options.baseURL, 'http://127.0.0.1:9999')
  assert.equal(invocation.options.gatewayKey, 'wbk_env')
  assert.equal(invocation.options.json, true)
  assert.equal(parseArgs(['--help']).help, true)
})

test('非法参数在加载阶段失败', () => {
  assert.throws(() => parseArgs(['models', '--url', 'ftp://example.com']), CliError)
  assert.throws(() => parseArgs(['nope']), CliError)
  assert.throws(() => parseArgs(['models', '--timeout']), CliError)
})
