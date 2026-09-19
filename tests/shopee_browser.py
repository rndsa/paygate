"""Isolated synthetic UI tests, NOT evidence Shopee accepts automated login.
Run: /root/camofox-venv/bin/python -B tests/shopee_browser.py
Root fixtures disable sandbox explicitly; production worker never does.
"""
import asyncio
import base64
import time
import importlib.util
import json
from pathlib import Path
import unittest
import sys
import os
import signal

SOURCE = Path(__file__).resolve().parents[1] / 'src/services/shopee_browser.py'


def load_worker():
    assert SOURCE.exists(), 'browser-owned worker missing'
    spec = importlib.util.spec_from_file_location('worker_under_test', SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HTML = '''<!doctype html><html><body>
<form id="login"><input id="identifier" placeholder="No. handphone / Username / Email">
<input id="password" type="password" placeholder="Password"><button>Masuk</button></form>
<script>window.submissions=0; window.verifications=0;
login.onsubmit=e=>{e.preventDefault(); window.submissions++;
 window.filled=[identifier.value,password.value];
 document.body.innerHTML='<form id="verify"><input type="tel" autocomplete="one-time-code" maxlength="6"></form>';
 verify.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault(); window.verifications++; window.otp=verify.querySelector('input').value;}};
};</script></body></html>'''


class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.m = load_worker()
        self.worker = self.m.Worker(timeout=1, sandbox=False)
        await self.worker.open()
        self.html = HTML
        self.requests = []
        self.payload = {'token': 'B:synthetic_only', 'userid': 34, 'merchantId': 12, 'exp': int(time.time()) + 3600}
        self.profile = {'errorCode': 0, 'data': {'merchantId': 12, 'tobUserId': 34}}
        self.stores = {'code': 0, 'data': {'list': [{'storeId': 56, 'storeName': 'Synthetic shop'}], 'storeCount': 1}}

        async def fixture(route):
            self.requests.append(route.request.url)
            if route.request.url == self.m.LOGIN_URL:
                await route.fulfill(status=200, content_type='text/html', body=self.html)
            elif route.request.method == 'OPTIONS':
                await route.fulfill(status=204, headers={'access-control-allow-origin': '*',
                    'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
            elif route.request.url == self.m.PROFILE_URL:
                await route.fulfill(status=200, json=self.profile, headers={'access-control-allow-origin': '*'})
            elif route.request.url == self.m.STORES_URL:
                await route.fulfill(status=200, json=self.stores, headers={'access-control-allow-origin': '*'})
            elif route.request.url == 'https://partner.shopee.co.id/':
                payload = base64.urlsafe_b64encode(json.dumps(self.payload).encode()).decode().rstrip('=')
                body = '''<script>
                fetch(PROFILE, {method:'POST',headers:{'X-Merchant-Token':TOKEN}}).then(()=>
                  fetch(STORES, {method:'POST',body:JSON.stringify({data:{metadata:{token:TOKEN}}})}));
                </script>'''.replace('PROFILE', json.dumps(self.m.PROFILE_URL)).replace('STORES', json.dumps(self.m.STORES_URL)).replace('TOKEN', json.dumps(self.payload['token']))
                await route.fulfill(status=200, content_type='text/html', body=body, headers={
                    'set-cookie': self.m.COOKIE + '=e30.' + payload + '.c2ln; Secure; HttpOnly; Path=/'})
            else:
                await route.abort()
        await self.worker.context.route('**/*', fixture)
        if hasattr(self.worker, 'guard'):
            await self.worker.context.unroute('**/*', self.worker.guard)
            await self.worker.context.route('**/*', self.worker.guard)

    async def asyncTearDown(self):
        if hasattr(self, 'worker'):
            await self.worker.close()

    async def test_password_submit_once_reaches_observed_otp(self):
        result = await self.worker.command({'cmd': 'start', 'identifier': 'synthetic@example.invalid',
                                            'merchant_password': 'synthetic-secret'})
        self.assertEqual(result, {'ok': True, 'step': 'otp'})
        self.assertEqual(await self.worker.page.evaluate('window.filled'),
                         ['synthetic@example.invalid', 'synthetic-secret'])
        self.assertEqual(await self.worker.page.evaluate('window.submissions'), 1)
        again = await self.worker.command({'cmd': 'start', 'identifier': 'second', 'merchant_password': 'secret'})
        self.assertEqual(again, {'ok': False, 'code': 'INVALID_STATE'})
        self.assertEqual(await self.worker.page.evaluate('window.submissions'), 1)
        self.assertEqual(self.requests, [self.m.LOGIN_URL])

    async def test_invalid_command_rejected_before_any_network(self):
        for command in (None, [], {'cmd': 'start'}, {'cmd': 'verify', 'otp': '123456\n'},
                        {'cmd': 'start', 'identifier': 'name', 'merchant_password': 'secret', 'url': 'evil'}):
            with self.subTest(command=command):
                self.assertEqual(await self.worker.command(command), {'ok': False, 'code': 'INVALID_COMMAND'})
        self.assertEqual(self.requests, [])

    async def test_missing_javascript_form_fails_sanitized_and_closes(self):
        self.html = '<noscript>JavaScript required</noscript>'
        result = await self.worker.command({'cmd': 'start', 'identifier': 'private-identifier', 'merchant_password': 'private-password'})
        self.assertEqual(result, {'ok': False, 'code': 'FORM_UNAVAILABLE'})
        self.assertIsNone(self.worker.context)

    async def test_external_navigation_stops_before_request(self):
        self.html = HTML.replace("window.submissions++;", "window.submissions++; location.href='https://example.invalid/leak'; return;")
        result = await self.worker.command({'cmd': 'start', 'identifier': 'synthetic', 'merchant_password': 'secret'})
        self.assertEqual(result, {'ok': False, 'code': 'NAVIGATION_BLOCKED'})
        self.assertNotIn('https://example.invalid/leak', self.requests)
        self.assertIsNone(self.worker.context)

    async def test_redirect_continuation_is_blocked_before_loopback_network(self):
        # route() sees the initial request only: Chromium follows this actual
        # 302 on its own. The destination is a real socket, not another mock.
        hits = []

        async def destination(reader, writer):
            hits.append(await reader.readline())
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(destination, '127.0.0.1', 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        target = f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}/redirect-fixture'

        async def redirect(route):
            await route.fulfill(status=302, headers={'location': target})

        await self.worker.context.route(self.m.LOGIN_URL, redirect)
        from playwright.async_api import Error
        try:
            await self.worker.page.goto(self.m.LOGIN_URL, wait_until='domcontentloaded')
        except Error:
            pass
        self.assertEqual(hits, [], 'redirect reached loopback before the guard')
        self.assertEqual(self.worker.failure, 'NAVIGATION_BLOCKED')

    async def test_resource_redirect_blocked_before_loopback_tls_connection(self):
        hits = []

        async def destination(reader, writer):
            # Count TCP accepts, including TLS handshakes: even a failed TLS
            # connection is already too late for a pre-network guard.
            hits.append(True)
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(destination, '127.0.0.1', 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        asset = 'https://deo.shopeemobile.com/shopee/redirect.js'
        target = f'https://127.0.0.1:{server.sockets[0].getsockname()[1]}/resource'
        self.html = HTML + '<script src="' + asset + '"></script>'

        async def redirect(route):
            await route.fulfill(status=302, headers={'location': target})

        await self.worker.context.route(asset, redirect)
        await self.worker.page.goto(self.m.LOGIN_URL, wait_until='load')
        self.assertEqual(hits, [], 'resource redirect opened a loopback socket')

    async def test_iframe_document_and_redirect_never_reach_network(self):
        await self.assert_iframe_egress_blocked(document_redirect=True)

    async def test_cross_origin_iframe_resource_redirect_never_reaches_network(self):
        await self.assert_iframe_egress_blocked(document_redirect=False)

    async def assert_iframe_egress_blocked(self, document_redirect):
        hits, initial_requests = [], []

        async def destination(reader, writer):
            hits.append(True)  # TCP accepts, including unsuccessful TLS handshakes.
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(destination, '127.0.0.1', 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        target = f'https://127.0.0.1:{server.sockets[0].getsockname()[1]}/iframe-leak'
        frame_url = 'https://deo.shopeemobile.com/shopee/frame.html'
        asset_url = 'https://deo.shopeemobile.com/shopee/frame-redirect.js'
        self.html = HTML + '<iframe src="' + frame_url + '"></iframe>'

        async def iframe_fixture(route):
            initial_requests.append(route.request.url)
            if route.request.url == frame_url and not document_redirect:
                await route.fulfill(status=200, content_type='text/html',
                                    body='<script src="' + asset_url + '"></script>')
            else:
                await route.fulfill(status=302, headers={'location': target})

        await self.worker.context.route(frame_url, iframe_fixture)
        await self.worker.context.route(asset_url, iframe_fixture)
        # Production guard must run BEFORE the fixture/network transport.
        await self.worker.context.unroute('**/*', self.worker.guard)
        await self.worker.context.route('**/*', self.worker.guard)
        await self.worker.page.goto(self.m.LOGIN_URL, wait_until='load')
        self.assertEqual(hits, [], 'iframe redirect opened a loopback socket')
        self.assertEqual(initial_requests, [], 'iframe initial request reached transport')
        self.assertEqual(self.worker.failure, 'NAVIGATION_BLOCKED')
        self.assertEqual(self.m.wire_result(await self.worker.outcome(False)),
                         {'ok': False, 'code': 'UNSUPPORTED'})

    async def test_srcdoc_frame_resource_is_blocked_before_transport(self):
        asset = 'https://deo.shopeemobile.com/shopee/srcdoc.js'
        self.html = HTML + "<iframe srcdoc='<script src=\"" + asset + "\"></script>'></iframe>"
        await self.worker.page.goto(self.m.LOGIN_URL, wait_until='load')
        self.assertEqual(self.requests, [self.m.LOGIN_URL])
        self.assertEqual(self.worker.failure, 'NAVIGATION_BLOCKED')

    async def test_popup_stops_before_request(self):
        self.html = HTML.replace("window.submissions++;", "window.submissions++; window.open('https://partner.shopee.co.id/'); return;")
        result = await self.worker.command({'cmd': 'start', 'identifier': 'synthetic', 'merchant_password': 'secret'})
        self.assertEqual(result, {'ok': False, 'code': 'POPUP_BLOCKED'})
        self.assertNotIn('https://partner.shopee.co.id/', self.requests)

    async def test_complete_auth_rejects_other_merchant_scope(self):
        self.payload['merchantId'] = 99
        self.html = HTML.replace("window.otp=verify.querySelector('input').value;", "window.otp=verify.querySelector('input').value; location.href='https://partner.shopee.co.id/';")
        await self.worker.command({'cmd': 'start', 'identifier': 'synthetic', 'merchant_password': 'secret'})
        self.assertEqual(await self.worker.command({'cmd': 'verify', 'otp': '123456'}),
                         {'ok': False, 'code': 'SCOPE_INVALID'})

    async def test_probe_renders_empty_form_blocks_api_and_telemetry(self):
        self.html = HTML.replace('window.submissions=0;', "fetch('/api/v4/account/business/login_status',{method:'POST'});fetch('https://df.infra.sz.shopee.co.id/v2/shpsec/web/report',{method:'POST'});window.submissions=0;")
        self.assertTrue(hasattr(self.worker, 'probe'), 'safe probe missing')
        result = await self.worker.probe()
        self.assertEqual(result, {'dependency_loaded': True, 'browser_loaded': True, 'form_ready': True})
        self.assertEqual(self.requests, [self.m.LOGIN_URL])
        self.assertIsNone(self.worker.context)

    async def test_verify_does_not_fill_or_submit_when_challenge_appears(self):
        await self.worker.command({'cmd': 'start', 'identifier': 'synthetic', 'merchant_password': 'secret'})
        await self.worker.page.evaluate("() => {document.body.insertAdjacentHTML('beforeend','<div id=\"captcha\">Security verification</div>'); document.querySelector('input').oninput=()=>document.querySelector('#captcha').remove();}")
        self.assertTrue(await self.worker.page.locator('#captcha').is_visible())
        result = await self.worker.command({'cmd': 'verify', 'otp': '123456'})
        self.assertEqual(result, {'ok': False, 'code': 'CHALLENGE_REQUIRED'})
        self.assertIsNone(self.worker.context)

    async def test_cancel_closes_browser_and_cannot_restart(self):
        await self.worker.command({'cmd': 'start', 'identifier': 'synthetic', 'merchant_password': 'secret'})
        result = await self.worker.command({'cmd': 'cancel'})
        self.assertEqual(result, {'ok': True, 'step': 'cancelled'})
        self.assertIsNone(self.worker.context)
        self.assertEqual(await self.worker.command({'cmd': 'start', 'identifier': 'synthetic', 'merchant_password': 'secret'}),
                         {'ok': False, 'code': 'INVALID_STATE'})

    async def test_challenge_stops_before_any_password_submit(self):
        self.html = HTML.replace('<form id="login">', '<div id="captcha">Security verification</div><form id="login">')
        result = await self.worker.command({'cmd': 'start', 'identifier': 'synthetic', 'merchant_password': 'secret'})
        self.assertEqual(result, {'ok': False, 'code': 'CHALLENGE_REQUIRED'})
        self.assertIsNone(self.worker.context)

    async def test_verify_captures_cookie_profile_scoped_complete_stores(self):
        self.html = HTML.replace("window.otp=verify.querySelector('input').value;", "window.otp=verify.querySelector('input').value; location.href='https://partner.shopee.co.id/';")
        await self.worker.command({'cmd': 'start', 'identifier': 'synthetic', 'merchant_password': 'secret'})
        result = await self.worker.command({'cmd': 'verify', 'otp': '123456'})
        self.assertEqual(result, {'ok': True, 'step': 'authenticated', 'credential': {
            'token': 'B:synthetic_only', 'account_id': '34', 'merchant_id': '12',
            'expires_at': self.payload['exp'] * 1000}, 'stores': [{'id': '56', 'label': 'Synthetic shop'}]})
        self.assertIsNone(self.worker.context)


class EgressPolicyTests(unittest.TestCase):
    def test_exact_hosts_schemes_ports_and_userinfo(self):
        module = load_worker()
        worker = module.Worker()
        self.assertTrue(worker.request_allowed(module.LOGIN_URL, 'GET', True))
        self.assertTrue(worker.request_allowed('https://partner.shopee.co.id:443/', 'GET', True))
        for url in (
            'http://partner.shopee.co.id/', 'https://partner.shopee.co.id:444/',
            'https://partner.shopee.co.id:bad/', 'https://partner.shopee.co.id:65536/',
            'https://u:p@partner.shopee.co.id/', 'https://@partner.shopee.co.id/',
            'https://partner.shopee.co.id.evil.invalid/', 'https://partner.shopee.co.id./',
            'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/',
            'https://localhost/', 'https://foo.local/', 'https://169.254.169.254/',
            'file:///etc/passwd', 'https://[invalid/',
        ):
            with self.subTest(url=url):
                self.assertFalse(worker.request_allowed(url, 'GET', True))
                self.assertFalse(worker.request_allowed(url, 'GET'))
        self.assertFalse(worker.request_allowed('https://deo.shopeemobile.com/shopee/a.js', 'GET', True))
        self.assertTrue(worker.request_allowed('https://deo.shopeemobile.com/shopee/a.js', 'GET'))
        worker.probing = True
        self.assertTrue(worker.request_allowed(module.LOGIN_URL, 'GET', True))
        self.assertTrue(worker.request_allowed('https://deo.shopeemobile.com/shopee/a.js', 'GET'))
        for url, method in (
            (module.LOGIN_URL, 'POST'), (load_worker().PROFILE_URL, 'GET'),
            ('https://deo.shopeemobile.com/private/api', 'GET'),
            ('https://deo.shopeemobile.com/shopee/a.js', 'POST'),
            ('https://df.infra.sz.shopee.co.id/v2/shpsec/web/report', 'POST'),
        ):
            self.assertFalse(worker.request_allowed(url, method))


class IPCTests(unittest.IsolatedAsyncioTestCase):
    async def spawn(self):
        child = await asyncio.create_subprocess_exec(sys.executable, '-B', __file__, '--fixture-worker',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.addAsyncCleanup(self.stop, child)
        return child

    async def stop(self, child):
        if child.returncode is None:
            child.terminate()
            await asyncio.wait_for(child.wait(), 8)

    async def reply(self, child, value):
        child.stdin.write((json.dumps(value) + '\n').encode())
        await child.stdin.drain()
        line = await asyncio.wait_for(child.stdout.readline(), 10)
        self.assertTrue(line, 'worker must answer JSON lines')
        return json.loads(line)

    async def test_real_browser_over_ipc_start_verify(self):
        child = await self.spawn()
        self.assertEqual(await self.reply(child, {'cmd': 'start', 'identifier': 'fixture', 'merchant_password': 'secret'}), {'ok': True, 'step': 'otp'})
        result = await self.reply(child, {'cmd': 'verify', 'otp': '123456'})
        self.assertEqual(result['step'], 'authenticated')
        self.assertEqual(result['stores'], [{'store_id': '56', 'label': 'Synthetic shop'}])
        self.assertEqual(set(result['credential']), {'token', 'account_id', 'merchant_id', 'expires_at'})
        await asyncio.wait_for(child.wait(), 8)
        self.assertEqual(await child.stderr.read(), b'')

    async def test_node_spawn_reads_exact_worker_contract(self):
        script = r'''
        const {spawn}=require('node:child_process');
        const {createInterface}=require('node:readline');
        const assert=require('node:assert/strict');
        const child=spawn(process.argv[1],['-B',process.argv[2],'--fixture-worker'],{stdio:['pipe','pipe','pipe']});
        let stage=0, errors=''; child.stderr.on('data', b=>errors+=b);
        createInterface({input:child.stdout}).on('line',line=>{
          const r=JSON.parse(line);
          if(stage++===0){assert.deepEqual(r,{ok:true,step:'otp'});child.stdin.write(JSON.stringify({cmd:'verify',otp:'123456'})+'\n');}
          else {assert.deepEqual(Object.keys(r).sort(),['credential','ok','step','stores']);
            assert.equal(r.step,'authenticated');assert.deepEqual(r.stores,[{store_id:'56',label:'Synthetic shop'}]);
            assert.deepEqual(Object.keys(r.credential).sort(),['account_id','expires_at','merchant_id','token']);}
        });
        child.on('exit',code=>{assert.equal(code,0);assert.equal(stage,2);assert.equal(errors,'');console.log('node-python-browser IPC verified');});
        child.stdin.write(JSON.stringify({cmd:'start',identifier:'fixture',merchant_password:'secret'})+'\n');
        '''
        node = await asyncio.create_subprocess_exec('node', '-e', script, sys.executable, __file__,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(node.communicate(), 15)
        self.assertEqual(node.returncode, 0, err.decode())
        self.assertEqual(out.strip(), b'node-python-browser IPC verified')
        self.assertEqual(err, b'')

    async def test_ipc_cancel_during_pending_auth(self):
        child = await self.spawn()
        child.stdin.write(b'{"cmd":"start","identifier":"fixture","merchant_password":"secret"}\n{"cmd":"cancel"}\n')
        await child.stdin.drain()
        lines = await asyncio.wait_for(child.stdout.read(), 10)
        replies = [json.loads(line) for line in lines.splitlines()]
        self.assertEqual(replies[-1], {'ok': True, 'step': 'cancelled'})
        self.assertNotIn(b'credential', lines)
        await asyncio.wait_for(child.wait(), 8)
        self.assertEqual(await child.stderr.read(), b'')

    async def test_sigterm_closes_waiting_browser(self):
        child = await self.spawn()
        await self.reply(child, {'cmd': 'start', 'identifier': 'fixture', 'merchant_password': 'secret'})
        child.send_signal(signal.SIGTERM)
        await asyncio.wait_for(child.wait(), 8)
        self.assertEqual(await child.stderr.read(), b'')


async def fixture_worker():
    fixture = BrowserTests()
    await fixture.asyncSetUp()
    fixture.html = HTML.replace("window.otp=verify.querySelector('input').value;", "window.otp=verify.querySelector('input').value; location.href='https://partner.shopee.co.id/';")
    try:
        assert hasattr(fixture.m, 'serve'), 'JSON lines IPC missing'
        await fixture.m.serve(fixture.worker)
    finally:
        await fixture.asyncTearDown()


if __name__ == '__main__':
    if sys.argv[1:] == ['--fixture-worker']:
        asyncio.run(fixture_worker())
    else:
        unittest.main()
