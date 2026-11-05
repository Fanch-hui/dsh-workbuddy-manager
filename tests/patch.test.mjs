import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validatePackage } from '../scripts/check-package.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('真实 bundle 配置符合 DSH 0.2.2-rc.1 约定', () => {
  const { errors, checks } = validatePackage(root)
  assert.deepEqual(errors, [], `配置校验失败：${errors.join('; ')}`)
  assert.ok(checks.length >= 10)
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
