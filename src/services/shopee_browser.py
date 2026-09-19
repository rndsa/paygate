"""Browser-owned Shopee login. Secrets only through private JSON-lines IPC.
No persistent context, state export, request replay, or challenge solver.
"""
import asyncio
import base64
import json
import re
import time
import os
import signal
import sys
from contextlib import suppress
from urllib.parse import urlsplit

COOKIE = '__shopee_partner_website_x_token_live'
PROFILE_URL = 'https://api.partner.shopee.co.id/nb/mss/web-api/PartnerAccountServer/GetUserInfo'
STORES_URL = 'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-store-list'


def ident(value):
    if type(value) is int and 0 < value <= 9007199254740991:
        return str(value)
    if type(value) is str and re.fullmatch(r'[1-9][0-9]{0,19}', value):
        return value
    raise ValueError('invalid_id')


def credential(cookie, profile):
    # JWT decoding is NOT signature verification. Only fresh browser cookie plus
    # successful exact first-party GetUserInfo for this token supplies provenance.
    if not isinstance(cookie, str) or len(cookie) > 32768:
        raise ValueError('invalid_cookie')
    parts = cookie.split('.')
    if len(parts) != 3 or not all(re.fullmatch(r'[A-Za-z0-9_-]+', p) for p in parts):
        raise ValueError('invalid_cookie')
    payload = json.loads(base64.b64decode(parts[1] + '=' * (-len(parts[1]) % 4), altchars=b'-_', validate=True))
    token = payload['token']
    if not isinstance(token, str) or not re.fullmatch(r'B:[A-Za-z0-9_+/.:-]{1,4092}={0,2}', token):
        raise ValueError('invalid_token')
    if token != profile['token']:
        raise ValueError('token_scope')
    account = ident(payload['userid'])
    if account != ident(profile['data']['tobUserId']):
        raise ValueError('staff_scope')
    merchant = ident(profile['data']['merchantId'])
    for key in ('merchantId', 'merchant_id'):
        if key in payload and ident(payload[key]) != merchant:
            raise ValueError('merchant_scope')
    expiry = payload['exp']
    if type(expiry) is not int or not time.time() < expiry <= 9007199254740:
        raise ValueError('invalid_expiry')
    return {'token': token, 'account_id': account, 'merchant_id': merchant, 'expires_at': expiry * 1000}

LOGIN_URL = ('https://partner.business.accounts.shopee.co.id/authenticate/login/?lang=id&should_hide_back=true&state=https%3A%2F%2Fpartner.shopee.co.id%2F%3Fbusiness_next%3Dhttps%253A%252F%252Fpartner.shopee.co.id%252Flogin%252Fauth%26business_state%3Dhttps%253A%252F%252Fpartner.shopee.co.id%26business_client_id%3D1&client_id=5&next=https%3A%2F%2Fpartner.shopee.co.id%2Faccount%2Flogin%2Fauth&previousPage=other%20articles&previousPage=other%20articles')
# Empty public form observed 2026-09-08; not authentication acceptance.
IDENTIFIER = 'No. handphone / Username / Email'
# Public first-party assets/6154.397904f0b3d6f4a84190.modern.js:
# input type=tel, autoComplete=one-time-code, maxLength=6; form handles Enter.
OTP = 'input[type="tel"][autocomplete="one-time-code"][maxlength="6"]'
MAIN_HOSTS = frozenset(('partner.business.accounts.shopee.co.id', 'partner.shopee.co.id'))
# Public empty form/SDK observation plus the two scoped post-login APIs above.
# Exact hosts only: no user-selected host, wildcard suffix, literal IP or local name.
RESOURCE_HOSTS = MAIN_HOSTS | frozenset((
    'deo.shopeemobile.com', 'df.infra.sz.shopee.co.id', 'dem.shopee.com',
    'api.partner.shopee.co.id', 'shopeepay.shopee.co.id'))


