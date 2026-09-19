"""Public HTTPS smoke: only POST /terms/accept; no login or payment mutations.
Run only after deployment. Normal TLS; no test credentials or live DB writes.
"""
import json
import os
import re
import tempfile
import time
import hashlib
from pathlib import Path
from urllib.parse import urlparse, urlsplit, parse_qs
from playwright.sync_api import sync_playwright, expect

def check_content(page, response=None):
    assert '[object Promise]' not in page.content(), 'Unresolved include in rendered HTML'
    path = urlsplit(page.url).path
    if path == '/terms':
        expect(page.locator('dialog#termsDialog[open]')).to_have_count(1)
        expect(page.locator('#termsDialogTitle')).to_have_text('Syarat Penggunaan')
        expect(page.locator('#termsDialog details, #termsDialog table')).to_have_count(0)
        expect(page.locator('.auth-wrap[inert] form[action^="/login"]')).to_have_count(1)
    if path in ['/terms/details', '/tos']:
        expect(page.locator('#termsSummaryTitle')).to_have_text('Sebelum deploy PayGate')
        expect(page.locator('#termsDetailsTitle')).to_have_text('Ketentuan dan tanggung jawab')
        expect(page.locator('.terms-document table')).to_have_count(0)
        expect(page.locator('.terms-document details')).to_have_count(9)
        questions = page.locator('.terms-document details > summary').all_text_contents()
        assert len(questions) == 9 and all(q.strip().endswith('?') for q in questions)
        for topic in ['ShopeePay', 'GoPay/GoBiz', 'infrastruktur instalasi', 'sesi dan privasi', 'batas koneksi', 'pembayaran', 'batas tanggung jawab', 'persetujuan']:
            assert any(topic in q for q in questions), ('Missing legal FAQ topic', topic)
        expect(page.get_by_role('link', name='MIT', exact=True, include_hidden=True)).to_have_attribute('href', '/license')
    if response is not None:
        html = response.text()
        assert '[object Promise]' not in html, 'Unresolved include in actual HTTP response'
        if path in ['/terms/details', '/tos']:
            for text in ['Sebelum deploy PayGate', 'source code', 'MIT', 'AS IS', 'melanggar ToS provider', 'settlement', 'Ketentuan dan tanggung jawab', 'Persyaratan merchant ShopeePay']:
                assert text in html, ('Missing actual HTTP legal content', text)
            assert page.evaluate("html => new DOMParser().parseFromString(html, 'text/html').querySelectorAll('.terms-document details > summary').length", html) == 9, 'Actual HTTP response lost native FAQ'
            assert not page.evaluate("html => new DOMParser().parseFromString(html, 'text/html').querySelector('.terms-document table') !== null", html), 'Actual HTTP response still uses table'


def settled(page):
    page.evaluate('() => Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')


def check_faq(page):
    check_content(page)
    items = page.locator('.terms-document details')
    expect(items).to_have_count(9)
    assert items.evaluate_all('els => els.every(el => !el.open)'), 'FAQ must start collapsed'
    for index in range(items.count()):
        item = items.nth(index)
        summary = item.locator(':scope > summary')
        summary.focus();summary.press('Enter')
        expect(item).to_have_attribute('open', '')
        expect(item.locator('.terms-answer')).to_be_visible()
        expect(summary).to_be_focused()
        assert item.locator('.terms-answer').evaluate('el => parseFloat(getComputedStyle(el).fontSize) >= 13 && el.scrollWidth <= el.clientWidth + 1'), 'FAQ answer unreadable or overflowing'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Opened FAQ causes page overflow'
        summary.press('Space')
        expect(item).not_to_have_attribute('open', '')
        expect(summary).to_be_focused()
    page.evaluate('scrollTo(0, 0)')


def login_signature(page):
    return page.locator('.auth-wrap').evaluate("el => ({intro: el.querySelector('.auth-side').textContent.trim(), fields: Array.from(el.querySelectorAll('input:not([type=hidden])'), i => [i.id, i.name, i.type, i.required, i.minLength, i.maxLength, i.autocomplete]), action: new URL(el.querySelector('form').action).pathname, method: el.querySelector('form').method, button: el.querySelector('button[type=submit]').textContent.trim()})")


