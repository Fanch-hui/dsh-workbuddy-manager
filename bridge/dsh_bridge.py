"""DSH model access scoped to an authenticated management session."""
from __future__ import annotations

import hashlib
import hmac
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import config, security
from . import gateway, responses

router = APIRouter(prefix='/api/dsh', tags=['dsh-bridge'])


def _grant_secret(secret: str) -> str:
    return hmac.new(secret.encode(), b'dsh-model-bridge-v1', hashlib.sha256).hexdigest()


@router.post('/session')
def create_session(request: Request, user: dict = Depends(security.require_session_admin)) -> dict:
    cfg = security.load_users()
    session = security._unsign(request.cookies.get(config.COOKIE_NAME) or '', cfg['secret'])
    if not session:
        raise HTTPException(status_code=401, detail='登录已失效，请重新登录')
    now = int(time.time())
    grant = {
        'username': user['username'],
        'sv': security.session_version(cfg, user['username']),
        'iat': now,
        'exp': int(session['exp']),
        'scope': 'dsh-models',
    }
    ip = gateway.iputil.client_ip(request)
    security.audit(user, 'dsh_bridge_session', '', f'来源 {ip}', ip=ip)
    return {'token': security._sign(json.dumps(grant, separators=(',', ':')), _grant_secret(cfg['secret']))}


def authorize(request: Request, model: str | None, *, is_model_list: bool = False, mapped: str | None = None):
    ip = gateway.iputil.client_ip(request)
    ua = request.headers.get('user-agent')
    token = gateway._bearer(request)
    cfg = security.load_users()
    grant = security._unsign(token, _grant_secret(cfg['secret'])) if token else None
    if not isinstance(grant, dict) or grant.get('scope') != 'dsh-models' or security.idle_expired(grant):
        gateway._log_ip(ip, request.url.path, True, ua, 'invalid_key')
        return None, ip, gateway._oai_error('桥接会话已失效，请重新登录', 401, 'authentication_error', 'invalid_session')
    username = grant.get('username')
    row = next((u for u in cfg.get('users', []) if u.get('username') == username), None)
    if not row or row.get('role') != 'admin' or grant.get('sv') != security.session_version(cfg, username):
        return None, ip, gateway._oai_error('桥接会话已失效，请重新登录', 401, 'authentication_error', 'invalid_session')
    if gateway._global_ip_blocked(ip):
        gateway._log_ip(ip, request.url.path, True, ua, 'ip_blocked')
        return None, ip, gateway._oai_error('来源 IP 被安全策略拦截', 403, 'permission_error', 'ip_blocked')
    user_hash = hashlib.sha256(username.encode()).digest()[:8]
    limited, _ = gateway._rate_limited({'id': -1 - int.from_bytes(user_hash, 'big')})
    if limited:
        return None, ip, gateway._oai_error('请求过于频繁', 429, 'rate_limit_error', 'rate_limit_exceeded', retry_after=gateway.RATE_WINDOW)
    gateway._log_ip(ip, request.url.path, False, ua)
    return None, ip, None


@router.get('/v1/models')
async def list_models(request: Request):
    return await gateway._list_models(request, authorize=authorize)


@router.post('/v1/responses')
async def create_response(request: Request):
    return await responses._handle(request, authorize=authorize)