class Worker:
    def __init__(self, timeout=45, sandbox=True):
        self.timeout = timeout
        self.sandbox = sandbox
        self.state = 'new'
        self.playwright = self.browser = self.context = self.page = None
        self.profile = self.stores = None
        self.failure = None
        self.responses = set()
        self.probing = False

    async def open(self):
        from playwright.async_api import async_playwright
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(
            channel='chromium', headless=True, chromium_sandbox=self.sandbox)
        self.context = await self.browser.new_context(service_workers='block', accept_downloads=False)
        self.context.set_default_timeout(self.timeout * 1000)
        await self.context.route('**/*', self.guard)
        self.page = await self.context.new_page()
        # Playwright route() does not re-run for redirect continuations. Fetch
        # Request-stage interception pauses EACH hop before it reaches network.
        # https://chromedevtools.github.io/devtools-protocol/tot/Fetch/
        self.cdp = await self.context.new_cdp_session(self.page)
        tree = await self.cdp.send('Page.getFrameTree')
        self.main_frame_id = tree['frameTree']['frame']['id']
        self.cdp.on('Fetch.requestPaused', self.guard_paused)
        await self.cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})
        self.page.on('response', self.on_response)
        self.context.on('page', self.popup)
        self.page.on('download', self.download)

    def request_allowed(self, url, method, main=False):
        try:
            u = urlsplit(url)
            if u.scheme in ('data', 'blob'):
                return not main and not self.probing
            if not (u.scheme == 'https' and u.hostname in (MAIN_HOSTS if main else RESOURCE_HOSTS)
                    and u.port in (None, 443) and u.username is None and u.password is None):
                return False
            if self.probing:
                return method == 'GET' and (url == LOGIN_URL or (
                    u.scheme == 'https' and u.hostname == 'deo.shopeemobile.com'
                    and u.path.startswith('/shopee/')
                    and u.path.endswith(('.js', '.css', '.json', '.png', '.svg', '.woff2', '.ico'))))
            return u.scheme in ('https', 'data', 'blob')
        except ValueError:
            return False

    async def guard_paused(self, event):
        try:
            request = event['request']
            # Page CDP cannot cover OOPIF redirects. Never allow a subframe's
            # first document request (or any other subframe request) to escape.
            foreign_frame = event.get('frameId') != self.main_frame_id
            main = event['resourceType'] == 'Document' and not foreign_frame
            if foreign_frame or not self.request_allowed(request['url'], request['method'], main):
                if foreign_frame or main:
                    self.failure = 'NAVIGATION_BLOCKED'
                await self.cdp.send('Fetch.failRequest', {'requestId': event['requestId'], 'errorReason': 'BlockedByClient'})
            else:
                await self.cdp.send('Fetch.continueRequest', {'requestId': event['requestId']})
        except Exception:
            self.failure = 'NETWORK'
            # Never resume an unvalidated paused request on a protocol error.
            await self.close()

    async def guard(self, route):
        request = route.request
        # Check ownership for EVERY request, including srcdoc/about:blank
        # frame resources and requests whose frame cannot be established.
        try:
            frame = request.frame
        except Exception:
            self.failure = 'POPUP_BLOCKED'
            await route.abort()
            return
        if frame.page != self.page:
            self.failure = 'POPUP_BLOCKED'
            await route.abort()
            return
        if frame != self.page.main_frame:
            self.failure = 'NAVIGATION_BLOCKED'
            await route.abort()
            return
        main = request.is_navigation_request()
        if not self.request_allowed(request.url, request.method, main):
            if main:
                self.failure = 'NAVIGATION_BLOCKED'
            await route.abort()
            return
        await route.fallback()

    async def popup(self, page):
        self.failure = 'POPUP_BLOCKED'
        try:
            await page.close()
        except Exception:
            pass

    async def download(self, download):
        self.failure = 'DOWNLOAD_BLOCKED'
        try:
            await download.cancel()
        except Exception:
            pass

    def on_response(self, response):
        # Exact allowlist BEFORE any body/header read. Never risk or telemetry.
        if response.url not in (PROFILE_URL, STORES_URL) or response.request.method != 'POST':
            return
        task = asyncio.create_task(self.capture(response))
        self.responses.add(task)
        task.add_done_callback(self.responses.discard)

    async def capture(self, response):
        try:
            if response.status != 200:
                self.failure = 'PROFILE_REJECTED' if response.url == PROFILE_URL else 'STORES_REJECTED'
                return
            raw = await response.body()
            if len(raw) > 1048576:
                raise ValueError()
            envelope = json.loads(raw)
            code = 'errorCode' if response.url == PROFILE_URL else 'code'
            if type(envelope.get(code)) is not int or envelope[code] != 0:
                raise ValueError()
            data = envelope['data']
            if type(data) is not dict:
                raise ValueError()
            if response.url == PROFILE_URL:
                token = await response.request.header_value('x-merchant-token')
                self.profile = {'token': token, 'data': {k: data[k] for k in ('merchantId', 'tobUserId')}}
            else:
                # Only this exact store request has needed token scope in metadata.
                request_data = response.request.post_data_json
                token = request_data['data']['metadata']['token']
                rows, count = data['list'], data['storeCount']
                if type(rows) is not list or type(count) is not int or not 0 < count <= 1000 or len(rows) != count:
                    self.failure = 'STORES_INCOMPLETE'
                    return
                stores = []
                for row in rows:
                    label = row['storeName']
                    if type(label) is not str or not label or len(label) > 256 or any(ord(c) < 32 for c in label):
                        raise ValueError()
                    stores.append({'id': ident(row['storeId']), 'label': label})
                if len({s['id'] for s in stores}) != len(stores):
                    raise ValueError()
                self.stores = {'token': token, 'rows': stores}
        except Exception:
            self.failure = 'METADATA_INVALID'

    async def challenge(self):
        # Detection only: never click widgets, inject signatures, or resume them.
        for frame in self.page.frames:
            if re.search(r'/captcha|/verify/ivs|/challenge', urlsplit(frame.url).path, re.I):
                return True
            visible = frame.locator('[id*="captcha" i]:visible, [class*="captcha" i]:visible, iframe[src*="captcha" i]:visible, [role="dialog"]:visible')
            if await visible.count():
                return True
        return False

    async def outcome(self, allow_otp):
        deadline = asyncio.get_running_loop().time() + self.timeout
        while asyncio.get_running_loop().time() < deadline:
            if await self.challenge():
                return {'ok': False, 'code': 'CHALLENGE_REQUIRED'}
            if self.failure:
                return {'ok': False, 'code': self.failure}
            if self.profile:
                cookies = [c for c in await self.context.cookies('https://partner.shopee.co.id/')
                           if c['name'] == COOKIE and c['secure'] and
                           c['domain'].lstrip('.') in ('partner.shopee.co.id', 'shopee.co.id')]
                if cookies:
                    try:
                        if len(cookies) != 1:
                            raise ValueError()
                        auth = credential(cookies[0]['value'], self.profile)
                        if self.stores:
                            if self.stores['token'] != auth['token']:
                                raise ValueError()
                            return {'ok': True, 'step': 'authenticated', 'credential': auth, 'stores': self.stores['rows']}
                    except Exception:
                        return {'ok': False, 'code': 'SCOPE_INVALID'}
            if allow_otp and await self.page.locator(OTP).is_visible():
                return {'ok': True, 'step': 'otp'}
            await asyncio.sleep(0.05)
        return {'ok': False, 'code': 'STORES_NOT_OBSERVED' if self.profile else 'PROFILE_NOT_OBSERVED'}

    async def probe(self):
        result = {'dependency_loaded': False, 'browser_loaded': False, 'form_ready': False}
        self.probing = True
        try:
            import playwright.async_api
            result['dependency_loaded'] = True
            if not self.page:
                await self.open()
            result['browser_loaded'] = True
            await self.page.goto(LOGIN_URL, wait_until='domcontentloaded')
            field = self.page.get_by_placeholder(IDENTIFIER, exact=True)
            password = self.page.get_by_placeholder('Password', exact=True)
            await field.wait_for(state='visible')
            await password.wait_for(state='visible')
            result['form_ready'] = (not await field.input_value() and not await password.input_value()
                                    and await self.page.get_by_role('button', name='Masuk', exact=True).is_visible()
                                    and not await self.challenge())
        except Exception:
            pass
        finally:
            await self.close()
        return result

    async def close(self):
        for item in (self.context, self.browser, self.playwright):
            if item:
                try:
                    await (item.stop() if item is self.playwright else item.close())
                except Exception:
                    pass
        self.context = self.browser = self.playwright = None

    async def command(self, command):
        try:
            if type(command) is not dict:
                raise ValueError()
            cmd = command.get('cmd')
            keys = {'start': {'cmd', 'identifier', 'merchant_password'}, 'verify': {'cmd', 'otp'}, 'cancel': {'cmd'}}
            if cmd not in keys or set(command) != keys[cmd]:
                raise ValueError()
            for key in keys[cmd] - {'cmd'}:
                value = command[key]
                if type(value) is not str or not 1 <= len(value) <= 256 or any(ord(c) < 32 or ord(c) == 127 for c in value):
                    raise ValueError()
            if cmd == 'verify' and not re.fullmatch(r'[0-9]{6}', command['otp']):
                raise ValueError()
        except (ValueError, TypeError):
            return {'ok': False, 'code': 'INVALID_COMMAND'}
        try:
            return await self.execute(command)
        except Exception:
            self.state = 'failed'
            await self.close()
            return {'ok': False, 'code': self.failure or 'FORM_UNAVAILABLE'}

    async def execute(self, command):
        cmd = command.get('cmd')
        if cmd == 'cancel':
            self.state = 'cancelled'
            await self.close()
            return {'ok': True, 'step': 'cancelled'}
        if (cmd, self.state) not in (('start', 'new'), ('verify', 'otp')):
            return {'ok': False, 'code': 'INVALID_STATE'}
        self.state = 'submitting'
        if not self.page:
            try:
                await self.open()
            except Exception:
                self.state = 'failed'
                await self.close()
                return {'ok': False, 'code': 'RUNTIME_UNAVAILABLE'}
        if cmd == 'start':
            await self.page.goto(LOGIN_URL, wait_until='domcontentloaded')
            if await self.challenge():
                self.state = 'failed'
                await self.close()
                return {'ok': False, 'code': 'CHALLENGE_REQUIRED'}
            await self.page.get_by_placeholder(IDENTIFIER, exact=True).fill(command['identifier'])
            await self.page.get_by_placeholder('Password', exact=True).fill(command['merchant_password'])
            await self.page.get_by_role('button', name='Masuk', exact=True).click()
        else:
            if await self.challenge():
                self.state = 'failed'
                await self.close()
                return {'ok': False, 'code': 'CHALLENGE_REQUIRED'}
            await self.page.locator(OTP).fill(command['otp'])
            await self.page.locator(OTP).press('Enter')
        result = await self.outcome(allow_otp=cmd == 'start')
        self.state = result.get('step', 'failed')
        if self.state != 'otp':
            await self.close()
        return result


