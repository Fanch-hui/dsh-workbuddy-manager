import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachCredential, discover, loadConnection, managementURL, mergeModels, normalizeURL, sync, type Remote } from '../src/ui/connection.js'

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
      unset: async ref => { stored.delete(ref); return ok(undefined) },
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

test('识别本地网关已有提供方并保留其标识和高级配置', async () => {
  const app = makeRemote({
    mine: { baseURL: 'http://localhost:7864/v1', api: 'openai-responses', apiKeyEnv: 'OLD_REF', models: [{ id: 'old-model' }], compat: { supportsMaxOutputTokens: false } },
    other: { api: 'anthropic-messages', models: [{ id: 'untouched' }] },
  })
  app.stored.set('OLD_REF', 'fixture-value')
  const connection = await loadConnection(app.remote)
  assert.equal(connection.providerId, 'mine')
  assert.equal(connection.keyConfigured, true)
  assert.equal(await sync(app.remote, connection, connection.url, ''), 2)
  assert.equal((app.probes[0] as { request: { provider: string } }).request.provider, 'mine')
  assert.equal(app.providers()['workbuddy-manager'], undefined)
  assert.deepEqual((app.providers().mine as Record<string, unknown>).compat, { supportsMaxOutputTokens: false })
  assert.deepEqual(app.providers().other, { api: 'anthropic-messages', models: [{ id: 'untouched' }] })
})

test('多个本地网关配置必须由用户明确选择', async () => {
  const app = makeRemote({
    first: { baseURL: 'http://127.0.0.1:7864/v1', api: 'openai-responses', models: [] },
    second: { baseURL: 'http://localhost:7864/v1', api: 'openai-responses', models: [] },
  })
  const connection = await loadConnection(app.remote)
  assert.equal(connection.providerId, '')
  await assert.rejects(discover(app.remote, connection, connection.url, 'fixture-value'), /请先选择/)
  assert.equal((await loadConnection(app.remote, 'second')).providerId, 'second')
  await assert.rejects(loadConnection(app.remote, 'other'), /不存在/)
  assert.deepEqual(app.writes, [])
})

test('识别远程 HTTPS 与非默认端口的 WorkBuddy 提供方，不误认其他提供方', async () => {
  const app = makeRemote({
    remote: { baseURL: 'https://gateway.example.test/wb/v1', api: 'openai-responses', apiKeyEnv: `WORKBUDDY_MANAGER_KEY_${'A'.repeat(32)}`, models: [] },
    local: { baseURL: 'http://127.0.0.1:8788/v1', api: 'openai-responses', apiKeyEnv: `WORKBUDDY_MANAGER_KEY_${'B'.repeat(32)}`, models: [] },
    other: { baseURL: 'https://api.openai.com/v1', api: 'openai-responses', apiKeyEnv: 'OPENAI_API_KEY', models: [] },
  })
  const connection = await loadConnection(app.remote)
  assert.deepEqual(connection.candidates.map(item => item.id).sort(), ['local', 'remote'])
  assert.equal(connection.providerId, '')
})

test('新提供方先验证，再分别保存模型配置和凭据', async () => {
  const app = makeRemote({ other: { models: [{ id: 'existing' }] } })
  const connection = await loadConnection(app.remote)
  const key = 'fixture-secret'
  assert.equal(await sync(app.remote, connection, 'http://127.0.0.1:7864', key), 2)
  assert.equal(JSON.stringify(app.writes).includes(key), false)
  assert.deepEqual(app.providers().other, { models: [{ id: 'existing' }] })
  const provider = app.providers()['workbuddy-manager'] as Record<string, unknown>
  assert.match(provider.apiKeyEnv as string, /^WORKBUDDY_MANAGER_KEY_[A-F0-9]{32}$/)
  assert.equal(app.stored.get(provider.apiKeyEnv as string), key)
  assert.equal(provider.baseURL, 'http://127.0.0.1:7864/v1')
  assert.deepEqual(provider.compat, { supportsMaxOutputTokens: false })
})

test('手动更换密钥不覆盖其他提供方的共享凭据', async () => {
  const app = makeRemote({
    other: { apiKeyEnv: 'SHARED_KEY', models: [] },
    'workbuddy-manager': { baseURL: 'http://127.0.0.1:7864/v1', api: 'openai-responses', apiKeyEnv: 'SHARED_KEY', models: [] },
  })
  app.stored.set('SHARED_KEY', 'fixture-old')
  const connection = await loadConnection(app.remote)
  await sync(app.remote, connection, connection.url, 'fixture-new')
  const nextRef = (app.providers()['workbuddy-manager'] as Record<string, unknown>).apiKeyEnv as string
  assert.match(nextRef, /^WORKBUDDY_MANAGER_KEY_[A-F0-9]{32}$/)
  assert.equal(app.stored.get(nextRef), 'fixture-new')
  assert.equal(app.stored.get('SHARED_KEY'), 'fixture-old')
  assert.equal((app.providers().other as Record<string, unknown>).apiKeyEnv, 'SHARED_KEY')
})

