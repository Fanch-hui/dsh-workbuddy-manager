import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import type { ManagerRequest } from '../manager/contract.js'
import { newCredentialRef, safeMessage, type Remote } from './connection.js'
import { restoreManagement } from './management-session.js'

type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
export interface AppRemote extends Remote {
  workbuddy: { manage(request: ManagerRequest): Promise<Result<unknown>> }
}
interface Account { file: string; nickname: string; note: string; realm: string; disabled: boolean; blocked: boolean; expired: boolean; inPool: boolean; cooling: boolean; credits: number | null }
interface Key { id: number; name: string; realm: string; enabled: boolean; quota: number | null; usedTokens: number | null; quotaCredit: number | null; usedCredit: number | null }
interface Overview { accounts: Account[]; keys: Key[]; poolAvailable: boolean; manageable: boolean }
interface Props { remote: AppRemote; address: string; writable: boolean; disabled: boolean; onBusyChange: (busy: boolean) => void; onKeySelected: (ref: string) => Promise<void>; onConnect: (address: string, active: () => boolean) => Promise<void> }

function accountStatus(account: Account, poolAvailable: boolean): string {
  if (account.disabled) return '已停用'
  if (account.blocked) return '已禁用'
  if (account.expired) return '授权过期'
  if (!poolAvailable) return '状态未知'
  if (!account.inPool) return '未进入账号池'
  if (account.cooling) return '冷却中'
  return '可用'
}

export function keyScope(realm: string): string {
  if (realm === 'cn') return '仅国内版模型'
  if (realm === 'global') return '仅国际版模型'
  return realm ? '版本限制未知' : '版本不限'
}

export async function copyLoginLink(url: string, clipboard: Pick<Clipboard, 'writeText'> | undefined): Promise<boolean> {
  if (!clipboard) return false
  try { await clipboard.writeText(url); return true } catch { return false }
}

function usage(value: number | null, quota: number | null, unit: string): string | undefined {
  if (value === null && quota === null) return undefined
  const used = value === null ? '未知' : value.toLocaleString()
  const limit = quota === null ? '未知' : quota === 0 ? '不限' : quota.toLocaleString()
  return `${unit} ${used} / ${limit}`
}