def check_compact_terms(page):
    check_content(page)
    settled(page)
    dialog = page.locator('#termsDialog')
    expect(page.get_by_role('dialog', name='Syarat Penggunaan', exact=True)).to_be_visible()
    assert dialog.evaluate('el => el.matches(":modal")'), 'Consent must use native showModal(), not open-only overlay'
    expect(page.locator('.auth-wrap')).to_have_attribute('inert', '')
    expect(page.locator('.auth-toolbar')).to_have_attribute('inert', '')
    expect(page.locator('.auth-wrap #username')).to_have_attribute('name', 'username')
    expect(page.locator('.auth-wrap #password')).to_have_attribute('type', 'password')
    expect(page.locator('.layout, .sidebar, #statCards, #providerCards, .dashboard-grid')).to_have_count(0)
    checkbox = page.locator('#termsAccepted')
    assert checkbox.get_attribute('required') is not None
    checkbox.focus()
    page.locator('#username').evaluate('el => el.focus()')
    expect(checkbox).to_be_focused()
    for key in ['Tab', 'Shift+Tab']:
        for _ in range(12):
            page.keyboard.press(key)
            assert page.evaluate('!!document.activeElement.closest("#termsDialog")'), ('Tab escaped consent', key)
    page.evaluate('scrollTo(0, 0)')
    box = dialog.bounding_box()
    width, height = page.viewport_size['width'], page.viewport_size['height']
    assert box and box['x'] >= 8 and box['y'] >= 0 and box['x'] + box['width'] <= width - 8 and box['y'] + box['height'] <= height
    assert abs(box['x'] - (width - box['x'] - box['width'])) <= 1, ('Consent horizontal margins not centered', box)
    assert abs(box['y'] - (height - box['y'] - box['height'])) <= 1, ('Consent vertical margins not centered', box)
    if width == 320 and height == 844:
        assert box['height'] < 600 and box['width'] <= 304, ('Consent not small at 320x844', box)
    assert dialog.evaluate('el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight'), 'Small consent must not need scrolling'
    assert dialog.locator('a,button,input:not([type=hidden]),label').evaluate_all('els => els.every(el => { const r=el.getBoundingClientRect(), d=el.closest("dialog").getBoundingClientRect(); return r.width>0 && r.height>0 && r.top>=d.top && r.bottom<=d.bottom && r.left>=d.left && r.right<=d.right; })'), 'Consent control outside popup'
    return box