test('管理密钥绑定保留其他提供方和已有凭据', async () => {
  const app = makeRemote({
    other: { apiKeyEnv: 'SHARED_KEY', models: [{ id: 'untouched' }] },
    'workbuddy-manager': { baseURL: 'http://127.0.0.1:7864/v1', api: 'openai-responses', apiKeyEnv: 'SHARED_KEY', models: [], headers: { X: 'keep' } },
  })
  app.stored.set('SHARED_KEY', 'fixture-old')
  app.stored.set('WORKBUDDY_MANAGER_KEY_FRESH', 'fixture-new')
  const connection = await loadConnection(app.remote)
  const updated = await attachCredential(app.remote, connection, connection.url, 'WORKBUDDY_MANAGER_KEY_FRESH')
  assert.equal(await sync(app.remote, updated, connection.url, ''), 2)
  assert.equal((app.providers()['workbuddy-manager'] as Record<string, unknown>).apiKeyEnv, 'WORKBUDDY_MANAGER_KEY_FRESH')
  assert.deepEqual((app.providers()['workbuddy-manager'] as Record<string, unknown>).headers, { X: 'keep' })
  assert.deepEqual(app.providers().other, { apiKeyEnv: 'SHARED_KEY', models: [{ id: 'untouched' }] })
  assert.equal(app.stored.get('SHARED_KEY'), 'fixture-old')
})

test('使用旧凭据引用恢复旧版 bundle 提供方', async () => {
  const app = makeRemote({ other: { models: [{ id: 'untouched' }] } })
  app.stored.set('WORKBUDDY_MANAGER_API_KEY', 'fixture-old')
  const connection = await loadConnection(app.remote)
  assert.equal(connection.existing, false)
  assert.equal(connection.keyConfigured, true)
  assert.equal(await sync(app.remote, connection, connection.url, ''), 2)
  assert.deepEqual(app.providers().other, { models: [{ id: 'untouched' }] })
  const restored = app.providers()['workbuddy-manager'] as Record<string, unknown>
  assert.equal(restored.apiKeyEnv, 'WORKBUDDY_MANAGER_API_KEY')
  assert.deepEqual(restored.compat, { supportsMaxOutputTokens: false })
  assert.equal(restored.defaultContextWindow, 131072)
  assert.equal(restored.defaultMaxTokens, 32768)
  assert.equal(app.stored.get('WORKBUDDY_MANAGER_API_KEY'), 'fixture-old')
})

test('版本冲突不会留下配置变更或未使用的密钥', async () => {
  const app = makeRemote()
  const connection = await loadConnection(app.remote)
  app.makeConflict()
  await assert.rejects(sync(app.remote, connection, connection.url, 'fixture-secret'), /重新载入/)
  assert.deepEqual(app.providers(), {})
  assert.equal(app.stored.size, 0)
})

test('配置更新失败且清理失败时如实说明', async () => {
  const app = makeRemote()
  app.remote.credentials.unset = async () => ({ ok: false, error: { message: '凭据被占用' } })
  const connection = await loadConnection(app.remote)
  app.makeConflict()
  await assert.rejects(sync(app.remote, connection, connection.url, 'fixture-secret'), /未使用的密钥清理失败：凭据被占用/)
  assert.equal(app.stored.size, 1)
})

test('清理凭据异常时如实说明', async () => {
  const app = makeRemote()
  app.remote.credentials.unset = async () => { throw new Error('store locked') }
  const connection = await loadConnection(app.remote)
  app.makeConflict()
  await assert.rejects(sync(app.remote, connection, connection.url, 'fixture-secret'), /未使用的密钥清理失败：store locked/)
})

test('凭据写入失败时模型配置不改动并隐藏密钥', async () => {
  const app = makeRemote()
  app.remote.credentials.set = async () => { throw new Error('fixture-secret rejected') }
  const connection = await loadConnection(app.remote)
  await assert.rejects(sync(app.remote, connection, connection.url, 'fixture-secret'), error => {
    assert.equal((error as Error).message, '密钥保存失败，模型配置未改动：[已隐藏] rejected')
    return true
  })
  assert.deepEqual(app.providers(), {})
  assert.equal(app.stored.size, 0)
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
