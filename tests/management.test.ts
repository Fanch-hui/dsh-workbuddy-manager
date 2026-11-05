import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ManagerRemote } from '../src/manager/service.js'
import { TYPERT, TYPERT_REMOTE } from '../src/manager/contract.js'

const fakeRef = `WORKBUDDY_MANAGER_KEY_${'A'.repeat(32)}`

test('管理服务在宿主内登录、操作账号并安全绑定密钥', async t => {
  const requests: Array<{ path: string; method: string; cookie?: string; body?: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined
    requests.push({ path: req.url || '', method: req.method || '', cookie: req.headers.cookie, body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/healthz') return res.end(JSON.stringify({ ok: true, service: 'workbuddy-manager' }))
    if (req.url === '/api/login') {
      res.setHeader('set-cookie', 'wb_session=fixture-session; HttpOnly; Path=/')
      return res.end(JSON.stringify({ ok: true, role: 'admin' }))
    }
    if (req.headers.cookie !== 'wb_session=fixture-session') { res.statusCode = 401; return res.end('{}') }
    if (req.url === '/api/me') return res.end(JSON.stringify({ role: 'admin' }))
    if (req.url === '/api/accounts') return res.end(JSON.stringify({ pool_available: true, manageable: true, accounts: [{ file: 'workbuddy-fixture.json', nickname: '测试账号', realm: 'cn', manual_disabled: false, access_token: 'fixture-account-secret' }] }))
    if (req.url === '/api/keys' && req.method === 'GET') return res.end(JSON.stringify([{ id: 7, name: '测试密钥', enabled: true, prefix: 'fixture-prefix', used_tokens: 3 }]))
    if (req.url === '/api/keys' && req.method === 'POST') return res.end(JSON.stringify({ id: 8, key: 'fixture-created-secret' }))
    if (req.url === '/api/keys/7/reveal') return res.end(JSON.stringify({ key: 'fixture-gateway-secret' }))
    if (req.url === '/api/auth/start') return res.end(JSON.stringify({ state: 'fixture-private-state', authUrl: 'https://example.test/authorize', realm: 'cn' }))
    if (req.url?.startsWith('/api/auth/poll?')) return res.end(JSON.stringify({ status: 'success', uid: 'fixture-private-uid' }))
    return res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => server.close(() => done())))
  const port = (server.address() as { port: number }).port
  const address = `http://127.0.0.1:${port}/v1`
  const values = new Map<string, string>()
  const ctx = new Context()
  ctx.provide('credentials', {
    describe: async (ref: string) => ({ configured: values.has(ref), writable: true }),
    set: async (ref: string, value: string) => { values.set(ref, value) },
  })
  const scope = ctx.plugin(ManagerRemote)
  await scope
  t.after(() => scope.dispose())
  const service = ctx.get('workbuddyManager') as ManagerRemote
  assert.equal(remoteMethods(service)[0].method, 'manage')
  assert.equal(TYPERT_REMOTE.descriptors[0].id, 'dsh-workbuddy-manager#workbuddy/manage')
  assert.equal(TYPERT.invocations.length, 1)
  assert.deepEqual(await service.manage({ action: 'health', address }), { online: true, authenticated: false })
  assert.deepEqual(await service.manage({ action: 'login', address, username: 'fixture', password: 'fixture-password' }), { ok: true, role: 'admin' })
  assert.deepEqual(await service.manage({ action: 'health', address }), { online: true, authenticated: true, role: 'admin' })
  const overview = await service.manage({ action: 'overview', address })
  assert.equal(JSON.stringify(overview).includes('fixture-account-secret'), false)
  assert.equal(JSON.stringify(overview).includes('fixture-prefix'), false)
  assert.deepEqual((overview as { accounts: unknown[] }).accounts, [{ file: 'workbuddy-fixture.json', nickname: '测试账号', realm: 'cn', disabled: false, blocked: false, expired: false, inPool: false, cooling: false, credits: null }])
  await service.manage({ action: 'accountDisabled', address, file: 'workbuddy-fixture.json', disabled: true })
  assert.deepEqual(requests.at(-1)?.body, { disabled: true })
  assert.deepEqual(await service.manage({ action: 'createKey', address, name: '测试密钥', realm: 'global' }), { ok: true })
  assert.deepEqual(requests.at(-1)?.body, { name: '测试密钥', realm: 'global' })
  assert.deepEqual(await service.manage({ action: 'useKey', address, id: 7, ref: fakeRef }), { ok: true })
  assert.equal(values.get(fakeRef), 'fixture-gateway-secret')
  await assert.rejects(service.manage({ action: 'useKey', address, id: 7, ref: fakeRef }), /已被占用/)
  assert.deepEqual(await service.manage({ action: 'authStart', address, realm: 'cn', region: '' }), { authUrl: 'https://example.test/authorize' })
  assert.deepEqual(await service.manage({ action: 'authPoll', address }), { status: 'success' })
  assert.ok(requests.at(-1)?.path.includes('state=fixture-private-state'))
  await service.manage({ action: 'logout', address })
  await assert.rejects(service.manage({ action: 'overview', address }), /请先登录/)
})

test('登录拒绝重定向且错误不回显密码', async t => {
  let followed = false
  const server = createServer((req, res) => {
    if (req.url === '/api/login') { res.writeHead(302, { location: '/sink' }); res.end(); return }
    followed = true
    res.end('{}')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => server.close(() => done())))
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const ctx = new Context()
  const scope = ctx.plugin(ManagerRemote)
  await scope
  t.after(() => scope.dispose())
  const service = ctx.get('workbuddyManager') as ManagerRemote
  await assert.rejects(service.manage({ action: 'login', address, username: 'fixture', password: 'fixture-password' }), error => {
    assert.equal((error as Error).message.includes('fixture-password'), false)
    return true
  })
  assert.equal(followed, false)
})

test('管理服务拒绝危险地址和未授权操作', async () => {
  const ctx = new Context()
  const scope = ctx.plugin(ManagerRemote)
  await scope
  try {
    const service = ctx.get('workbuddyManager') as ManagerRemote
    await assert.rejects(service.manage({ action: 'health', address: 'http://example.test/v1' }), /地址无效/)
    await assert.rejects(service.manage({ action: 'accountDisabled', address: 'http://localhost:7864/v1', file: '../config', disabled: true }), /请求格式无效/)
    await assert.rejects(service.manage({ action: 'useKey', address: 'http://localhost:7864/v1', id: 1, ref: 'OTHER_SERVICE_API_KEY' }), /请求格式无效/)
    const nonOwner = ctx.extend({ invocation: { peer: { principal: { kind: 'guest', id: 'fixture' } } } }).get('workbuddyManager') as ManagerRemote
    await assert.rejects(nonOwner.manage({ action: 'health', address: 'http://localhost:7864/v1' }), /只有 DSH 所有者/)
  } finally { await scope.dispose() }
})