def check_license(page, license_bytes):
    expect(page.get_by_role('heading', name='Lisensi MIT', exact=True)).to_be_visible()
    expect(page.locator('.license-hero')).to_be_visible()
    expect(page.locator('.license-card')).to_have_count(3)
    for title in ['Izin penggunaan', 'Syarat distribusi', 'Batasan tanggung jawab']:
        expect(page.get_by_role('heading', name=title, exact=True)).to_be_visible()
    raw = page.locator('details.license-raw')
    assert not raw.evaluate('el => el.open'), 'Visual license must not initially dump raw text'
    assert page.locator('#licenseText').text_content() == license_bytes.decode(), 'HTML license differs from exact LICENSE'
    summary = raw.locator('summary')
    summary.focus();summary.press('Enter')
    expect(raw).to_have_attribute('open', '')
    expect(page.locator('#licenseText')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'MIT text causes horizontal overflow'
    summary.press('Space');expect(raw).not_to_have_attribute('open', '')
    page.evaluate('scrollTo(0, 0)')


def download_license(page, license_bytes, destination):
    link = page.locator('a[href="/license.txt"][download]')
    expect(link).to_have_count(1)
    with page.expect_download() as received:
        link.click()
    download = received.value
    assert download.suggested_filename == 'LICENSE.txt'
    download.save_as(str(destination))
    assert destination.read_bytes() == license_bytes, 'Downloaded MIT differs from exact LICENSE'


BASE = 'https://paygate.38-47-90-111.sslip.io'
ROOT = Path(__file__).resolve().parents[1]
ASSET_VERSION = re.search(r'/static/css/app\.css\?v=([^"\s]+)', (ROOT / 'views/layout.ejs').read_text()).group(1)
assert ASSET_VERSION == 'studio4n', 'Legal/password UX requires studio4n cache-busted assets'
assert os.environ.get('PAYGATE_PUBLIC_QA') == '1', 'Public QA needs explicit post-deploy authorization: PAYGATE_PUBLIC_QA=1'
OUT = Path(tempfile.mkdtemp(prefix='paygate-studio4n-live-public-'))
OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 900}, service_workers='block')
    context.add_init_script('window.cspViolations=[];document.addEventListener("securitypolicyviolation",e=>window.cspViolations.push(e.violatedDirective))')
    page = context.new_page()
    errors, acknowledgements = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    def safe(route):
        request = route.request
        parsed = urlparse(request.url)
        assert parsed.scheme == 'https' and parsed.netloc == urlparse(BASE).netloc, 'External request forbidden'
        if urlparse(request.url).path.startswith('/api/'):
            assert request.method == 'GET' and urlparse(request.url).path in {'/api/accounts','/api/orders','/api/api-keys','/api/settings','/api/transactions','/api/dashboard/summary'}, 'Only local read-only status APIs allowed'
        if urlparse(request.url).path.startswith('/api/accounts'):
            assert request.method == 'GET' and urlparse(request.url).path == '/api/accounts', 'Merchant status GET only'
        if request.method != 'GET':
            assert request.method == 'POST' and request.url == BASE + '/terms/accept', 'Only terms acknowledgement allowed'
            body = parse_qs(request.post_data or '')
            assert body.get('accepted') == ['yes'] and body.get('version') == [terms_version] and body.get('_csrf')
            assert set(body) <= {'accepted','version','_csrf','next'}
            acknowledgements.append(request.url)
        route.continue_()
    context.route('**/*', safe)
    def visit(route):
        response = page.goto(BASE + route, wait_until='networkidle')
        assert response.status == 200 and page.url == BASE + route
        assert response.headers.get('cache-control') == 'no-store'
        assert "script-src 'self'" in response.headers.get('content-security-policy', '')
        assert page.evaluate('window.cspViolations') == []
        check_content(page, response)
        expect(page.locator('link[rel="stylesheet"]')).to_have_attribute('href', f'/static/css/app.css?v={ASSET_VERSION}')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        return response
    response = page.goto(BASE + '/login', wait_until='networkidle')
    assert response.status == 200 and page.url == BASE + '/terms?next=%2Flogin'
    check_content(page, response)
    page.set_viewport_size({'width':320,'height':844})
    check_compact_terms(page)
    shared_login = login_signature(page)
    terms_version = page.locator('input[name=version]').input_value()
    assert terms_version == '2026-09-08-pw1'
    expect(page.locator('script[src*="/terms.js"]')).to_have_attribute('src', f'/static/js/terms.js?v={ASSET_VERSION}')
    license_bytes = (ROOT / 'LICENSE').read_bytes()
    license_response = context.request.get(BASE + '/license.txt', max_redirects=0)
    assert license_response.status == 200 and 'text/plain' in license_response.headers.get('content-type', '')
    assert license_response.body() == license_bytes
    expect(page.locator('#termsAccepted')).not_to_be_checked()
    page.get_by_role('button', name='Saya setuju & lanjutkan', exact=True).click()
    assert not acknowledgements and page.url == BASE + '/terms?next=%2Flogin'
    assert page.locator('#termsAccepted').evaluate('el => el.validity.valueMissing')
    page.keyboard.press('Escape')
    page.wait_for_url(BASE + '/terms?declined=1&next=%2Flogin')
    expect(page.get_by_role('status')).to_be_visible()
    check_compact_terms(page)
    assert not acknowledgements and not any(c['name']=='paygate_terms' for c in context.cookies())
    page.get_by_role('link', name='Tidak setuju', exact=True).click()
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('status')).to_be_visible()
    assert not acknowledgements and not any(c['name']=='paygate_terms' for c in context.cookies())
    before = check_compact_terms(page)
    parent_url = page.url
    with context.expect_page() as detail_info:
        page.locator('#termsDialog a[href="/terms/details"]').click()
    detail = detail_info.value
    detail.on('pageerror', lambda error: errors.append(str(error)))
    detail.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    detail.wait_for_load_state('networkidle')
    assert detail.url == BASE + '/terms/details' and detail.evaluate('window.opener === null')
    check_faq(detail);detail.close()
    assert page.url == parent_url and check_compact_terms(page) == before
    geometry = []
    for theme in ['dark', 'light']:
        visit('/terms/details')
        if page.evaluate('document.documentElement.dataset.theme') != theme:
            page.get_by_role('button', name='Ganti tema terang/gelap').click()
        page.reload(wait_until='networkidle');check_content(page)
        expect(page.locator('html')).to_have_attribute('data-theme', theme)
        for width in [1280,768,390,320]:
            page.set_viewport_size({'width':width,'height':844})
            for route in ['/terms','/terms/details','/license']:
                visit(route)
                expect(page.locator('html')).to_have_attribute('data-theme', theme)
                if route == '/terms':geometry.append({'theme':theme,'viewport_width':width,**check_compact_terms(page)})
                elif route == '/terms/details':check_faq(page)
                else:check_license(page, license_bytes)
                settled(page)
                page.screenshot(path=str(OUT/f'{route[1:].replace("/","-")}-{theme}-{width}.png'),full_page=True)
    visit('/license')
    download_license(page, license_bytes, OUT / 'LICENSE.txt')
    assert not acknowledgements and not any(c['name']=='paygate_terms' for c in context.cookies())
    visit('/terms')
    page.locator('#termsAccepted').check()
    with page.expect_response(lambda r:r.url == BASE + '/terms/accept') as accepted:
        page.get_by_role('button', name='Saya setuju & lanjutkan', exact=True).click()
    assert accepted.value.status == 303 and len(acknowledgements) == 1
    page.wait_for_url(BASE + '/login')
    response = page.reload(wait_until='networkidle');check_content(page)
    assert response.status == 200 and page.url == BASE + '/login'
    expect(page.locator('#termsDialog')).to_have_count(0)
    assert login_signature(page) == shared_login
    terms = next(c for c in context.cookies() if c['name']=='paygate_terms')
    assert terms['secure'] and terms['httpOnly'] and terms['sameSite']=='Lax'
    assert terms['value'].split('.')[0] == terms_version
    assert re.fullmatch(r'[^.]+\.\d{13}\.[a-f0-9]{64}', terms['value'])
    assert 180 * 86400 - 60 <= terms['expires'] - time.time() <= 180 * 86400 + 5
    assert 'paygate_terms=' not in page.evaluate('document.cookie')
    expect(page.locator('.risk-banner')).to_have_count(0)
    assert 'LAB UNOFFICIAL' not in page.locator('body').inner_text()
    expect(page.locator('.auth-side')).to_have_count(1)
    expect(page.locator('link[rel="stylesheet"]')).to_have_attribute('href', f'/static/css/app.css?v={ASSET_VERSION}')
    assets = {}
    for relative in ['css/app.css', 'js/app.js', 'js/theme.js', 'js/pages.js', 'js/terms.js']:
        asset = context.request.get(BASE + '/static/' + relative + '?v=' + ASSET_VERSION, max_redirects=0)
        assert asset.status == 200
        assert asset.body() == (Path(__file__).resolve().parents[1] / 'public' / relative).read_bytes(), ('public asset differs', relative)
        assets[relative] = hashlib.sha256(asset.body()).hexdigest()
    assert response.headers.get('cache-control') == 'no-store'
    assert "script-src 'self'" in response.headers.get('content-security-policy', '')
    csrf = next(c for c in context.cookies() if c['name'] == 'paygate_csrf')
    assert csrf['secure'] and csrf['sameSite'] == 'Lax'
    for theme in ['dark', 'light']:
        if page.evaluate('document.documentElement.dataset.theme') != theme:
            page.get_by_role('button', name='Ganti tema terang/gelap').click()
        page.reload(wait_until='networkidle');check_content(page)
        assert page.url == BASE + '/login'
        expect(page.locator('html')).to_have_attribute('data-theme', theme)
        assert page.evaluate('localStorage.getItem("paygate_theme")') == theme
        for width in [1280,768,390,320]:
            page.set_viewport_size({'width':width,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (theme,width)
            page.screenshot(path=str(OUT/f'studio4n-live-login-{theme}-{width}.png'),full_page=True)
    assert len(acknowledgements) == 1, 'Acceptance repeated without user action'
    assert context.request.get(BASE + '/api/orders', max_redirects=0).status == 401
    health = context.request.get(BASE + '/healthz', max_redirects=0)
    assert health.status == 200 and health.json()['ok']
    assert not errors, errors
    print(json.dumps({'ok':True,'url':BASE+'/login','tls':'normal certificate verification','login':200,'health':200,'unauth_orders':401,'secure_csrf_cookie':True,'secure_terms_cookie':True,'terms_acknowledgements':len(acknowledgements),'no_store':True,'mobile_overflow':False,'viewports':[1280,768,390,320],'themes':['light','dark'],'console_errors':errors,'asset_version':ASSET_VERSION,'legal_dialog_geometry':geometry,'public_asset_sha256':assets,'artifacts':str(OUT)}))
    browser.close()
