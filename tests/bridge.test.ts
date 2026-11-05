import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ManagerRemote } from '../src/manager/service.js'
import { connectBridge, type BridgeRemote } from '../src/ui/bridge-connection.js'
import { BRIDGE_PROVIDER, bridgeManagementURL, bridgeURL, managementURL } from '../src/address.js'
import { targetURL } from '../src/ui/panel.js'
import type { Connection } from '../src/ui/connection.js'

const ok = <T>(value: T) => ({ ok: true as const, value })

test('登录后自动桥接账号池，保留已有提供方且不创建网关密钥', async t => {
  const paths: string[] = []
  let grants = 0
  let expired = false
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/login') {
      response.setHeader('set-cookie', 'wb_session=fixture-session; HttpOnly; Path=/')
      return response.end(JSON.stringify({ ok: true, role: 'admin' }))
    }
    if (request.url === '/api/dsh/session') {
      if (expired || request.headers.cookie !== 'wb_session=fixture-session') { response.statusCode = 401; return response.end('{}') }
      grants++
      return response.end(JSON.stringify({ token: 'fixture-model-grant' }))
    }
    if (request.url === '/api/dsh/v1/models') {
      if (request.headers.authorization !== 'Bearer fixture-model-grant') { response.statusCode = 401; return response.end('{}') }
      return response.end(JSON.stringify({ data: [{ id: 'fixture-model', name: 'Fixture model' }] }))
    }
    if (request.url === '/api/logout') return response.end('{}')
    response.statusCode = 404
    return response.end('{}')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => server.close(() => done())))
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const values = new Map<string, string>()
  const records = new Map<string, unknown>()
  const ctx = new Context()
  ctx.provide('credentials', {
    describe: async (ref: string) => ({ configured: values.has(ref), writable: true }),
    set: async (ref: string, value: string) => { values.set(ref, value) },
    unset: async (ref: string) => { values.delete(ref) },
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, update: (current: unknown) => Promise<unknown>) => { const value = await update(records.get(key)); records.set(key, value); return value },
    deleteRecord: async (key: string) => { records.delete(key) },
  })
  const scope = ctx.plugin(ManagerRemote)
  await scope
  t.after(() => scope.dispose())
  const manager = ctx.get('workbuddyManager') as ManagerRemote
  await manager.manage({ action: 'login', address, username: 'fixture', password: 'fixture-password' })

  let revision = 1
  let providers: Record<string, any> = {
    'workbuddy-manager': { baseURL: address, api: 'openai-responses', apiKeyEnv: 'LEGACY_KEY', models: [{ id: 'legacy-model' }] },
    other: { baseURL: 'https://other.example/v1', models: [{ id: 'other-model' }] },
  }
  const remote: BridgeRemote = {
    settings: {
      describe: async () => ok({ writable: true, namespaces: [{ ns: 'llm-pi-ai', value: { providers: structuredClone(providers) }, revision }] }),
      mutate: async (ns, operations, expected) => {
        if (revision !== expected) return { ok: false, error: { code: 'settings/conflict', message: 'stale' } }
        for (const operation of operations) {
          const [, id, field] = operation.path
          if (field) providers[id] = { ...providers[id], [field]: operation.value }
          else providers[id] = operation.value
        }
        return ok({ ns, value: { providers }, revision: ++revision })
      },
    },
    credentials: {
      describe: async refs => ok(Object.fromEntries(refs.map(ref => [ref, { configured: values.has(ref), writable: true }]))),
      set: async (ref, value) => { values.set(ref, value); return ok(undefined) },
      unset: async ref => { values.delete(ref); return ok(undefined) },
    },
    llm: {
      discoverModels: async (_ns, request) => {
        const provider = providers[request.provider!]
        const response = await fetch(`${request.baseURL}/models`, { headers: { authorization: `Bearer ${values.get(provider.apiKeyEnv)}` } })
        if (!response.ok) return { ok: false, error: { message: `HTTP ${response.status}` } }
        const body = await response.json() as { data: Array<{ id: string; name: string }> }
        return ok(body.data)
      },
    },
    workbuddy: {
      manage: async request => {
        try { return ok(await manager.manage(request)) }
        catch (error) { return { ok: false, error: { message: (error as Error).message } } }
      },
    },
  }
  assert.equal(await connectBridge(remote, address, () => true), 1)
  const provider = providers[BRIDGE_PROVIDER]
  assert.equal(provider.baseURL, bridgeURL(address))
  assert.match(provider.apiKeyEnv, /^WORKBUDDY_MANAGER_BRIDGE_[A-F0-9]{32}$/)
  assert.equal(values.get(provider.apiKeyEnv), 'fixture-model-grant')
  assert.deepEqual(provider.models, [{ id: 'fixture-model', name: 'Fixture model' }])
  assert.equal(JSON.stringify(providers).includes('fixture-model-grant'), false)
  assert.deepEqual(providers['workbuddy-manager'].models, [{ id: 'legacy-model' }])
  assert.deepEqual(providers.other.models, [{ id: 'other-model' }])
  assert.equal(paths.some(path => path.startsWith('POST /api/keys')), false)
  assert.equal(await connectBridge(remote, address, () => true), 1)
  assert.equal(grants, 2)
  const now = Date.now
  try {
    Date.now = () => now() + 61_000
    const headers = new Headers()
    const waterfall = ctx.waterfall as unknown as (...args: unknown[]) => unknown
    assert.equal(waterfall.call(ctx, 'llm-pi-ai/request-headers', { provider: BRIDGE_PROVIDER, baseURL: bridgeURL(address) }, headers, () => headers), headers)
    await manager.manage({ action: 'bridge', address })
    assert.equal(grants, 4)
  } finally { Date.now = now }
  let active = true
  const before = revision
  const interrupted: BridgeRemote = { ...remote, workbuddy: { manage: async request => {
    const answer = await remote.workbuddy.manage(request)
    active = false
    return answer
  } } }
  assert.equal(await connectBridge(interrupted, address, () => active), undefined)
  assert.equal(revision, before)
  expired = true
  await assert.rejects(manager.manage({ action: 'bridge', address }), /登录已失效/)
  assert.equal(values.has(provider.apiKeyEnv), false)
  assert.equal(records.size, 0)
  await manager.manage({ action: 'logout', address })
})

test('桥接地址保持反向代理前缀且限制远程明文连接', () => {
  assert.equal(bridgeURL('https://example.test/wb/v1'), 'https://example.test/wb/api/dsh/v1')
  assert.equal(bridgeManagementURL('https://example.test/wb/api/dsh/v1'), 'https://example.test/wb')
  assert.equal(managementURL('https://example.test/api/dsh/v1'), 'https://example.test/api/dsh')
  assert.equal(bridgeURL('https://example.test/api/dsh/v1'), 'https://example.test/api/dsh/api/dsh/v1')
  assert.throws(() => bridgeURL('http://example.test/v1'), /HTTPS/)
  const connection = { providerId: BRIDGE_PROVIDER, url: 'https://example.test/wb/api/dsh/v1' } as Connection
  assert.equal(targetURL(connection, 'https://example.test/wb'), 'https://example.test/wb/api/dsh/v1')
  assert.throws(() => targetURL(connection, 'https://other.example/wb'), /先登录新的账号池地址/)
})
