import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keyScope } from '../src/ui/management.js'

test('密钥模型版本按上游限制显示，不猜测默认版本', () => {
  assert.equal(keyScope(''), '版本不限')
  assert.equal(keyScope('cn'), '仅国内版模型')
  assert.equal(keyScope('global'), '仅国际版模型')
  assert.equal(keyScope('unexpected'), '版本限制未知')
})