def wire_result(result):
    if result.get('ok'):
        if result.get('step') == 'authenticated':
            result = dict(result, stores=[{'store_id': s['id'], 'label': s['label']} for s in result['stores']])
        return result
    code = result['code']
    mapped = {
        'CHALLENGE_REQUIRED': 'CHALLENGE', 'FORM_UNAVAILABLE': 'UNSUPPORTED',
        'PROFILE_NOT_OBSERVED': 'UNSUPPORTED', 'STORES_NOT_OBSERVED': 'UNSUPPORTED',
        'STORES_INCOMPLETE': 'UNSUPPORTED', 'NAVIGATION_BLOCKED': 'UNSUPPORTED',
        'POPUP_BLOCKED': 'UNSUPPORTED', 'DOWNLOAD_BLOCKED': 'UNSUPPORTED',
        'PROFILE_REJECTED': 'AUTH_REJECTED', 'STORES_REJECTED': 'AUTH_REJECTED',
        'RUNTIME_UNAVAILABLE': 'RUNTIME_UNAVAILABLE', 'NETWORK': 'NETWORK',
    }.get(code, 'BAD_RESPONSE')
    return {'ok': False, 'code': mapped}


def emit(result):
    print(json.dumps(wire_result(result), separators=(',', ':')), flush=True)


