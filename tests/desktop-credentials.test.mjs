import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const runtime = process.env.DSH_RUNTIME_ROOT

test('桌面凭据存储支持跨宿主重启恢复管理会话', { skip: !runtime, timeout: 15000 }, async t => {
  const load = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
  const { Context } = await load('cordis')
  const { LocalCredentialProvider } = await load('dsh-credentials-local')
  const { ManagerRemote } = await import('../lib/manager/service.js')
  const prefix = join(tmpdir(), 'dsh-wb-credentials-')
  const directory = await mkdtemp(prefix)
  assert.ok(directory.startsWith(prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'credentials.yaml')
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/healthz') return response.end(JSON.stringify({ ok: true, service: 'workbuddy-manager' }))
    if (request.url === '/api/login') {
      response.setHeader('set-cookie', 'wb_session=fixture-only; HttpOnly; Path=/')
      return response.end(JSON.stringify({ ok: true, role: 'admin' }))
    }
    if (request.headers.cookie !== 'wb_session=fixture-only') { response.statusCode = 401; return response.end('{}') }
    if (request.url === '/api/me') return response.end(JSON.stringify({ role: 'admin' }))
    return response.end(JSON.stringify({ ok: true }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = `http://127.0.0.1:${server.address().port}/v1`
  const scopes = []
  t.after(async () => { for (const scope of scopes.reverse()) await scope.dispose() })
  const boot = async () => {
    const ctx = new Context()
    const credentials = ctx.plugin(LocalCredentialProvider, { path: file, dshHome: directory, watch: false })
    await credentials
    const manager = ctx.plugin(ManagerRemote)
    await manager
    scopes.push(credentials, manager)
    return ctx.get('workbuddyManager')
  }
  const first = await boot()
  await first.manage({ action: 'login', address, username: 'fixture', password: 'fixture-password' })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await scopes[1].dispose(); await scopes[0].dispose()
  const second = await boot()
  assert.deepEqual(await second.manage({ action: 'health', address }), { online: true, authenticated: true, role: 'admin' })
  await second.manage({ action: 'logout', address })
  assert.deepEqual(await second.manage({ action: 'health', address }), { online: true, authenticated: false })
})
