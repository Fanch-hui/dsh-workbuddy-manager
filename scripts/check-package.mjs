#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PROVIDER = 'workbuddy-manager'

/** Validate the bundle layer and the built CLI entry points before packing. */
export function validatePackage(root = ROOT) {
  const errors = []
  const checks = []
  const read = file => {
    try {
      return readFileSync(join(root, file), 'utf8')
    } catch {
      errors.push(`缺少文件：${file}`)
      return undefined
    }
  }
  const expect = (condition, message) => {
    if (condition) checks.push(message)
    else errors.push(message)
  }

  const manifestText = read('package.json')
  const patchText = read('cordis.patch.yml')
  const manifest = manifestText ? JSON.parse(manifestText) : undefined
  let patch
  if (patchText) {
    try {
      patch = YAML.parse(patchText)
    } catch (error) {
      errors.push(`cordis.patch.yml 不是合法 YAML：${error.message}`)
    }
  }

  expect(manifest?.engines?.dsh === '>=0.2.2-rc.1 <0.3.0', 'engines.dsh 锁定 DSH 0.2.2-rc.1 兼容范围')
  expect(manifest?.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json 声明 dsh.bundle.patch')
  expect(Array.isArray(manifest?.files) && manifest.files.includes('cordis.patch.yml'), '发布文件包含 cordis.patch.yml')
  expect(manifest?.bin?.['dsh-workbuddy'] === './lib/cli.js', 'CLI bin 指向构建产物')

  // The llm-pi-ai row already exists in dsh-base (dormant); the bundle layer
  // must address it by id, not insert a second row with the same id.
  const row = Array.isArray(patch) && patch.length === 1 ? patch[0] : undefined
  expect(row?.id === 'llm-pi-ai' && row?.insert === undefined, 'patch 按 id 覆盖 dsh-base 的 llm-pi-ai 行，而非插入重复行')
  expect(row?.name === '@deepseek-ai/dsh-llm-pi-ai', 'patch 覆盖 dsh-base 的 llm-pi-ai 行')
  const provider = row?.config?.providers?.[PROVIDER]
  expect(Boolean(provider), '注入 workbuddy-manager provider 路由')
  expect(provider?.api === 'openai-responses', '协议为 openai-responses')
  expect(provider?.apiKeyEnv === 'WORKBUDDY_MANAGER_API_KEY', '网关密钥走 DSH 凭据引用')
  expect(typeof provider?.baseURL === 'string' && /\/v1\/?$/.test(provider.baseURL), 'baseURL 指向网关 /v1')
  expect(provider?.compat?.supportsMaxOutputTokens === false, '省略网关未声明的 max_output_tokens')
  const models = provider?.models
  expect(Array.isArray(models) && models.length > 0 && models.every(m => typeof m?.id === 'string'), '模型目录非空且每项有 id')
  expect(Array.isArray(models) && new Set(models.map(m => m.id)).size === models.length, '模型 id 不重复')
  expect(!/wb[kt]_/.test(patchText ?? ''), '配置文件不含任何明文密钥')

  for (const file of ['lib/cli.js', 'lib/client.js']) {
    expect(existsSync(join(root, file)), `构建产物 ${file} 存在`)
  }
  return { errors, checks }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, checks } = validatePackage()
  for (const item of checks) console.log(`PASS  ${item}`)
  for (const item of errors) console.error(`FAIL  ${item}`)
  process.exitCode = errors.length ? 1 : 0
}
