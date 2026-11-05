import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { loadConnection, sync } from '../lib/ui/connection.js'
import { connectBridge } from '../lib/ui/bridge-connection.js'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
const root = resolve(import.meta.dirname, '..')
const ok = value => ({ ok: true, value })

// Electron's Node mode reads the desktop app's asar and actual pi-ai runtime.
test('桌面宿主同步真实模型发现并驱动内置本地网关', { skip: !runtimeRoot }, async t => {
  const load = path => import(pathToFileURL(resolve(runtimeRoot, 'node_modules/@deepseek-ai', path)).href)
  const { composeEntries, loadOverlayPatches } = await load('dsh-app-boot/lib/index.js')
  const { Config, apply } = await load('dsh-llm-pi-ai/lib/index.js')
  const { SettingsForms } = await load('dsh-settings/lib/index.js')
  const { ClientModuleRegistry } = await load('dsh-client-modules/lib/index.js')
  const registry = Object.create(ClientModuleRegistry.prototype)
  Object.defineProperty(registry, 'ctx', { value: { loader: {} } })
  const client = registry.resolveMeta('dsh-workbuddy-manager', pathToFileURL(resolve(root, 'package.json')).href)
  assert.equal(client.packageName, 'dsh-workbuddy-manager')
  assert.equal(client.meta.clientPath, resolve(root, 'lib/ui-bundle.js'))
  assert.ok(client.meta.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  const base = loadOverlayPatches('dsh-test', resolve(runtimeRoot, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'))
  const bundle = loadOverlayPatches('dsh-test', resolve(root, 'cordis.patch.yml'))
  const warnings = []
  const entries = composeEntries([base, bundle], warning => warnings.push(warning))
  assert.deepEqual(warnings, [])
  assert.equal(entries.filter(entry => entry.id === 'llm-pi-ai').length, 1)
  assert.equal(entries.find(entry => entry.id === 'workbuddy-manager').name, 'dsh-workbuddy-manager')

  const requests = []
  const server = createServer(async (req, res) => {
    const parts = []
    for await (const part of req) parts.push(part)
    const raw = Buffer.concat(parts)
    const decoded = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
    requests.push({
      path: req.url,
      auth: req.headers.authorization,
      headers: req.headers,
      body: decoded ? JSON.parse(decoded) : undefined,
    })
    if (req.url === '/v3/config') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        code: 0,
        data: {
          agents: [{ name: 'cli', models: ['glm-test'] }],
          models: [{ id: 'glm-test', name: 'GLM Test', maxInputTokens: 131072, maxOutputTokens: 32768 }],
        },
      }))
      return
    }
    if (req.url === '/v2/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk1 = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'glm-test',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
          },
          finish_reason: null,
        }],
      }
      const chunk2 = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'glm-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`)
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-test', object: 'model' }] }))
      return
    }
    const response = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model: 'glm-test', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const call = { id: 'fc_test', type: 'function_call', call_id: 'call_test', name: 'read_file', arguments: '{"path":"README.md"}' }
    const wantsTool = requests.at(-1).body?.tools?.length > 0
    const events = wantsTool ? [
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta: call.arguments },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: call.id, arguments: call.arguments },
      { type: 'response.output_item.done', output_index: 0, item: call },
    ] : [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_test', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: '你好' },
    ]
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress' } },
      ...events,
      { type: 'response.completed', response: { ...response, output: wantsTool ? [call] : [] } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise(done => server.close(done)))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const baseURL = `${endpoint}/v1`

  {
    const { validateTypertManifest } = await load('dsh-typert-loader/lib/index.js')
    const { TypertGatewayService } = await load('dsh-api-gateway/lib/index.js')
    const { Context } = await load('cordis/lib/index.js')
    const { TYPERT } = await import('../lib/manager/contract.js')
    const { ManagerRemote } = await import('../lib/manager/service.js')
    validateTypertManifest('dsh-workbuddy-manager', TYPERT)
    const descriptor = TYPERT.invocations[0]
    const host = new Context()
    host.provide('typert', { local: { get: ep => ep === 'workbuddy/manage' ? descriptor : undefined, hasSeen: () => false }, resources: { entries: () => [] } })
    host.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) })
    host.provide('credentials', { readRecord: async () => undefined, modifyRecord: async () => undefined, deleteRecord: async () => {} })
    const managerScope = host.plugin(ManagerRemote)
    const gatewayScope = host.plugin(TypertGatewayService, TypertGatewayService.Config({}))
    await Promise.all([managerScope, gatewayScope])
    try {
      const gateway = host.get('typertGateway')
      const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
      const request = { namespace: 'workbuddy', method: 'manage', args: { request: { action: 'health' } }, peer }
      const health = await gateway.invoke(request)
      assert.equal(health.online, true)
      assert.match(health.gatewayURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      await assert.rejects(gateway.invoke({ ...request, peer: { ...peer, principal: { kind: 'guest', id: 'fixture' } } }), /只有 DSH 所有者/)
      await assert.rejects(gateway.invoke({ ...request, args: { request: { action: 'unknown' } } }), /invalid|decode|codec|request/i)
    } finally {
      await gatewayScope.dispose()
      await managerScope.dispose()
    }
    requests.length = 0
  }

  let providers = { other: { api: 'openai-responses', baseURL, apiKeyEnv: 'OTHER_KEY', models: [{ id: 'other-model' }] } }
  let resolved = Config({ providers }).providers.get()
  const credential = new Map()
  const callbacks = {}
  const headerListeners = []
  let registration
  let discovery
  const llm = {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerModelDiscovery: (_ns, callback) => { discovery = callback },
    registerAdapter(routes, adapter) {
      registration = { routes, adapter }
      return { replace(next) { registration.routes = next } }
    },
  }
  const ctx = {
    llm,
    fiber: { entry: { options: { id: 'llm-pi-ai' } } },
    get: name => name === 'credentials' ? { resolve: async ref => credential.has(ref) ? { value: credential.get(ref) } : undefined } : undefined,
    inject() {},
    on(name, callback) {
      callbacks[name] = callback
      if (name === 'llm-pi-ai/request-headers') headerListeners.push(callback)
    },
    waterfall: (name, request, headers, next) => {
      if (name === 'llm-pi-ai/request-headers') {
        let current = next
        for (const listener of headerListeners) {
          const prev = current
          current = () => listener(request, headers, prev)
        }
        return current()
      }
      return next()
    },
  }
  apply(ctx, { providers: { get: () => resolved } })
  assert.deepEqual(registration.routes, ['other'])

  let revision = 1
  const entry = { options: { id: 'llm-pi-ai' }, fiber: { runtime: { Config } } }
  const settings = Object.create(SettingsForms.prototype)
  settings.ownerContext = { configEditor: {
    entries: () => [entry],
    edit: async (_entry, change) => { providers = change({ providers: structuredClone(providers) }, {}).providers },
  } }
  settings.describe = () => [{ ns: 'llm-pi-ai', revision }]
  const remote = {
    settings: {
      describe: async () => ok({ writable: true, namespaces: [{ ns: 'llm-pi-ai', value: { providers: structuredClone(providers) }, revision }] }),
      mutate: async (ns, operations, expected) => {
        await settings.mutate(ns, operations, expected)
        if (callbacks['internal/config']) callbacks['internal/config'](ctx.fiber, () => ({ providers }))
        resolved = Config({ providers }).providers.get()
        callbacks['loader/volatile-update']()
        return ok({ ns: 'llm-pi-ai', value: { providers }, revision: ++revision })
      },
    },
    credentials: {
      describe: async refs => ok(Object.fromEntries(refs.map(ref => [ref, { configured: credential.has(ref), writable: true }]))),
      set: async (ref, value) => { credential.set(ref, value); return ok(undefined) },
      unset: async ref => { credential.delete(ref); return ok(undefined) },
    },
    llm: { discoverModels: async (_ns, request) => ok(await discovery(request)) },
  }

  const connection = await loadConnection(remote)
  assert.equal(await sync(remote, connection, baseURL, 'fixture-key'), 1)
  assert.deepEqual(registration.routes, ['other', 'workbuddy-manager'])

  const { Context } = await load('cordis/lib/index.js')
  const { ManagerRemote } = await import('../lib/manager/service.js')
  const host = new Context()
  const records = new Map()
  host.provide('credentials', {
    describe: async ref => ({ configured: credential.has(ref), writable: true }),
    set: async (ref, value) => { credential.set(ref, value) },
    unset: async ref => { credential.delete(ref) },
    readRecord: async key => records.get(key),
    modifyRecord: async (key, update) => { const value = await update(records.get(key)); records.set(key, value); return value },
    deleteRecord: async key => { records.delete(key) },
  })
  const managerScope = host.plugin(ManagerRemote, { sites: { cn: { endpoint }, global: { endpoint } } })
  await managerScope
  t.after(() => managerScope.dispose())
  const manager = host.get('workbuddyManager')
  headerListeners.push((request, headers, next) => {
    const out = next()
    if (request.provider === 'workbuddy-manager-session') {
      if (request.sessionId) out.set('x-magpie-workbuddy-session', request.sessionId)
      out.set('authorization', `Bearer ${manager.gateway.token}`)
    }
    return out
  })

  await manager.pool.upsertSignedIn({
    realm: 'cn',
    uid: 'u-desktop',
    nickname: '桌面测试账号',
    access: 'fixture-wb-access',
    refresh: 'fixture-wb-refresh',
    domain: 'copilot.tencent.com',
    expires: Date.now() + 3600_000,
  }, 100)

  const bridgeRemote = { ...remote, workbuddy: { manage: async request => ok(await manager.manage(request)) } }
  assert.equal(await connectBridge(bridgeRemote, () => true), 1)
  assert.ok(registration.routes.includes('workbuddy-manager-session'))
  assert.equal(providers['workbuddy-manager-session'].api, 'openai-completions')
  assert.equal(JSON.stringify(providers).includes(manager.gateway.token), false)

  const bridgeChunks = []
  for await (const chunk of registration.adapter.stream({
    provider: 'workbuddy-manager-session',
    model: 'glm-test',
    sessionId: 'desktop-session-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: '读取文件' }] }],
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  })) bridgeChunks.push(chunk)

  const bridged = bridgeChunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(bridged?.block.name, 'read_file')
  assert.deepEqual(JSON.parse(bridged.block.arguments), { path: 'README.md' })

  const upstreamChat = requests.find(request => request.path === '/v2/chat/completions')
  assert.ok(upstreamChat)
  assert.equal(upstreamChat.auth, 'Bearer fixture-wb-access')
  assert.equal(upstreamChat.headers['x-stainless-runtime'], 'node')
  assert.equal(upstreamChat.headers['content-encoding'], 'gzip')
  assert.match(upstreamChat.headers['x-conversation-id'], /^[0-9a-f]{32}$/)
  assert.equal(upstreamChat.body.tools[0].function.name, 'read_file')
})
