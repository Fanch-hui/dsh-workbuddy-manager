import { useCallback, useEffect, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import type { ManagerRequest } from '../manager/contract.js'
import { newCredentialRef, safeMessage, type Remote } from './connection.js'

type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
export interface AppRemote extends Remote {
  workbuddy: { manage(request: ManagerRequest): Promise<Result<unknown>> }
}
interface Account { file: string; nickname: string; realm: string; disabled: boolean; blocked: boolean; expired: boolean; inPool: boolean; cooling: boolean; credits: number | null }
interface Key { id: number; name: string; realm: string; enabled: boolean; usedTokens: number | null; usedCredit: number | null }
interface Overview { accounts: Account[]; keys: Key[]; poolAvailable: boolean; manageable: boolean }
interface Props { remote: AppRemote; address: string; writable: boolean; disabled: boolean; onBusyChange: (busy: boolean) => void; onKeySelected: (ref: string) => Promise<void> }

function accountStatus(account: Account, poolAvailable: boolean): string {
  if (account.disabled) return '已停用'
  if (account.blocked) return '已禁用'
  if (account.expired) return '授权过期'
  if (!poolAvailable) return '状态未知'
  if (!account.inPool) return '未进入账号池'
  if (account.cooling) return '冷却中'
  return '可用'
}

export function Management({ remote, address, writable, disabled, onBusyChange, onKeySelected }: Props) {
  const [online, setOnline] = useState<'unknown' | 'online' | 'offline'>('unknown')
  const [role, setRole] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [overview, setOverview] = useState<Overview>()
  const [keyName, setKeyName] = useState('')
  const [keyRealm, setKeyRealm] = useState<'cn' | 'global'>('cn')
  const [realm, setRealm] = useState<'cn' | 'global'>('cn')
  const [region, setRegion] = useState('')
  const [qr, setQr] = useState('')
  const [qrStatus, setQrStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const blocked = busy || disabled
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
    setOnline('unknown'); setLoggedIn(false); setRole(''); setOverview(undefined); setQr(''); setQrStatus('')
  }, [address])

  useEffect(() => {
    if (!qr) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await call({ action: 'authPoll', address }) as { status: string }
        if (cancelled) return
        if (result.status === 'success') {
          setQr(''); setQrStatus(''); setMessage('账号授权成功，正在更新账号列表。')
          await refresh()
          return
        }
        if (result.status === 'expired' || result.status === 'invalid') {
          setQr(''); setQrStatus(''); setFailure('授权二维码已失效，请重新生成。')
          return
        }
        setQrStatus(result.status === 'scanned' ? '已扫码，请在手机上确认。' : '等待扫码与确认…')
      } catch (error) {
        if (!cancelled) setFailure(safeMessage(error, ''))
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 3000)
    }
    timer = setTimeout(() => void poll(), 3000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [address, call, qr, refresh])

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
    if (status.authenticated) await refresh()
  })

  const login = (event: FormEvent) => {
    event.preventDefault()
    const secret = password
    setPassword('')
    void run(async () => {
      const result = await call({ action: 'login', address, username, password: secret }) as { role: string }
      setOnline('online'); setLoggedIn(true); setRole(result.role)
      await refresh()
    }, secret)
  }

  const logout = () => run(async () => {
    await call({ action: 'logout', address })
    setLoggedIn(false); setRole(''); setOverview(undefined); setQr(''); setMessage('已退出管理会话。')
  })

  const startAuth = () => run(async () => {
    const result = await call({ action: 'authStart', address, realm, region }) as { authUrl: string }
    setQr(await QRCode.toDataURL(result.authUrl, { width: 200, margin: 2 }))
    setQrStatus('等待扫码与确认…')
  })

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

  const useKey = (key: Key) => run(async () => {
    const ref = newCredentialRef()
    await call({ action: 'useKey', address, id: key.id, ref })
    try { await onKeySelected(ref) } catch (error) { throw new Error(`密钥已保存，但模型同步失败：${safeMessage(error, '')}`) }
    setMessage('密钥已安全保存，模型已同步到 DSH。')
  })

  return <>
    <section className="wb-card" aria-busy={busy} aria-labelledby="workbuddy-management-title">
      <div className="wb-status"><div><h3 id="workbuddy-management-title">管理服务</h3><p className="wb-muted" role="status">{online === 'online' ? '服务在线' : online === 'offline' ? '服务离线' : '尚未检查服务'}{loggedIn ? ' · 已登录' : ''}</p></div>
        <div className="wb-actions"><button type="button" disabled={blocked} onClick={() => void check()}>检查服务</button>{loggedIn && <button type="button" disabled={blocked} onClick={() => void logout()}>退出管理</button>}</div>
      </div>
      {!loggedIn && <form onSubmit={login}>
        <label htmlFor="workbuddy-manager-user">管理用户名<input id="workbuddy-manager-user" autoComplete="username" value={username} required disabled={blocked} onChange={event => setUsername(event.target.value)} /></label>
        <label htmlFor="workbuddy-manager-password">管理密码<input id="workbuddy-manager-password" type="password" autoComplete="current-password" value={password} required disabled={blocked} onChange={event => setPassword(event.target.value)} /></label>
        <p className="wb-muted">使用 WorkBuddy Manager 的管理账号登录；会话只保存在本次 DSH 宿主进程中。</p>
        <div className="wb-actions"><button type="submit" disabled={blocked}>登录管理服务</button></div>
      </form>}
      {failure && <p className="wb-error" role="alert">{failure}</p>}
      {message && <p className="wb-success" role="status">{message}</p>}
    </section>
    {loggedIn && overview && <>
      <section className="wb-card" aria-labelledby="workbuddy-accounts-title">
        <div className="wb-status"><h3 id="workbuddy-accounts-title">账号 · {overview.accounts.length}</h3><button type="button" disabled={blocked} onClick={() => void run(refresh)}>刷新</button></div>
        <p className="wb-muted">{overview.poolAvailable ? '账号池已连接' : '账号池未连接'}{!overview.manageable ? ' · 当前分组不可管理' : ''}</p>
        {overview.accounts.length === 0 ? <p className="wb-muted">当前没有账号。</p> : <ul className="wb-records">{overview.accounts.map(account => <li key={account.file}>
          <div><strong>{account.nickname || '未命名'}</strong><p className="wb-muted">{account.realm === 'global' ? '国际版' : '国内版'} · {accountStatus(account, overview.poolAvailable)}{account.credits !== null ? ` · 积分 ${account.credits}` : ''}</p></div>
          {role === 'admin' && overview.manageable && <button type="button" disabled={blocked} onClick={() => setAccount(account)}>{account.disabled || account.blocked ? '启用' : '停用'}</button>}
        </li>)}</ul>}
        {role === 'admin' && overview.manageable && <div className="wb-auth">
          <label htmlFor="workbuddy-realm">账号版本<select id="workbuddy-realm" value={realm} disabled={blocked} onChange={event => setRealm(event.target.value as 'cn' | 'global')}><option value="cn">国内版</option><option value="global">国际版</option></select></label>
          {realm === 'global' && <label htmlFor="workbuddy-region">国际版地区代码<input id="workbuddy-region" value={region} disabled={blocked} onChange={event => setRegion(event.target.value)} placeholder="例如 HK" /></label>}
          <div className="wb-actions"><button type="button" disabled={blocked} onClick={() => void startAuth()}>扫码添加账号</button></div>
          {qr && <div><img src={qr} width="200" height="200" alt="WorkBuddy 账号授权二维码" /><p className="wb-muted" role="status">{qrStatus}</p><button type="button" onClick={() => setQr('')}>关闭二维码</button></div>}
        </div>}
      </section>
      <section className="wb-card" aria-labelledby="workbuddy-keys-title">
        <h3 id="workbuddy-keys-title">网关密钥 · {overview.keys.length}</h3>
        {overview.keys.length === 0 ? <p className="wb-muted">当前没有密钥。</p> : <ul className="wb-records">{overview.keys.map(key => <li key={key.id}>
          <div><strong>{key.name || `密钥 ${key.id}`}</strong><p className="wb-muted">{key.realm === 'global' ? '国际版' : '国内版'} · {key.enabled ? '已启用' : '已停用'}{key.usedTokens !== null ? ` · 已用 ${key.usedTokens} tokens` : ''}{key.usedCredit !== null ? ` · 积分 ${key.usedCredit}` : ''}</p></div>
          {role === 'admin' && <div className="wb-actions"><button type="button" disabled={blocked || !writable || !key.enabled} onClick={() => void useKey(key)}>用于 DSH</button><button type="button" disabled={blocked} onClick={() => setKeyEnabled(key)}>{key.enabled ? '停用' : '启用'}</button></div>}
        </li>)}</ul>}
        {role === 'admin' && <form onSubmit={createKey}><label htmlFor="workbuddy-new-key">新密钥名称<input id="workbuddy-new-key" value={keyName} maxLength={64} required disabled={blocked} onChange={event => setKeyName(event.target.value)} /></label><label htmlFor="workbuddy-key-realm">密钥版本<select id="workbuddy-key-realm" value={keyRealm} disabled={blocked} onChange={event => setKeyRealm(event.target.value as 'cn' | 'global')}><option value="cn">国内版</option><option value="global">国际版</option></select></label><div className="wb-actions"><button type="submit" disabled={blocked}>创建密钥</button></div></form>}
        {!writable && <p className="wb-muted">当前 DSH 模型配置或凭据存储不可写，无法选择密钥。</p>}
      </section>
    </>}
  </>
}
