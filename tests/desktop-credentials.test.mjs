import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const runtime = process.env.DSH_RUNTIME_ROOT

test('桌面凭据存储支持跨宿主重启持久化账号池与本地网关配置', { skip: !runtime, timeout: 15000 }, async t => {
  const load = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
  const { Context } = await load('cordis')
  const { LocalCredentialProvider } = await load('dsh-credentials-local')
  const { ManagerRemote } = await import('../lib/manager/service.js')
  const prefix = join(tmpdir(), 'dsh-wb-credentials-')
  const directory = await mkdtemp(prefix)
  assert.ok(directory.startsWith(prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'credentials.yaml')

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
  await first.pool.upsertSignedIn({
    realm: 'cn',
    uid: 'u-persist',
    nickname: '持久化账号',
    access: 'fixture-access',
    refresh: 'fixture-refresh',
    domain: 'copilot.tencent.com',
    expires: Date.now() + 3600_000,
  }, 88)
  const bridge1 = await first.manage({ action: 'bridge' })
  assert.match(bridge1.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await scopes[1].dispose()
  await scopes[0].dispose()
  scopes.length = 0

  const second = await boot()
  const health = await second.manage({ action: 'health' })
  assert.equal(health.online, true)
  assert.equal(health.poolAvailable, true)
  assert.equal(health.accountCount, 1)
  const overview = await second.manage({ action: 'overview' })
  assert.equal(overview.accounts.length, 1)
  assert.equal(overview.accounts[0].nickname, '持久化账号')
  assert.equal(overview.accounts[0].credits, 88)
  await second.manage({ action: 'accountDelete', file: 'workbuddy-cn-u-persist.json' })
  const afterDelete = await second.manage({ action: 'health' })
  assert.equal(afterDelete.poolAvailable, false)
  assert.equal(afterDelete.accountCount, 0)
})
