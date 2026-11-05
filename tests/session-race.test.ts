import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ManagerRemote } from '../src/manager/service.js'

test('退出管理时先完成之前的会话续期，再清除保存的会话', async t => {
  let accountStarted!: () => void
  let releaseAccount!: () => void
  let logoutStarted = false
  const started = new Promise<void>(resolve => { accountStarted = resolve })
  const release = new Promise<void>(resolve => { releaseAccount = resolve })
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/login') {
      response.setHeader('set-cookie', 'wb_session=fixture-first; Path=/')
      response.end(JSON.stringify({ ok: true, role: 'admin' }))
    } else if (request.url === '/api/accounts') {
      response.setHeader('set-cookie', 'wb_session=fixture-renewed; Path=/')
      accountStarted()
      void release.then(() => response.end(JSON.stringify({ accounts: [] })))
    } else if (request.url === '/api/keys') response.end('[]')
    else if (request.url === '/api/logout') { logoutStarted = true; response.end('{}') }
    else response.end('{}')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => { releaseAccount(); return new Promise<void>(done => server.close(() => done())) })
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const records = new Map<string, unknown>()
  const ctx = new Context()
  ctx.provide('credentials', {
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, update: (current: unknown) => Promise<unknown>) => { const value = await update(records.get(key)); records.set(key, value); return value },
    deleteRecord: async (key: string) => { records.delete(key) },
  })
  const scope = ctx.plugin(ManagerRemote)
  await scope
  t.after(() => scope.dispose())
  const manager = ctx.get('workbuddyManager') as ManagerRemote
  await manager.manage({ action: 'login', address, username: 'fixture', password: 'fixture-password' })
  const overview = manager.manage({ action: 'overview', address })
  await started
  const logout = manager.manage({ action: 'logout', address })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(logoutStarted, false)
  releaseAccount()
  await overview
  await logout
  assert.equal(logoutStarted, true)
  assert.equal(records.size, 0)
})
