import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
const root = resolve(import.meta.dirname, '..')

// Run with the desktop Electron executable in Node mode and DSH_RUNTIME_ROOT
// pointing to its app.asar/dsh directory. Ordinary Node cannot load an asar.
test('桌面宿主真实合成、注册模型并发出 Responses 请求', { skip: !runtimeRoot }, async t => {
  const load = path => import(pathToFileURL(resolve(runtimeRoot, 'node_modules/@deepseek-ai', path)).href)
  const { composeEntries, loadOverlayPatches } = await load('dsh-app-boot/lib/index.js')
  const { Config, apply } = await load('dsh-llm-pi-ai/lib/index.js')
  const base = loadOverlayPatches('dsh-test', resolve(runtimeRoot, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'))
  const bundle = loadOverlayPatches('dsh-test', resolve(root, 'cordis.patch.yml'))
  const warnings = []
  const entries = composeEntries([base, bundle], warning => warnings.push(warning))
  assert.deepEqual(warnings, [])
  const rows = entries.filter(entry => entry.id === 'llm-pi-ai')
  assert.equal(rows.length, 1)
  const requests = []
  const server = createServer(async (req, res) => {
    const parts = []
    for await (const part of req) parts.push(part)
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(parts).toString()) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const response = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model: 'glm-5.2', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_test', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: '你好' },
      { type: 'response.output_text.done', item_id: 'msg_test', output_index: 0, content_index: 0, text: '你好' },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  t.after(() => new Promise(ok => server.close(ok)))
  rows[0].config.providers['workbuddy-manager'].baseURL = `http://127.0.0.1:${server.address().port}/v1`
  const config = Config(rows[0].config)
  const route = config.providers.get()['workbuddy-manager']
  assert.equal(route.api, 'openai-responses')
  assert.ok(route.models.length > 0)

  let registered
  const llm = {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerModelDiscovery() {},
    registerAdapter(routes, adapter) {
      registered = { routes, adapter }
      return { replace() {} }
    },
  }
  const ctx = {
    llm,
    fiber: { entry: { options: { id: 'llm-pi-ai' } } },
    get: name => name === 'credentials' ? { resolve: async () => ({ value: 'test-only-key' }) } : undefined,
    inject() {},
    on() {},
    waterfall: (_name, _request, _headers, next) => next(),
  }
  apply(ctx, config)
  assert.ok(registered.routes.includes('workbuddy-manager'))
  const models = await registered.adapter.listModels('workbuddy-manager')
  assert.deepEqual(models.map(model => model.id), route.models.map(model => model.id))
  const model = await registered.adapter.resolveModel('workbuddy-manager', route.models[0].id)
  assert.equal(model.id, route.models[0].id)
  const chunks = []
  for await (const chunk of registered.adapter.stream({
    provider: 'workbuddy-manager', model: route.models[0].id, maxTokens: 2048,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })) chunks.push(chunk)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/v1/responses')
  assert.equal(requests[0].auth, 'Bearer test-only-key')
  assert.equal(requests[0].body.model, route.models[0].id)
  assert.equal(requests[0].body.stream, true)
  assert.equal('max_output_tokens' in requests[0].body, false)
  assert.ok(JSON.stringify(chunks).includes('你好'))
})
