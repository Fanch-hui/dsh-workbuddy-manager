import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { AccountPoolStore } from '../src/gateway/pool-store.js'
import { LocalGatewayServer } from '../src/gateway/server.js'
import { SITES, type Realm, type SiteConfig } from '../src/gateway/sites.js'
import { fetchAccountUsage, checkinOf } from '../src/gateway/billing.js'

function makeTestSites(endpoint: string): Record<Realm, SiteConfig> {
  return {
    cn: { ...SITES.cn, endpoint },
    global: { ...SITES.global, endpoint },
  }
}

test('HTTP 400 14018 积分耗尽与 11140 账号受限更新状态并自动故障转移到下一账号', async t => {
  const attempts: string[] = []
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const userId = String(req.headers['x-user-id'] ?? '')
    attempts.push(`${req.url}:${userId}`)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v3/config') {
      return res.end(JSON.stringify({ code: 0, data: { agents: [{ name: 'cli', models: ['glm-5.3'] }], models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] } }))
    }
    if (req.url === '/v2/chat/completions') {
      if (userId === 'u-exhausted') {
        res.statusCode = 400
        return res.end(JSON.stringify({ code: 14018, msg: 'Credits exhausted for this account' }))
      }
      if (userId === 'u-restricted') {
        res.statusCode = 400
        return res.end(JSON.stringify({ code: 11140, msg: 'Your account has been restricted due to unusual activity' }))
      }
      return res.end(JSON.stringify({ id: 'cmpl-ok', choices: [{ index: 0, message: { role: 'assistant', content: `served-by-${userId}` }, finish_reason: 'stop' }] }))
    }
    res.statusCode = 404
    return res.end('{}')
  })
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => upstream.close(() => done())))
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

  const pool = new AccountPoolStore(() => undefined)
  await pool.upsertSignedIn({ realm: 'cn', uid: 'u-exhausted', nickname: '耗尽账号', access: 'tok-1', expires: Date.now() + 3600_000 })
  await pool.upsertSignedIn({ realm: 'cn', uid: 'u-restricted', nickname: '受限账号', access: 'tok-2', expires: Date.now() + 3600_000 })
  await pool.upsertSignedIn({ realm: 'cn', uid: 'u-healthy', nickname: '正常账号', access: 'tok-3', expires: Date.now() + 3600_000 })

  const gateway = new LocalGatewayServer({ pool, sites: makeTestSites(endpoint) })
  const baseURL = await gateway.ensureStarted()
  t.after(() => gateway.close())

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', reasoning_effort: 'low', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)
  const data = await res.json() as any
  assert.equal(data.choices[0].message.content, 'served-by-u-healthy')

  const items = await pool.listAccountItems()
  const exhausted = items.find(i => i.file.includes('u-exhausted'))!
  const restricted = items.find(i => i.file.includes('u-restricted'))!
  assert.equal(exhausted.cooling, true)
  assert.equal(restricted.blocked, true)
  assert.equal(restricted.inPool, false)
})

test('SSE 初始 content_filter 空拒绝在提交响应头前自动故障转移到下一账号', async t => {
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const userId = String(req.headers['x-user-id'] ?? '')
    if (req.url === '/v2/chat/completions') {
      res.setHeader('content-type', 'text/event-stream')
      if (userId === 'u-filtered') {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking...' }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "\nSorry, I can't respond to this question.\n" }, finish_reason: 'content_filter' }] })}\n\n`)
        return res.end('data: [DONE]\n\n')
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Valid answer from B' }, finish_reason: 'stop' }] })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    res.statusCode = 404
    return res.end('{}')
  })
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => upstream.close(() => done())))
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

  const pool = new AccountPoolStore(() => undefined)
  await pool.upsertSignedIn({ realm: 'cn', uid: 'u-filtered', nickname: '被过滤账号', access: 'tok-a', expires: Date.now() + 3600_000 })
  await pool.upsertSignedIn({ realm: 'cn', uid: 'u-ok', nickname: '正常账号B', access: 'tok-b', expires: Date.now() + 3600_000 })

  const gateway = new LocalGatewayServer({ pool, sites: makeTestSites(endpoint) })
  const baseURL = await gateway.ensureStarted()
  t.after(() => gateway.close())

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', reasoning_effort: 'low', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(text.includes('Valid answer from B'))
  assert.equal(text.includes("Sorry, I can't respond"), false)
})

