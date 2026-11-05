import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtime = process.env.DSH_RUNTIME_ROOT
const root = fileURLToPath(new URL('../', import.meta.url))

test('桌面 RPC 路由随插件加载并连接管理服务', { skip: !runtime, timeout: 10000 }, async (t) => {
  const load = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
  const { Context } = await load('cordis')
  const { Loader } = await load('cordis-plugin-loader')
  const { TypertRegistry } = await load('dsh-typert-registry')
  const typertLoader = await load('dsh-typert-loader')
  const { TypertGatewayService } = await load('dsh-api-gateway')
  const { HostConnectionService } = await load('dsh-client-connection')

  let requests = 0
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/api/healthz') {
      response.writeHead(404).end()
      return
    }
    requests += 1
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, service: 'workbuddy-manager' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(root, 'package.json')).href
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) })
  const loader = ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
  const registry = ctx.plugin(TypertRegistry)
  const connection = ctx.plugin({
    name: 'fixture-connection',
    apply(context) { new HostConnectionService(context, [], {}) },
  })
  await Promise.all([loader, registry, connection])
  const typert = ctx.plugin(typertLoader, { packages: [] })
  const gateway = ctx.plugin(TypertGatewayService, TypertGatewayService.Config({}))
  await Promise.all([typert, gateway])
  t.after(async () => {
    await gateway.dispose()
    await typert.dispose()
    await loader.dispose()
    await registry.dispose()
    await connection.dispose()
  })

  const handler = ctx.connection.createSharedFetchHandler('/api')
  const request = () => new Request('http://127.0.0.1/api/workbuddy/manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'fixture',
      method: 'workbuddy/manage',
      payload: { args: { request: { action: 'health', address: `http://127.0.0.1:${server.address().port}` } } },
    }),
  })
  assert.equal((await handler.fetch(request(), ctx.connection.browserPeer)).status, 404)

  const registered = new Promise(resolve => {
    ctx.typert.local.subscribe(change => {
      if (change.key === 'workbuddy/manage' && ctx.typert.local.get(change.key)) resolve()
    })
  })
  await ctx.loader.create({ id: 'workbuddy-manager', name: 'dsh-workbuddy-manager' })
  await ctx.loader.await()
  await registered
  const response = await handler.fetch(request(), ctx.connection.browserPeer)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).result, { ok: true, value: { online: true, authenticated: false } })
  assert.equal(requests, 1)
})
