import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ManagerRemote } from '../src/manager/service.js'
import { connectBridge, type BridgeRemote } from '../src/ui/bridge-connection.js'
import { BRIDGE_PROVIDER } from '../src/address.js'
import { SESSION } from '../src/gateway/session-ids.js'

const ok = <T>(value: T) => ({ ok: true as const, value })

test('本地网关模拟 X-Stainless 指纹、gzip 与会话 ID，并在 11128 被拒后自动改写提示词', async t => {
  const chatCalls: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = []
  let refuseCount = 0
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    res.setHeader('content-type', 'application/json')

    if (req.url === '/v3/config') {
      return res.end(JSON.stringify({
        code: 0,
        data: {
          agents: [{ name: 'cli', models: ['glm-5.3'] }],
          models: [{ id: 'glm-5.3', name: 'GLM 5.3', maxInputTokens: 200000, maxOutputTokens: 32768 }],
        },
      }))
    }
    if (req.url === '/v2/chat/completions') {
      const text = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
      const body = JSON.parse(text)
      chatCalls.push({ headers: req.headers, body })
      if (refuseCount < 2) {
        refuseCount++
        res.statusCode = 400
        return res.end(JSON.stringify({
          error: { code: 11128, message: 'The request cannot be processed at this time due to safety policy' },
        }))
      }
      res.setHeader('content-type', 'text/event-stream')
      const events = [
        { choices: [{ index: 0, delta: { role: 'assistant', content: "Sorry, I can't respond to this question." }, finish_reason: 'content_filter' }] },
        { choices: [{ index: 0, delta: { content: '正常回复内容' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'mcp_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      ]
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    res.statusCode = 404
    return res.end('{}')
  })
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => upstream.close(() => done())))
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

  const values = new Map<string, string>()
  const records = new Map<string, unknown>()
  const ctx = new Context()
  ctx.provide('credentials', {
    describe: async (ref: string) => ({ configured: values.has(ref), writable: true }),
    set: async (ref: string, value: string) => { values.set(ref, value) },
    unset: async (ref: string) => { values.delete(ref) },
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, update: (current: unknown) => Promise<unknown>) => {
      const value = await update(records.get(key))
      records.set(key, value)
      return value
    },
    deleteRecord: async (key: string) => { records.delete(key) },
  })
  const scope = ctx.plugin(ManagerRemote, { sites: { cn: { endpoint }, global: { endpoint } } })
  await scope
  t.after(() => scope.dispose())
  const manager = ctx.get('workbuddyManager') as ManagerRemote

  await manager.pool.upsertSignedIn({
    realm: 'cn',
    uid: 'user-42',
    nickname: '测试账号',
    access: 'fixture-access-token',
    refresh: 'fixture-refresh-token',
    domain: 'copilot.tencent.com',
    expires: Date.now() + 3600_000,
  }, 50)

  let revision = 1
  const providers: Record<string, any> = {
    'workbuddy-manager': { baseURL: 'http://127.0.0.1:7864/v1', api: 'openai-responses', apiKeyEnv: 'LEGACY_KEY', models: [{ id: 'legacy-model' }] },
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
        const response = await fetch(`${request.baseURL}/models`, {
          headers: { authorization: `Bearer ${values.get(provider.apiKeyEnv)}` },
        })
        if (!response.ok) return { ok: false, error: { message: `HTTP ${response.status}` } }
        const body = await response.json() as { data: Array<{ id: string; name: string; contextWindow: number }> }
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

  assert.equal(await connectBridge(remote, () => true), 1)
  const provider = providers[BRIDGE_PROVIDER]
  assert.equal(provider.api, 'openai-completions')
  assert.match(provider.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.match(provider.apiKeyEnv, /^WORKBUDDY_MANAGER_BRIDGE_[A-F0-9]{32}$/)
  assert.equal(values.get(provider.apiKeyEnv), manager.gateway.token)
  assert.equal(provider.models[0].id, 'glm-5.3')
  assert.deepEqual(providers['workbuddy-manager'].models, [{ id: 'legacy-model' }])
  assert.deepEqual(providers.other.models, [{ id: 'other-model' }])

  // Unauthenticated call to local gateway is rejected
  const unauth = await fetch(`${provider.baseURL}/chat/completions`, { method: 'POST', body: '{}' })
  assert.equal(unauth.status, 401)

  // Verify llm-pi-ai/request-headers waterfall injects session header and temporary token
  const reqHeaders = new Headers({ 'content-type': 'application/json' })
  const waterfall = ctx.waterfall as unknown as (...args: unknown[]) => unknown
  waterfall.call(ctx, 'llm-pi-ai/request-headers', {
    provider: BRIDGE_PROVIDER,
    baseURL: provider.baseURL,
    sessionId: 'dsh-session-abc',
  }, reqHeaders, () => reqHeaders)
  assert.equal(reqHeaders.get(SESSION), 'dsh-session-abc')
  assert.equal(reqHeaders.get('authorization'), `Bearer ${manager.gateway.token}`)

  const chatRes = await fetch(`${provider.baseURL}/chat/completions`, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({
      model: 'glm-5.3',
      stream: true,
      messages: [
        { role: 'system', content: 'You are a coding agent running on DeepSeek Harness.' },
        { role: 'user', content: 'Hello there' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'mcp.tool',
            parameters: { type: ['object', 'null'], properties: { a: { enum: [1, 'two'] } } },
          },
        },
      ],
    }),
  })
  assert.equal(chatRes.status, 200)
  const sseText = await chatRes.text()

  // Verify 3 attempts were made: initial -> commaPaused -> systemAsUser
  assert.equal(chatCalls.length, 3)
  const firstHeaders = chatCalls[0].headers
  assert.equal(firstHeaders['x-stainless-runtime'], 'node')
  assert.equal(firstHeaders['x-stainless-package-version'], '6.25.0')
  assert.equal(firstHeaders['content-encoding'], 'gzip')
  assert.match(String(firstHeaders['user-agent']), /^WorkBuddy\/5\.9\.3 WorkBuddy\/5\.9\.3 CLI\/2\.165\.0$/)
  assert.match(String(firstHeaders['x-conversation-id']), /^[0-9a-f]{32}$/)
  assert.match(String(firstHeaders['x-conversation-request-id']), /^[0-9a-f]{32}$/)
  assert.match(String(firstHeaders['x-conversation-message-id']), /^[0-9a-f]{32}$/)
  assert.equal(firstHeaders['x-user-id'], 'user-42')

  // First attempt hid DSH name in system prompt and normalized tool name
  assert.equal(chatCalls[0].body.messages[0].role, 'system')
  assert.equal(chatCalls[0].body.messages[0].content, 'You are a coding agent running on the agent harness.')
  assert.equal(chatCalls[0].body.tools[0].function.name, 'mcp_tool')

  // Second attempt inserted comma pause in opener ("You are a coding agent, running on...")
  assert.equal(chatCalls[1].body.messages[0].content, 'You are a coding agent, running on the agent harness.')

  // Third attempt moved system prompt into user message (<instructions>...) with default system prompt
  assert.equal(chatCalls[2].body.messages.length, 2)
  assert.equal(chatCalls[2].body.messages[0].role, 'system')
  assert.equal(chatCalls[2].body.messages[0].content, 'You are a helpful assistant.')
  assert.equal(chatCalls[2].body.messages[1].role, 'user')
  assert.ok(chatCalls[2].body.messages[1].content.includes('<instructions>'))
  assert.ok(chatCalls[2].body.messages[1].content.includes('Hello there'))

  // SSE filter removed "Sorry, I can't respond to this question." and restored tool name
  assert.equal(sseText.includes("Sorry, I can't respond"), false)
  assert.equal(sseText.includes('正常回复内容'), true)
  assert.equal(sseText.includes('mcp.tool'), true)
})