test('模型级 429 仅冷却该模型及共享窗口别名，且模型发现不推进对话轮询游标', async t => {
  const seenUsers: string[] = []
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.from(c))
    const raw = Buffer.concat(chunks)
    const userId = String(req.headers['x-user-id'] ?? '')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v3/config') {
      return res.end(JSON.stringify({
        code: 0,
        data: {
          agents: [{ name: 'cli', models: ['deepseek-v4.1-flash', 'glm-5.3'] }],
          models: [
            { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00' },
            { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.05' },
          ],
        },
      }))
    }
    if (req.url === '/v2/chat/completions') {
      const body = JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'))
      seenUsers.push(`${userId}:${body.model}`)
      if (userId === 'u-1' && body.model.startsWith('deepseek-v4.1-flash')) {
        res.statusCode = 429
        return res.end(JSON.stringify({
          error: {
            message: '429 usage exceeds frequency limit, your usage will reset at 2099-10-20 19:47:41 UTC+8, alternatively, you can switch to the other models to continue using it.',
          },
        }))
      }
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: `${userId}:${body.model}` }, finish_reason: 'stop' }] }))
    }
    res.statusCode = 404
    return res.end('{}')
  })
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => upstream.close(() => done())))
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

  const pool = new AccountPoolStore(() => undefined)
  await pool.upsertSignedIn({ realm: 'cn', uid: 'u-1', nickname: '账号1', access: 'tok-1', expires: Date.now() + 3600_000 })
  await pool.upsertSignedIn({ realm: 'cn', uid: 'u-2', nickname: '账号2', access: 'tok-2', expires: Date.now() + 3600_000 })

  const gateway = new LocalGatewayServer({ pool, sites: makeTestSites(endpoint) })
  const baseURL = await gateway.ensureStarted()
  t.after(() => gateway.close())

  // Calling /v1/models multiple times must not advance the round-robin cursor
  await fetch(`${baseURL}/models`, { headers: { authorization: `Bearer ${gateway.token}` } })
  await fetch(`${baseURL}/models`, { headers: { authorization: `Bearer ${gateway.token}` } })

  // First chat starts at u-1 (cursor 0), hits model 429 on deepseek-v4.1-flash, and fails over to u-2
  const r1 = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', reasoning_effort: 'low', messages: [{ role: 'user', content: '1' }] }),
  })
  assert.equal(r1.status, 200)
  assert.deepEqual(seenUsers, ['u-1:deepseek-v4.1-flash', 'u-2:deepseek-v4.1-flash'])

  // Shared window alias deepseek-v4.1-flash-sg is also cooled on u-1, so it skips u-1 and goes directly to u-2
  seenUsers.length = 0
  const r2 = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-sg', reasoning_effort: 'low', messages: [{ role: 'user', content: '2' }] }),
  })
  assert.equal(r2.status, 200)
  assert.deepEqual(seenUsers, ['u-2:deepseek-v4.1-flash-sg'])

  // Other models (glm-5.3) can still use u-1!
  const items = await pool.listAccountItems()
  const item1 = items.find(i => i.file.includes('u-1'))!
  assert.equal(item1.cooling, false)
  assert.deepEqual(item1.coolingModels?.sort(), ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg'])
  const candidatesForGlm = await pool.selectCandidates({ model: 'glm-5.3', advanceCursor: false })
  assert.equal(candidatesForGlm.length, 2)
})

