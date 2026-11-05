import json
import time
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from server import config, security, upstreamsvc
from server.main import app
from server.routers import gateway


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.users = {'secret': 'fixture-signing-secret', 'users': [
            {'username': 'admin', 'role': 'admin', 'sv': 1},
            {'username': 'viewer', 'role': 'viewer', 'sv': 0},
        ]}
        self.calls = []
        self.patches = [
            patch.object(security, 'load_users', side_effect=lambda: self.users),
            patch.object(security, 'audit'),
            patch.object(config, 'SESSION_IDLE_HOURS', 24),
            patch.object(gateway, '_log_ip'),
            patch.object(gateway, '_record'),
            patch.object(gateway, '_global_ip_blocked', return_value=False),
            patch.object(gateway, '_map_model', return_value=None),
            patch.object(gateway, '_upstream_headers', return_value={}),
            patch.object(upstreamsvc, 'resolve_for_key', return_value={'base_url': 'http://fixture'}),
            patch.object(config, 'http_client', side_effect=lambda *a, **kw: httpx.AsyncClient(transport=httpx.MockTransport(self.upstream))),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def cookie(self, username='admin'):
        now = int(time.time())
        user = next(item for item in self.users['users'] if item['username'] == username)
        return security._sign(json.dumps({'username': username, 'sv': user['sv'], 'iat': now, 'orig': now, 'exp': now + 3600}), self.users['secret'])

    def grant(self):
        response = self.client.post('/api/dsh/session', cookies={config.COOKIE_NAME: self.cookie()})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['token']

    def upstream(self, request):
        self.calls.append(request)
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'object': 'list', 'data': [{'id': 'fixture-model', 'object': 'model'}]})
        body = json.loads(request.content)
        self.assertEqual(body['model'], 'fixture-model')
        self.assertEqual(body['tools'][0]['function']['name'], 'read_file')
        if body.get('stream'):
            frames = [
                {'id': 'chat-test', 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call-test', 'type': 'function', 'function': {'name': 'read_file', 'arguments': ''}}]}, 'finish_reason': None}]},
                {'id': 'chat-test', 'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '{"path":"README.md"}'}}]}, 'finish_reason': None}]},
                {'id': 'chat-test', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}},
            ]
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, text=''.join('data: ' + json.dumps(frame) + '\n\n' for frame in frames) + 'data: [DONE]\n\n')
        return httpx.Response(200, json={'id': 'chat-test', 'created': 1, 'model': 'fixture-model', 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call-test', 'type': 'function', 'function': {'name': 'read_file', 'arguments': '{"path":"README.md"}'}}]}, 'finish_reason': 'tool_calls'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})

    def test_session_scope_and_revocation(self):
        self.assertEqual(self.client.post('/api/dsh/session').status_code, 401)
        self.assertEqual(self.client.post('/api/dsh/session', cookies={config.COOKIE_NAME: self.cookie('viewer')}).status_code, 403)
        token = self.grant()
        self.assertEqual(self.client.get('/api/dsh/v1/models').status_code, 401)
        self.assertEqual(self.client.get('/api/dsh/v1/models', headers={'Authorization': 'Bearer ' + self.cookie()}).status_code, 401)
        self.assertEqual(self.client.get('/api/me', cookies={config.COOKIE_NAME: token}).status_code, 401)
        headers = {'Authorization': 'Bearer ' + token}
        self.assertEqual(self.client.get('/api/dsh/v1/models', headers=headers).status_code, 200)
        with patch.object(gateway, '_global_ip_blocked', return_value=True):
            self.assertEqual(self.client.get('/api/dsh/v1/models', headers=headers).status_code, 403)
        with patch.object(gateway, '_rate_limited', return_value=(True, 1)):
            self.assertEqual(self.client.get('/api/dsh/v1/models', headers=headers).status_code, 429)
        self.assertEqual(self.client.get('/v1/models', headers=headers).status_code, 401)
        self.assertEqual(self.client.get('/v1/models?authorize=fixture', headers=headers).status_code, 401)
        self.users['users'][0]['sv'] += 1
        self.assertEqual(self.client.get('/api/dsh/v1/models', headers=headers).status_code, 401)

    def test_responses_preserve_streaming_and_tool_calls(self):
        headers = {'Authorization': 'Bearer ' + self.grant()}
        body = {'model': 'fixture-model', 'input': 'read README', 'tools': [{'type': 'function', 'name': 'read_file', 'description': 'Read file', 'parameters': {'type': 'object', 'properties': {'path': {'type': 'string'}}}}]}
        plain = self.client.post('/api/dsh/v1/responses', headers=headers, json=body)
        self.assertEqual(plain.status_code, 200, plain.text)
        self.assertEqual(plain.json()['output'][0]['name'], 'read_file')
        stream = self.client.post('/api/dsh/v1/responses', headers=headers, json={**body, 'stream': True})
        self.assertEqual(stream.status_code, 200, stream.text)
        self.assertIn('response.function_call_arguments.delta', stream.text)
        self.assertIn('read_file', stream.text)
        self.assertIn('response.completed', stream.text)


if __name__ == '__main__':
    unittest.main()