export function Management({ remote, address, writable, disabled, onBusyChange, onKeySelected, onConnect }: Props) {
  const [online, setOnline] = useState<'unknown' | 'online' | 'offline'>('unknown')
  const [role, setRole] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [overview, setOverview] = useState<Overview>()
  const [keyName, setKeyName] = useState('')
  const [keyRealm, setKeyRealm] = useState<'' | 'cn' | 'global'>('')
  const [editingKey, setEditingKey] = useState<number>()
  const [editingName, setEditingName] = useState('')
  const [realm, setRealm] = useState<'cn' | 'global'>('cn')
  const [region, setRegion] = useState('')
  const [authorization, setAuthorization] = useState<{ url: string; qr: string }>()
  const authorizationRef = useRef(authorization)
  authorizationRef.current = authorization
  const [qrStatus, setQrStatus] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const blocked = busy || disabled || restoring
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')

  const call = useCallback(async (request: ManagerRequest) => {
    const answer = await remote.workbuddy.manage(request)
    if (!answer.ok) throw new Error(answer.error.message)
    return answer.value
  }, [remote])

  const refresh = useCallback(async () => {
    setOverview(await call({ action: 'overview', address }) as Overview)
  }, [address, call])

  useEffect(() => {
    let active = true
    let checked = false
    let restoredRole = ''
    setRestoring(true); setOnline('unknown'); setLoggedIn(false); setRole(''); setOverview(undefined); setAuthorization(undefined); setQrStatus(''); setFailure(''); setMessage('')
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await restoreManagement(call, address, status => {
            if (!active) return false
            checked = true
            setOnline(status.online ? 'online' : 'offline')
            restoredRole = status.role || ''
            setLoggedIn(status.authenticated); setRole(restoredRole)
            return true
          })
          if (active && result !== undefined) {
            setOverview(result as Overview)
            if (restoredRole === 'admin') await onConnect(address, () => active)
          }
        } catch (error) {
          if (active) { if (!checked) setOnline('offline'); setFailure(safeMessage(error, '')) }
        } finally { if (active) setRestoring(false) }
      })()
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [address, call, onConnect])

  useEffect(() => {
    if (!authorization) return
    let cancelled = false
    let polling = false
    let finished = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (cancelled || polling || finished) return
      polling = true
      try {
        const result = await call({ action: 'authPoll', address }) as { status: string }
        if (cancelled) return
        if (result.status === 'success') {
          finished = true
          setQrStatus('账号授权成功，正在连接模型…')
          await refresh()
          if (!cancelled) await onConnect(address, () => !cancelled)
          if (!cancelled) { setAuthorization(undefined); setQrStatus(''); setMessage('账号授权成功。') }
          return
        }
        if (result.status === 'expired' || result.status === 'invalid') {
          finished = true
          setAuthorization(undefined); setQrStatus(''); setFailure('授权已失效，请重新获取登录链接。')
          return
        }
        setQrStatus(result.status === 'scanned' ? '已打开授权，请完成确认。' : '等待扫码或打开登录链接并确认…')
      } catch (error) {
        if (!cancelled) {
          if (finished) { setAuthorization(undefined); setQrStatus(''); setMessage('账号授权成功。') }
          setFailure(safeMessage(error, ''))
        }
      } finally { polling = false }
      if (!cancelled && !finished) timer = setTimeout(() => void poll(), 3000)
    }
    const wake = () => {
      if (cancelled || polling || finished || document.hidden) return
      clearTimeout(timer)
      void poll()
    }
    timer = setTimeout(() => void poll(), 3000)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      cancelled = true; clearTimeout(timer)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [address, call, authorization, refresh, onConnect])

  const run = async (operation: () => Promise<void>, secret = '') => {
    setBusy(true); onBusyChange(true); setFailure(''); setMessage('')
    try { await operation() } catch (error) { setFailure(safeMessage(error, secret)) }
    finally { setBusy(false); onBusyChange(false) }
  }

  const check = () => run(async () => {
    let status: { online: boolean; authenticated: boolean; role?: string }
    try { status = await call({ action: 'health', address }) as typeof status }
    catch (error) { setOnline('offline'); throw error }
    setOnline(status.online ? 'online' : 'offline')
    setLoggedIn(status.authenticated); setRole(status.role || '')
    if (status.authenticated) {
      await refresh()
      if (status.role === 'admin') await onConnect(address, () => true)
    }
  })

  const login = (event: FormEvent) => {
    event.preventDefault()
    const secret = password
    setPassword('')
    void run(async () => {
      const result = await call({ action: 'login', address, username, password: secret }) as { role: string }
      setOnline('online'); setLoggedIn(true); setRole(result.role)
      await refresh()
      if (result.role === 'admin') await onConnect(address, () => true)
    }, secret)
  }

  const logout = () => run(async () => {
    await call({ action: 'logout', address })
    setLoggedIn(false); setRole(''); setOverview(undefined); setAuthorization(undefined); setMessage('已退出管理会话。')
  })

  const startAuth = () => run(async () => {
    setAuthorization(undefined); setCopyStatus(''); setQrStatus('')
    const result = await call({ action: 'authStart', address, realm, region }) as { authUrl: string }
    let qr = ''
    try { qr = await QRCode.toDataURL(result.authUrl, { width: 200, margin: 2 }) }
    catch { setFailure('二维码生成失败，请使用登录链接。') }
    setAuthorization({ url: result.authUrl, qr })
    setQrStatus('等待扫码或打开登录链接并确认…')
  })

  const copyAuthorization = async () => {
    if (!authorization) return
    const copied = await copyLoginLink(authorization.url, navigator.clipboard)
    if (authorizationRef.current !== authorization) return
    setCopyStatus(copied ? '登录链接已复制。' : '无法自动复制，请选中上方链接手动复制。')
  }

  const createKey = (event: FormEvent) => {
    event.preventDefault()
    if (!window.confirm('新密钥默认不限额度，确认创建？')) return
    void run(async () => {
      await call({ action: 'createKey', address, name: keyName, realm: keyRealm })
      setKeyName(''); await refresh(); setMessage('密钥已创建。可选择将它用于 DSH。')
    })
  }

  const setAccount = (account: Account) => {
    const disabled = !(account.disabled || account.blocked)
    if (!window.confirm(`确认${disabled ? '停用' : '启用'}该账号？`)) return
    void run(async () => {
      await call({ action: 'accountDisabled', address, file: account.file, disabled })
      await refresh(); setMessage(disabled ? '账号已停用。' : '账号已启用。')
    })
  }

  const setKeyEnabled = (key: Key) => {
    const enabled = !key.enabled
    if (!window.confirm(`确认${enabled ? '启用' : '停用'}该网关密钥？`)) return
    void run(async () => {
      await call({ action: 'keyEnabled', address, id: key.id, enabled })
      await refresh(); setMessage(enabled ? '密钥已启用。' : '密钥已停用。')
    })
  }

  const renameKey = (event: FormEvent, key: Key) => {
    event.preventDefault()
    void run(async () => {
      await call({ action: 'renameKey', address, id: key.id, name: editingName })
      setEditingKey(undefined); await refresh(); setMessage('密钥名称已更新。')
    })
  }

  const useKey = (key: Key) => run(async () => {
    const ref = newCredentialRef()
    await call({ action: 'useKey', address, id: key.id, ref })
    try { await onKeySelected(ref) } catch (error) { throw new Error(`用于 DSH 失败：${safeMessage(error, '')}`) }
    setMessage('密钥已安全保存，模型已同步到 DSH。')
  })

  const usableAccounts = overview?.accounts.filter(account => accountStatus(account, overview.poolAvailable) === '可用').length ?? 0
  const enabledKeys = overview?.keys.filter(key => key.enabled).length ?? 0
  const managerStatus = restoring ? '正在检查服务…' : online === 'online' ? '服务在线' : online === 'offline' ? '服务离线' : '尚未检查服务'

  return <>
    <section className="wb-card" aria-busy={busy || restoring} aria-labelledby="workbuddy-management-title">
      <div className="wb-status"><div><h3 id="workbuddy-management-title">管理服务</h3><p className="wb-muted" role="status">{managerStatus}{loggedIn ? ' · 已登录' : ''}</p></div>
        <div className="wb-actions"><button type="button" disabled={blocked} onClick={() => void check()}>检查服务</button>{loggedIn && <button type="button" disabled={blocked} onClick={() => void logout()}>退出管理</button>}</div>
      </div>
      {!loggedIn && !restoring && <form onSubmit={login}>
        <label htmlFor="workbuddy-manager-user">管理用户名<input id="workbuddy-manager-user" autoComplete="username" value={username} required disabled={blocked} onChange={event => setUsername(event.target.value)} /></label>
        <label htmlFor="workbuddy-manager-password">管理密码<input id="workbuddy-manager-password" type="password" autoComplete="current-password" value={password} required disabled={blocked} onChange={event => setPassword(event.target.value)} /></label>
        <p className="wb-muted">管理员登录后会自动连接模型；登录会话保存在 DSH 凭据存储中。</p>
        <div className="wb-actions"><button type="submit" disabled={blocked}>登录管理服务</button></div>
      </form>}
      {loggedIn && role !== 'admin' && <p className="wb-muted">账号池模型连接需要管理员登录。</p>}
      {failure && <p className="wb-error" role="alert">{failure}</p>}
      {message && <p className="wb-success" role="status">{message}</p>}
    </section>
    {loggedIn && overview && <>
      <section className="wb-summary" aria-label="管理概览">
        <div><span>账号</span><strong>{overview.accounts.length}</strong></div>
        <div><span>可用账号</span><strong>{overview.poolAvailable ? usableAccounts : '—'}</strong></div>
        <div><span>启用密钥</span><strong>{enabledKeys} <small>/ {overview.keys.length}</small></strong></div>
      </section>
      <section className="wb-card" aria-labelledby="workbuddy-accounts-title">
        <div className="wb-status"><div><h3 id="workbuddy-accounts-title">账号管理</h3><p className="wb-muted">{overview.poolAvailable ? '账号池已连接' : '账号池未连接'}{!overview.manageable ? ' · 当前分组不可管理' : ''}</p></div><button type="button" disabled={blocked} onClick={() => void run(refresh)}>刷新</button></div>
        {overview.accounts.length === 0 ? <p className="wb-empty">当前没有账号。</p> : <ul className="wb-records">{overview.accounts.map(account => <li key={account.file}>
          <div className="wb-record-main"><strong>{account.note || account.nickname || '未命名账号'}</strong><p className="wb-muted">{account.realm === 'global' ? '国际版' : account.realm === 'cn' ? '国内版' : '版本未知'} · {accountStatus(account, overview.poolAvailable)}{account.credits !== null ? ` · 积分 ${account.credits.toLocaleString()}` : ''}</p></div>
          {role === 'admin' && overview.manageable && <button type="button" disabled={blocked} onClick={() => setAccount(account)}>{account.disabled || account.blocked ? '启用' : '停用'}</button>}
        </li>)}</ul>}
        {role === 'admin' && overview.manageable && <details className="wb-details"><summary>添加账号</summary><div className="wb-detail-body">
          <label htmlFor="workbuddy-realm">账号版本<select id="workbuddy-realm" value={realm} disabled={blocked} onChange={event => { setRealm(event.target.value as 'cn' | 'global'); setAuthorization(undefined); setCopyStatus('') }}><option value="cn">国内版</option><option value="global">国际版</option></select></label>
          {realm === 'global' && <label htmlFor="workbuddy-region">国际版地区代码<input id="workbuddy-region" value={region} disabled={blocked} onChange={event => { setRegion(event.target.value); setAuthorization(undefined); setCopyStatus('') }} placeholder="例如 HK" /></label>}
          <div className="wb-actions"><button type="button" disabled={blocked} onClick={() => void startAuth()}>获取登录链接或扫码</button></div>
          {authorization && <div className="wb-detail-body">
            {authorization.qr && <img src={authorization.qr} width="200" height="200" alt="WorkBuddy 账号授权二维码" />}
            <label htmlFor="workbuddy-auth-url">登录链接<input id="workbuddy-auth-url" value={authorization.url} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /></label>
            <div className="wb-actions"><button type="button" onClick={() => void copyAuthorization()}>复制登录链接</button><a href={authorization.url} target="_blank" rel="noopener noreferrer">打开登录链接</a><button type="button" onClick={() => setAuthorization(undefined)}>关闭</button></div>
            <p className="wb-muted" role="status">{qrStatus}</p>
            {copyStatus && <p className="wb-muted" role="status">{copyStatus}</p>}
          </div>}
        </div></details>}
      </section>
      <section className="wb-card" aria-labelledby="workbuddy-keys-title">
        <div className="wb-status"><div><h3 id="workbuddy-keys-title">网关密钥</h3><p className="wb-muted">{overview.keys.length} 个密钥</p></div></div>
        {overview.keys.length === 0 ? <p className="wb-empty">当前没有密钥。</p> : <ul className="wb-records">{overview.keys.map(key => <li key={key.id}>
          <div className="wb-record-main"><strong>{key.name || '未命名密钥'}</strong><p className="wb-muted">编号 {key.id} · {key.enabled ? '已启用' : '已停用'} · {keyScope(key.realm)}</p><p className="wb-muted">{[usage(key.usedTokens, key.quota, 'Tokens'), usage(key.usedCredit, key.quotaCredit, '积分')].filter(Boolean).join(' · ')}</p>
            {editingKey === key.id && <form className="wb-rename" onSubmit={event => renameKey(event, key)}><label htmlFor={`workbuddy-rename-${key.id}`}>密钥名称<input id={`workbuddy-rename-${key.id}`} value={editingName} maxLength={64} required disabled={blocked} onChange={event => setEditingName(event.target.value)} /></label><div className="wb-actions"><button type="submit" disabled={blocked}>保存名称</button><button type="button" disabled={blocked} onClick={() => setEditingKey(undefined)}>取消</button></div></form>}
          </div>
          {role === 'admin' && <div className="wb-actions"><button type="button" disabled={blocked || !writable || !key.enabled} onClick={() => void useKey(key)}>用于 DSH</button><button type="button" disabled={blocked} onClick={() => { setEditingKey(key.id); setEditingName(key.name) }}>改名称</button><button type="button" disabled={blocked} onClick={() => setKeyEnabled(key)}>{key.enabled ? '停用' : '启用'}</button></div>}
        </li>)}</ul>}
        {role === 'admin' && <details className="wb-details"><summary>创建密钥</summary><form className="wb-detail-body" onSubmit={createKey}><label htmlFor="workbuddy-new-key">密钥名称<input id="workbuddy-new-key" value={keyName} maxLength={64} required disabled={blocked} onChange={event => setKeyName(event.target.value)} /></label><label htmlFor="workbuddy-key-realm">模型版本限制<select id="workbuddy-key-realm" value={keyRealm} disabled={blocked} onChange={event => setKeyRealm(event.target.value as '' | 'cn' | 'global')}><option value="">不限</option><option value="cn">仅国内版</option><option value="global">仅国际版</option></select></label><p className="wb-muted">新密钥默认不限额度。</p><div className="wb-actions"><button type="submit" disabled={blocked}>创建密钥</button></div></form></details>}
        {!writable && <p className="wb-muted">当前 DSH 模型配置或凭据存储不可写，无法选择密钥。</p>}
      </section>
    </>}
  </>
}