test('401 reissued 重读并发刷新、裸 401 保留登录态与 >2MiB 断连探测恢复', async t => {
  let refreshCalls = 0
  let meter401 = false
  const upstream = createServer(async (req, res) => {
    const auth = String(req.headers.authorization ?? '')
    if (req.url === '/v2/chat/completions' && auth === 'Bearer tok-big-reset') {
      req.socket.destroy()
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.from(c))
    res.setHeader('content-type', 'application/json')

    if (req.url === '/v2/plugin/auth/token/refresh') {
      refreshCalls++
      return res.end(JSON.stringify({ code: 0, data: { accessToken: 'tok-refreshed', refreshToken: 'ref-2', expiresIn: 3600 } }))
    }
    if (req.url === '/billing/meter/get-user-resource-summary') {
      if (meter401 && auth !== 'Bearer tok-refreshed') {
        res.statusCode = 401
        res.setHeader('www-authenticate', 'Bearer realm="copilot", error="invalid_token"')
        return res.end(JSON.stringify({ code: 401, msg: 'invalid token' }))
      }
      return res.end(JSON.stringify({ code: 0, data: { Packages: [] } }))
    }
    if (req.url === '/v2/chat/completions') {
      if (auth === 'Bearer tok-bare-401') {
        res.statusCode = 401
        return res.end(JSON.stringify({ code: 401, msg: 'bare 401 without invalid_token' }))
      }
      if (auth === 'Bearer tok-stale-concurrent') {
        await poolRef?.updateAccount(concurrentAcctId, { access: 'tok-already-saved', expired: false })
        res.statusCode = 401
        res.setHeader('www-authenticate', 'Bearer realm="copilot", error="invalid_token"')
        return res.end('{}')
      }
      if (auth === 'Bearer tok-big-reset') {
        req.socket.destroy()
        return
      }
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: `ok:${auth}` }, finish_reason: 'stop' }] }))
    }
    res.statusCode = 404
    return res.end('{}')
  })
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => upstream.close(() => done())))
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

  const pool = new AccountPoolStore(() => undefined)
  let poolRef: AccountPoolStore | undefined = pool
  let concurrentAcctId = ''
  // 1) Bare 401 on an account without refresh token should NOT mark expired
  const bareAcct = await pool.upsertSignedIn({ realm: 'cn', uid: 'u-bare', nickname: '裸401', access: 'tok-bare-401' })
  const gateway = new LocalGatewayServer({ pool, sites: makeTestSites(endpoint) })
  const baseURL = await gateway.ensureStarted()
  t.after(() => gateway.close())

  const bareRes = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', reasoning_effort: 'low', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(bareRes.status, 401)
  assert.equal(bareRes.headers.get('x-magpie-sign-in'), 'kept')
  const bareErr = await bareRes.json() as any
  assert.match(bareErr.error.message, /refused this account's sign-in/)
  assert.equal((await pool.getAccount(bareAcct.id))?.expired, false)

  // 2) Concurrent refresh: stored account already has a newer access token when reissued() runs
  await pool.removeAccount(bareAcct.id)
  const concAcct = await pool.upsertSignedIn({
    realm: 'cn', uid: 'u-conc', nickname: '并发刷新', access: 'tok-stale-concurrent', refresh: 'ref-conc', expires: Date.now() + 3600_000,
  })
  concurrentAcctId = concAcct.id
  const concRes = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', reasoning_effort: 'low', messages: [{ role: 'user', content: 'conc' }] }),
  })
  assert.equal(concRes.status, 200)
  assert.equal(concRes.headers.get('x-magpie-sign-in'), 'renewed')
  assert.equal(refreshCalls, 0)

  // 3) > 2 MiB connection reset probes meter -> gets 401 -> reissues token -> succeeds on retry
  await pool.removeAccount(concAcct.id)
  const bigAcct = await pool.upsertSignedIn({
    realm: 'cn', uid: 'u-big', nickname: '大请求账号', access: 'tok-big-reset', refresh: 'ref-1', expires: Date.now() + 3600_000,
  })
  meter401 = true
  const uncompressible = randomBytes(Math.ceil(2.2 * 1024 * 1024)).toString('base64')
  const bigRes = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', reasoning_effort: 'low', messages: [{ role: 'user', content: uncompressible }] }),
  })
  assert.equal(bigRes.status, 200)
  assert.equal(bigRes.headers.get('x-magpie-sign-in'), 'renewed')
  assert.equal(refreshCalls, 1)
  assert.equal((await pool.getAccount(bigAcct.id))?.access, 'tok-refreshed')
})