async def serve(worker=None):
    worker = worker or Worker()
    loop = asyncio.get_running_loop()
    # Never send raw browser, asyncio or provider exception messages to stdout/stderr.
    loop.set_exception_handler(lambda *_: None)
    owner = asyncio.current_task()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, owner.cancel)
    reader = asyncio.StreamReader(limit=4096)
    transport = None
    pending = reading = None
    try:
        transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        reading = asyncio.create_task(reader.readline())
        deadline = loop.time() + 300
        while loop.time() < deadline:
            done, _ = await asyncio.wait([t for t in (reading, pending) if t],
                                         timeout=deadline - loop.time(), return_when=asyncio.FIRST_COMPLETED)
            if not done:
                emit({'ok': False, 'code': 'NETWORK'})
                break
            if reading in done:
                try:
                    raw = reading.result()
                    if not raw:
                        break
                    command = json.loads(raw)
                    raw = b''
                except Exception:
                    emit({'ok': False, 'code': 'INVALID_COMMAND'})
                    break
                if command == {'cmd': 'cancel'}:
                    if pending:
                        pending.cancel()
                        with suppress(asyncio.CancelledError):
                            await pending
                        pending = None
                    emit(await worker.command(command))
                    break
                if pending:
                    emit({'ok': False, 'code': 'INVALID_STATE'})
                    break
                pending = asyncio.create_task(worker.command(command))
                command = None
                reading = asyncio.create_task(reader.readline())
            if pending in done:
                result = pending.result()
                pending = None
                emit(result)
                if result.get('step') != 'otp':
                    break
    except asyncio.CancelledError:
        pass
    except Exception:
        emit({'ok': False, 'code': 'NETWORK'})
    finally:
        for task in (pending, reading):
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task
        await worker.close()
        if transport:
            transport.close()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(sig)


if __name__ == '__main__':
    with open(os.devnull, 'w') as quiet:
        os.dup2(quiet.fileno(), 2)
    try:
        if sys.argv[1:] == ['--probe']:
            print(json.dumps(asyncio.run(Worker().probe()), separators=(',', ':')), flush=True)
        elif sys.argv[1:]:
            emit({'ok': False, 'code': 'INVALID_COMMAND'})
        else:
            asyncio.run(serve())
    except BaseException:
        pass
