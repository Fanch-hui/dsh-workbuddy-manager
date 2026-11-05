import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discover, loadConnection, managementURL, mergeModels, normalizeURL, sync, type Remote } from '../src/ui/connection.js'

const ok = <T>(value: T) => ({ ok: true as const, value })

function makeRemote(initial: Record<string, unknown> = {}) {
  let providers: Record<string, unknown> = structuredClone(initial)
  let revision = 7
  const stored = new Map<string, string>()
  const probes: unknown[] = []
  const writes: unknown[] = []
  let conflict = false
  const remote: Remote = {
    settings: {
      describe: async () => ok({ writable: true, namespaces: [{ ns: 'llm-pi-ai', value: { providers: structuredClone(providers) }, revision }] }),
      mutate: async (ns, operations, expected) => {
        writes.push({ ns, operations, expected })
        if (conflict || expected !== revision) return { ok: false, error: { code: 'settings/conflict', message: 'stale' } }
        for (const operation of operations) {
          const [, route, field] = operation.path
          if (field) {
            const old = providers[route] as Record<string, unknown> | undefined
            providers[route] = { ...old, [field]: operation.value }
          } else providers[route] = operation.value
        }
        revision++
        return ok({ ns, value: { providers }, revision })
      },
    },
    credentials: {
      describe: async refs => ok(Object.fromEntries(refs.map(ref => [ref, { configured: stored.has(ref), writable: true }]))),
      set: async (ref, value) => { stored.set(ref, value); return ok(undefined) },
    },
    llm: {
      discoverModels: async (ns, request) => {
        probes.push({ ns, request })
        return ok([{ id: 'new-model', name: 'New model', contextWindow: 131072 }, { id: 'old-model' }, { id: 'new-model' }])
      },
    },
  }
  return { remote, stored, probes, writes, providers: () => providers, makeConflict: () => { conflict = true } }
}

test('插件内同步保留已有提供方、模型配置和密钥引用', async () => {
  const app = makeRemote({
    other: { api: 'anthropic-messages', models: [{ id: 'other-model' }] },
    'workbuddy-manager': {
      baseURL: 'http://127.0.0.1:7864/v1', api: 'openai-responses', apiKeyEnv: 'EXISTING_KEY',
      headers: { 'X-Existing': 'unchanged' }, models: [{ id: 'old-model', name: '已有模型', contextWindow: 10000 }],
    },
  })
  app.stored.set('EXISTING_KEY', 'fixture-value')
  const connection = await loadConnection(app.remote)
  assert.equal(connection.keyConfigured, true)
  assert.equal(connection.keyRef, 'EXISTING_KEY')
  assert.equal(await sync(app.remote, connection, connection.url, ''), 2)
  assert.deepEqual(app.probes[0], { ns: 'llm-pi-ai', request: { provider: 'workbuddy-manager', baseURL: connection.url, api: 'openai-responses' } })
  assert.deepEqual(app.providers().other, { api: 'anthropic-messages', models: [{ id: 'other-model' }] })
  const provider = app.providers()['workbuddy-manager'] as Record<string, unknown>
  assert.deepEqual(provider.headers, { 'X-Existing': 'unchanged' })
  assert.equal(provider.apiKeyEnv, 'EXISTING_KEY')
  assert.deepEqual(provider.models, [{ id: 'old-model', name: '已有模型', contextWindow: 10000 }, { id: 'new-model', name: 'New model', contextWindow: 131072 }])
  assert.equal(app.stored.get('EXISTING_KEY'), 'fixture-value')
})

test('新提供方先验证，再分别保存模型配置和凭据', async () => {
  const app = makeRemote({ other: { models: [{ id: 'existing' }] } })
  const connection = await loadConnection(app.remote)
  const key = 'fixture-secret'
  assert.equal(await sync(app.remote, connection, 'http://127.0.0.1:7864', key), 2)
  assert.equal(app.stored.get('WORKBUDDY_MANAGER_API_KEY'), key)
  assert.equal(JSON.stringify(app.writes).includes(key), false)
  assert.deepEqual(app.providers().other, { models: [{ id: 'existing' }] })
  const provider = app.providers()['workbuddy-manager'] as Record<string, unknown>
  assert.equal(provider.apiKeyEnv, 'WORKBUDDY_MANAGER_API_KEY')
  assert.equal(provider.baseURL, 'http://127.0.0.1:7864/v1')
})

test('版本冲突不会覆盖配置或写入密钥', async () => {
  const app = makeRemote()
  const connection = await loadConnection(app.remote)
  app.makeConflict()
  await assert.rejects(sync(app.remote, connection, connection.url, 'fixture-secret'), /重新载入/)
  assert.deepEqual(app.providers(), {})
  assert.equal(app.stored.size, 0)
})

test('凭据写入异常时说明模型配置已更新并隐藏密钥', async () => {
  const app = makeRemote()
  app.remote.credentials.set = async () => { throw new Error('fixture-secret rejected') }
  const connection = await loadConnection(app.remote)
  await assert.rejects(sync(app.remote, connection, connection.url, 'fixture-secret'), /模型配置已更新，但密钥保存失败：\[已隐藏\] rejected/)
  assert.ok(app.providers()['workbuddy-manager'])
})

test('连接错误不泄露输入密钥', async () => {
  const app = makeRemote()
  app.remote.llm.discoverModels = async () => ({ ok: false, error: { message: 'refused fixture-secret' } })
  const connection = await loadConnection(app.remote)
  await assert.rejects(discover(app.remote, connection, connection.url, 'fixture-secret'), error => {
    assert.equal((error as Error).message, 'refused [已隐藏]')
    return true
  })
})

test('网关地址严格校验并保留代理路径', () => {
  assert.equal(normalizeURL('http://127.0.0.1:7864/'), 'http://127.0.0.1:7864/v1')
  assert.equal(normalizeURL('https://example.test/wb/v1/'), 'https://example.test/wb/v1')
  assert.equal(managementURL('https://example.test/wb'), 'https://example.test/wb')
  assert.throws(() => normalizeURL('http://example.test'), /HTTPS/)
  assert.throws(() => normalizeURL('https://name:secret@example.test'), /账号/)
  assert.throws(() => normalizeURL('https://example.test?key=fixture'), /查询参数/)
})

test('模型同步只追加缺失项', () => {
  assert.deepEqual(mergeModels([{ id: 'a', name: '自定义' }], [{ id: 'a', name: '默认' }, { id: 'b' }, { id: 'b' }]), [{ id: 'a', name: '自定义' }, { id: 'b' }])
})
