import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyLoginLink, keyScope } from '../src/ui/management.js'

test('密钥模型版本按上游限制显示，不猜测默认版本', () => {
  assert.equal(keyScope(''), '版本不限')
  assert.equal(keyScope('cn'), '仅国内版模型')
  assert.equal(keyScope('global'), '仅国际版模型')
  assert.equal(keyScope('unexpected'), '版本限制未知')
})

test('登录链接完整复制，剪贴板不可用时返回可手动复制状态', async () => {
  const url = 'https://example.test/authorize?state=fixture&version=cn'
  let copied = ''
  assert.equal(await copyLoginLink(url, { writeText: async value => { copied = value } }), true)
  assert.equal(copied, url)
  assert.equal(await copyLoginLink(url, undefined), false)
  assert.equal(await copyLoginLink(url, { writeText: async () => { throw new Error('permission denied') } }), false)
})
