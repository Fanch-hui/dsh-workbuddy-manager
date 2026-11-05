import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ManagerRemote } from '../src/manager/service.js'
import { restoreManagement } from '../src/ui/management-session.js'

function credentialFixture() {
  const records = new Map<string, unknown>()
  return {
    records,
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, update: (value: unknown) => Promise<unknown>) => {
      const value = await update(records.get(key))
      records.set(key, value)
      return value
    },
    deleteRecord: async (key: string) => { records.delete(key) },
  }
}

test('管理会话跨宿主重启恢复、续期及退出', async t => {
  let logins = 0
  let expired = false
  let renew = false
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/healthz' || request.url === '/other/api/healthz') return response.end(JSON.stringify({ ok: true, service: 'workbuddy-manager' }))
    if (request.url === '/api/login') {
      logins += 1
      response.setHeader('set-cookie', 'wb_session=fixture-one; HttpOnly; Path=/')
      return response.end(JSON.stringify({ ok: true, role: 'admin' }))
    }
    if (expired || !['wb_session=fixture-one', 'wb_session=fixture-two'].includes(request.headers.cookie || '')) {
      response.statusCode = 401
      return response.end('{}')
    }
    if (request.url === '/api/me') {
      if (renew) { response.setHeader('set-cookie', 'wb_session=fixture-two; HttpOnly; Path=/'); renew = false }
      return response.end(JSON.stringify({ role: 'admin' }))
    }
    if (request.url === '/api/accounts') return response.end(JSON.stringify({ accounts: [], pool_available: true, manageable: true }))
    if (request.url === '/api/keys') return response.end('[]')
    return response.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => server.close(() => done())))
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const credentials = credentialFixture()
  const scopes: Array<{ dispose(): Promise<void> }> = []
  t.after(async () => { for (const scope of scopes) await scope.dispose() })
  const boot = async () => {
    const ctx = new Context()
    ctx.provide('credentials', credentials)
    const scope = ctx.plugin(ManagerRemote)
    await scope
    scopes.push(scope)
    return ctx.get('workbuddyManager') as ManagerRemote
  }

  const first = await boot()
  await first.manage({ action: 'login', address, username: 'fixture-user', password: 'fixture-password' })
  assert.equal(credentials.records.size, 1)
  const saved = JSON.stringify([...credentials.records.values()])
  assert.equal(saved.includes('fixture-user'), false)
  assert.equal(saved.includes('fixture-password'), false)
  await scopes[0].dispose()

  const restarted = await boot()
  let currentStatus: unknown
  const overview = await restoreManagement(request => restarted.manage(request), address, status => { currentStatus = status; return true })
  assert.deepEqual(currentStatus, { online: true, authenticated: true, role: 'admin' })
  assert.deepEqual(overview, { accounts: [], keys: [], poolAvailable: true, manageable: true })
  assert.equal(logins, 1)
  assert.deepEqual(await restarted.manage({ action: 'health', address: address.replace('/v1', '/other/v1') }), { online: true, authenticated: false })

  renew = true
  await restarted.manage({ action: 'health', address })
  await scopes[1].dispose()
  const afterRenewal = await boot()
  assert.deepEqual(await afterRenewal.manage({ action: 'health', address }), { online: true, authenticated: true, role: 'admin' })
  assert.match(JSON.stringify([...credentials.records.values()]), /fixture-two/)
  await afterRenewal.manage({ action: 'logout', address })
  assert.equal(credentials.records.size, 0)
  assert.deepEqual(await afterRenewal.manage({ action: 'health', address }), { online: true, authenticated: false })

  await afterRenewal.manage({ action: 'login', address, username: 'fixture-user', password: 'fixture-password' })
  expired = true
  assert.deepEqual(await afterRenewal.manage({ action: 'health', address }), { online: true, authenticated: false })
  assert.equal(credentials.records.size, 0)
})

test('恢复期间页面离开时不再加载旧地址的数据', async () => {
  const actions: string[] = []
  const result = await restoreManagement(async request => {
    actions.push(request.action)
    return { online: true, authenticated: true, role: 'admin' }
  }, 'http://127.0.0.1:7864/v1', () => false)
  assert.equal(result, undefined)
  assert.deepEqual(actions, ['health'])
})

test('未登录时不会请求管理数据', async () => {
  const actions: string[] = []
  const result = await restoreManagement(async request => {
    actions.push(request.action)
    return { online: true, authenticated: false }
  }, 'http://127.0.0.1:7864/v1', () => true)
  assert.equal(result, undefined)
  assert.deepEqual(actions, ['health'])
})
