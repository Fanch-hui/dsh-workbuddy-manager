import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import YAML from 'yaml'
import { validatePackage } from '../scripts/check-package.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('真实 bundle 和桌面客户端入口符合打包约定', () => {
  const { errors, checks } = validatePackage(root)
  assert.deepEqual(errors, [], `配置校验失败：${errors.join('; ')}`)
  assert.ok(checks.length >= 10)
})

test('bundle 保留既有模型提供方并挂载 WorkBuddy 界面', () => {
  const patch = YAML.parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))
  const existing = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { existing: {} } } }
  const entries = [existing, ...patch.flatMap(row => row.insert ?? [])]
  assert.equal(entries.find(row => row.id === 'llm-pi-ai'), existing)
  assert.deepEqual(Object.keys(existing.config.providers), ['existing'])
  assert.equal(entries.find(row => row.id === 'workbuddy-manager')?.name, 'dsh-workbuddy-manager')
})

test('Node 包入口保留原客户端接口', async () => {
  const rootEntry = await import('dsh-workbuddy-manager')
  const clientEntry = await import('dsh-workbuddy-manager/client')
  assert.equal(rootEntry.WorkbuddyManagerClient, clientEntry.WorkbuddyManagerClient)
  assert.equal(rootEntry.WorkbuddyError, clientEntry.WorkbuddyError)
  assert.equal(typeof rootEntry.apply, 'function')
})

test('客户端构建产物挂载管理接口并注册设置页面', async () => {
  const code = readFileSync(join(root, 'lib/ui-bundle.js'), 'utf8')
  let module
  const window = { __ModuleLoader__: { load(spec) { module = spec } } }
  runInNewContext(code, { window })
  assert.equal(module.id, 'dsh-workbuddy-manager')
  const plugin = module.factory(createRequire(import.meta.url))
  let registration
  let contribution
  let unmounted = false
  const ctx = {
    remote: { $mount: async value => { contribution = value; return async () => { unmounted = true } } },
    slots: {
      inject(name, fn) { assert.equal(name, 'settings.section'); fn() },
      register(options, component) { registration = { options, component } },
    },
  }
  const dispose = await plugin.apply(ctx)
  assert.equal(contribution.descriptors[0].id, 'dsh-workbuddy-manager#workbuddy/manage')
  assert.equal(registration.options.id, 'workbuddy-manager')
  assert.equal(registration.options.label(), 'WorkBuddy')
  assert.equal(registration.options.inject().remote, ctx.remote)
  assert.equal(typeof registration.component, 'function')
  await dispose()
  assert.equal(unmounted, true)
})

test('配置里出现明文密钥时拒绝打包', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-wb-'))
  try {
    for (const file of ['package.json', 'cordis.patch.yml']) writeFileSync(join(temp, file), readFileSync(join(root, file), 'utf8'))
    mkdirSync(join(temp, 'lib'))
    for (const file of ['cli.js', 'client.js', 'index.js', 'ui-bundle.js']) writeFileSync(join(temp, 'lib', file), '')
    assert.deepEqual(validatePackage(temp).errors, [])
    writeFileSync(join(temp, 'cordis.patch.yml'), `${readFileSync(join(root, 'cordis.patch.yml'), 'utf8')}\n# wbk_leaked_secret\n`)
    assert.ok(validatePackage(temp).errors.some(message => message.includes('明文密钥')))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