test('积分计算对齐 CycleTotalCapacity-CycleUsedCapacity 与详情列表额外额度，并支持原生 /v1/messages 与 11159 签名恢复', async t => {
  let messagesCalls = 0
  let configCalls = 0
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.from(c))
    const rawText = Buffer.concat(chunks).toString('utf8')
    res.setHeader('content-type', 'application/json')

    if (req.url === '/v3/config') {
      configCalls++
      res.statusCode = 500
      return res.end('{"code":500,"msg":"config down"}')
    }
    if (req.url === '/billing/meter/get-user-resource-summary') {
      return res.end(JSON.stringify({
        code: 0,
        data: {
          SubscriptionPackageCode: 'TCACA_code_002_AkiJS3ZHF5',
          Packages: [
            { PackageCode: 'TCACA_code_002_AkiJS3ZHF5', CycleTotalCapacity: '500', CycleUsedCapacity: '120.5' },
          ],
        },
      }))
    }
    if (req.url === '/billing/meter/get-user-resource-paid-packages') {
      return res.end(JSON.stringify({
        code: 0,
        data: {
          TotalCount: 1,
          Accounts: [
            {
              PackageCode: 'TCACA_code_002_AkiJS3ZHF5',
              CycleCapacitySizePrecise: '500',
              CycleCapacityRemainPrecise: '379.5',
              CycleStartTime: '2026-11-01 00:00:00',
              CycleEndTime: '2099-12-01 00:00:00',
            },
          ],
        },
      }))
    }
    if (req.url === '/billing/meter/get-user-resource-free-packages') {
      return res.end(JSON.stringify({
        code: 0,
        data: {
          TotalCount: 1,
          Accounts: [
            {
              PackageCode: 'TCACA_code_007_nzdH5h4Nl0',
              CycleCapacitySizePrecise: '100',
              CycleCapacityRemainPrecise: '45.25',
              CycleEndTime: '2099-11-15 00:00:00',
            },
          ],
        },
      }))
    }
    if (req.url === '/v2/billing/meter/checkin-activity-status') {
      return res.end(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }))
    }
    if (req.url === '/v2/billing/meter/daily-checkin') {
      return res.end(JSON.stringify({ code: 0, data: { credit: 20, streak_days: 3, message: '签到成功' } }))
    }
    if (req.url === '/v1/messages') {
      messagesCalls++
      const body = JSON.parse(rawText)
      const blocks = body.messages[0].content
      // First call should have dropped unsigned thinking, keeping signed thinking
      if (messagesCalls === 1) {
        assert.equal(blocks.some((b: any) => b.type === 'thinking' && !b.signature), false)
        assert.equal(blocks.some((b: any) => b.type === 'thinking' && b.signature === 'foreign-sig'), true)
        res.statusCode = 400
        return res.end(JSON.stringify({ error: { code: '400001', internal_code: '11159', message: 'Invalid `signature` in `thinking` block' } }))
      }
      // Second call after 11159 should have dropped signed thinking too
      assert.equal(blocks.some((b: any) => b.type === 'thinking'), false)
      return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Claude native reply' }] }))
    }
    if (req.url === '/v2/chat/completions') {
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'chat ok' }, finish_reason: 'stop' }] }))
    }
    res.statusCode = 404
    return res.end('{}')
  })
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>(done => upstream.close(() => done())))
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  const sites = makeTestSites(endpoint)

  // Verify credit usage calculation: (500 - 120.5) + 45.25 = 424.75
  const usage = await fetchAccountUsage(sites.cn, { access: 'tok', uid: 'u-1' })
  assert.equal(usage.credits, 424.75)
  assert.ok(usage.cycleEnd?.startsWith('2099-11-30'))

  // Verify daily check-in
  const checkin = await checkinOf(sites.cn, { access: 'tok', uid: 'u-1' })
  assert.equal(checkin.outcome, 'claimed')
  assert.equal(checkin.credit, 20)
  assert.equal(checkin.streak, 3)

  // Verify native /v1/messages & 11159 retry & effortList negative cache
  const records = new Map<string, unknown>()
  const pool = new AccountPoolStore(() => ({
    readRecord: async k => records.get(k),
    modifyRecord: async (k, fn) => { const v = await fn(records.get(k)); records.set(k, v); return v },
    deleteRecord: async k => { records.delete(k) },
  }))
  await pool.upsertSignedIn({ realm: 'cn', uid: 'u-1', nickname: 'CN', access: 'tok', expires: Date.now() + 3600_000 })

  const gateway = new LocalGatewayServer({ pool, sites })
  const baseURL = await gateway.ensureStarted()
  t.after(() => gateway.close())

  const msgRes = await fetch(`${baseURL}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5.5',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'unsigned thought' },
            { type: 'thinking', thinking: 'signed thought', signature: 'foreign-sig' },
            { type: 'text', text: 'prior' },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
    }),
  })
  assert.equal(msgRes.status, 200)
  assert.equal(messagesCalls, 2)

  // Send two chat requests without reasoning_effort: failing /v3/config is cached in unlisted after the first
  await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: '1' }] }),
  })
  await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: '2' }] }),
  })
  assert.equal(configCalls, 1)

  // Verify credential store deletion clears in-memory state
  records.delete('workbuddy-manager/pool')
  assert.deepEqual(await pool.listAccounts(), [])
})
