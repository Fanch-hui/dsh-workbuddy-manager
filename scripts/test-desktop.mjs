#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const binary = process.env.DSH_ELECTRON_BIN ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const runtime = process.env.DSH_RUNTIME_ROOT ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'
if (!existsSync(binary)) {
  console.error(`未找到 DSH 桌面运行时：${binary}\n请设置 DSH_ELECTRON_BIN 与 DSH_RUNTIME_ROOT。`)
  process.exit(1)
}

const tests = [
  'tests/desktop-host.test.mjs',
  'tests/desktop-routing.test.mjs',
  'tests/desktop-credentials.test.mjs',
]
const result = spawnSync(binary, ['--expose-internals', '--test', ...tests], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_RUNTIME_ROOT: runtime },
})
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
