import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ManagerRemote } from '../src/manager/service.js'
import { TYPERT, TYPERT_REMOTE } from '../src/manager/contract.js'

test('管理服务在宿主内完成扫码登录、账号池管理与本地网关启动', async t => {
  const requests: Array<{ path: string; method: string; headers: Record<string, string | string[] | undefined> }> = []
  let pollStep = 0
  let remainCredits = 128.5
  const server = createServer((req, res) => {
    requests.push({ path: req.url || '', method: req.method || '', headers: req.headers })
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/v2/plugin/auth/state')) {
      return res.end(JSON.stringify({
        code: 0,
        data: { state: 'fixture-state', authUrl: 'https://copilot.tencent.com/authorize?state=fixture-state' },
      }))
    }
    if (req.url?.startsWith('/v2/plugin/auth/token?state=fixture-state')) {
      pollStep++
      if (pollStep === 1) return res.end(JSON.stringify({ code: 0, data: {} }))
      return res.end(JSON.stringify({
        code: 0,
        data: {
          accessToken: 'fixture-access-secret',
          refreshToken: 'fixture-refresh-secret',
          domain: 'copilot.tencent.com',
          expiresIn: 3600,
        },
      }))
    }
    if (req.url?.startsWith('/v2/plugin/login/account?state=fixture-state')) {
      return res.end(JSON.stringify({
        code: 0,
        data: { uid: 'u-1001', nickname: '测试开发者', type: 'personal' },
      }))
    }
    if (req.url === '/billing/meter/get-user-resource-summary') {
      return res.end(JSON.stringify({
        code: 0,
        data: { Packages: [{ CycleRemainCapacity: remainCredits }] },
      }))
    }
    res.statusCode = 404
    return res.end('{}')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => server.close(() => done())))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const values = new Map<string, string>()
  const records = new Map<string, unknown>()
  const ctx = new Context()
  ctx.provide('credentials', {
    describe: async (ref: string) => ({ configured: values.has(ref), writable: true }),
    set: async (ref: string, value: string) => { values.set(ref, value) },
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, update: (value: unknown) => Promise<unknown>) => {
      const value = await update(records.get(key))
      records.set(key, value)
      return value
    },
    deleteRecord: async (key: string) => { records.delete(key) },
  })
  const scope = ctx.plugin(ManagerRemote, { sites: { cn: { endpoint }, global: { endpoint } } })
  await scope
  t.after(() => scope.dispose())

  const service = ctx.get('workbuddyManager') as ManagerRemote
  assert.equal(remoteMethods(service)[0].method, 'manage')
  assert.equal(TYPERT_REMOTE.descriptors[0].id, 'dsh-workbuddy-manager#workbuddy/manage')
  assert.equal(TYPERT.invocations.length, 1)

  const initialHealth = await service.manage({ action: 'health' }) as { online: boolean; gatewayURL: string; poolAvailable: boolean; accountCount: number }
  assert.equal(initialHealth.online, true)
  assert.match(initialHealth.gatewayURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.equal(initialHealth.poolAvailable, false)
  assert.equal(initialHealth.accountCount, 0)

  const started = await service.manage({ action: 'authStart', realm: 'cn' }) as { authUrl: string }
  assert.match(started.authUrl, /^https:\/\/copilot\.tencent\.com\/authorize\?state=fixture-state&version=5\.9\.3&loginSessionId=[0-9a-f]{32}$/)

  assert.deepEqual(await service.manage({ action: 'authPoll' }), { status: 'pending' })
  const finished = await service.manage({ action: 'authPoll' }) as { status: string; account: { file: string; nickname: string; credits: number } }
  assert.equal(finished.status, 'success')
  assert.equal(finished.account.file, 'workbuddy-cn-u-1001.json')
  assert.equal(finished.account.nickname, '测试开发者')
  assert.equal(finished.account.credits, 128.5)

  const overview = await service.manage({ action: 'overview' }) as { accounts: Array<{ file: string; disabled: boolean; inPool: boolean; credits: number }>; poolAvailable: boolean }
  assert.equal(JSON.stringify(overview).includes('fixture-access-secret'), false)
  assert.equal(JSON.stringify(overview).includes('fixture-refresh-secret'), false)
  assert.equal(overview.poolAvailable, true)
  assert.equal(overview.accounts.length, 1)
  assert.equal(overview.accounts[0].inPool, true)

  await service.manage({ action: 'accountDisabled', file: 'workbuddy-cn-u-1001.json', disabled: true })
  const disabledOverview = await service.manage({ action: 'overview' }) as { accounts: Array<{ disabled: boolean; inPool: boolean }>; poolAvailable: boolean }
  assert.equal(disabledOverview.poolAvailable, false)
  assert.equal(disabledOverview.accounts[0].disabled, true)

  await service.manage({ action: 'accountDisabled', file: 'workbuddy-cn-u-1001.json', disabled: false })
  remainCredits = 96.25
  await service.manage({ action: 'accountRefresh', file: 'workbuddy-cn-u-1001.json' })
  const refreshedOverview = await service.manage({ action: 'overview' }) as { accounts: Array<{ credits: number; inPool: boolean }> }
  assert.equal(refreshedOverview.accounts[0].credits, 96.25)
  assert.equal(refreshedOverview.accounts[0].inPool, true)

  await service.manage({ action: 'accountDelete', file: 'workbuddy-cn-u-1001.json' })
  const emptyOverview = await service.manage({ action: 'overview' }) as { accounts: unknown[]; poolAvailable: boolean }
  assert.deepEqual(emptyOverview.accounts, [])
  assert.equal(emptyOverview.poolAvailable, false)
})

test('管理服务拒绝非法参数与非所有者调用', async () => {
  const ctx = new Context()
  const scope = ctx.plugin(ManagerRemote)
  await scope
  try {
    const service = ctx.get('workbuddyManager') as ManagerRemote
    await assert.rejects(service.manage({ action: 'accountDisabled', file: '../config', disabled: true }), /请求格式无效/)
    await assert.rejects(service.manage({ action: 'accountDelete', file: 'other.json' }), /请求格式无效/)
    const nonOwner = ctx.extend({ invocation: { peer: { principal: { kind: 'guest', id: 'fixture' } } } }).get('workbuddyManager') as ManagerRemote
    await assert.rejects(nonOwner.manage({ action: 'health' }), /只有 DSH 所有者/)
  } finally {
    await scope.dispose()
  }
})
