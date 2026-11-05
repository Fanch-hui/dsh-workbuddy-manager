import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { validatePackage } from '../scripts/check-package.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('真实 bundle 配置符合 DSH 0.2.2-rc.1 约定', () => {
  const { errors, checks } = validatePackage(root)
  assert.deepEqual(errors, [], `配置校验失败：${errors.join('; ')}`)
  assert.ok(checks.length >= 10)
})

/**
 * 按 DSH 0.2.2-rc.1 已核实的合成规则最小复刻 applyPatches：
 * 层按顺序平铺后覆盖空根；insert 追加条目；带 id 的条目整体替换目标行的键。
 */
function composeLayers(layers) {
  const entries = []
  const rowOf = new Map()
  for (const patch of layers.flat()) {
    if (patch.insert) {
      for (const entry of patch.insert) {
        entries.push(entry)
        if (entry.id) rowOf.set(entry.id, entry)
      }
      continue
    }
    const target = rowOf.get(patch.id)
    assert.ok(target, `patch 定向的行不存在：${patch.id}`)
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id') continue
      target[key] = value
    }
  }
  return entries
}

test('bundle 层覆盖 dsh-base 休眠行，且不产生重复 id', () => {
  const patch = YAML.parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))
  const dshBaseLayer = [{ insert: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }] }]
  const entries = composeLayers([dshBaseLayer, patch])
  const rows = entries.filter(entry => entry.id === 'llm-pi-ai')
  assert.equal(rows.length, 1, 'llm-pi-ai 行只挂载一份')
  assert.deepEqual(rows[0].config.providers['workbuddy-manager'].api, 'openai-responses')
})

test('后续层覆盖 llm-pi-ai 时整行替换 config（last write wins）', () => {
  const patch = YAML.parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))
  const dshBaseLayer = [{ insert: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }] }]
  const userLayer = [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { other: {} } } }]
  const entries = composeLayers([dshBaseLayer, patch, userLayer])
  const row = entries.find(entry => entry.id === 'llm-pi-ai')
  assert.deepEqual(Object.keys(row.config.providers), ['other'], 'user 层替换整份 config，bundle 注入的 provider 不复活')
})

test('配置里出现明文密钥时拒绝打包', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-wb-'))
  try {
    for (const file of ['package.json', 'cordis.patch.yml']) {
      writeFileSync(join(temp, file), readFileSync(join(root, file), 'utf8'))
    }
    mkdirSync(join(temp, 'lib'))
    for (const file of ['cli.js', 'client.js']) writeFileSync(join(temp, 'lib', file), '')
    const clean = validatePackage(temp)
    assert.deepEqual(clean.errors, [])

    writeFileSync(
      join(temp, 'cordis.patch.yml'),
      readFileSync(join(root, 'cordis.patch.yml'), 'utf8').replace(
        'apiKeyEnv: WORKBUDDY_MANAGER_API_KEY',
        'apiKeyEnv: wbk_leaked_secret',
      ),
    )
    const dirty = validatePackage(temp)
    assert.ok(dirty.errors.some(message => message.includes('明文密钥')))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
