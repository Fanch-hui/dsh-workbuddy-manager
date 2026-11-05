#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
/** Validate the bundle layer and built desktop and CLI entry points before packing. */
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

  const entries = Array.isArray(patch) ? patch.flatMap(row => row.insert ?? []) : []
  expect(entries.some(row => row.id === 'workbuddy-manager' && row.name === 'dsh-workbuddy-manager'), 'bundle 挂载 WorkBuddy 插件')
  expect(!patch?.some(row => row.id === 'llm-pi-ai' || row.insert?.some(entry => entry.id === 'llm-pi-ai')), 'bundle 不覆盖其他模型提供方')
  expect(manifest?.dsh?.client?.platform === 'web', '声明 Web 客户端插件')
  expect(manifest?.exports?.['./client']?.default === './lib/ui-bundle.js', '客户端入口指向 UI 构建产物')
  expect(manifest?.exports?.['./client']?.node === './lib/client.js', '保留 Node 客户端接口')
  expect(!/wb[kt]_/.test(patchText ?? ''), '配置文件不含任何明文密钥')

  for (const file of ['lib/cli.js', 'lib/client.js', 'lib/index.js', 'lib/ui-bundle.js']) {
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
