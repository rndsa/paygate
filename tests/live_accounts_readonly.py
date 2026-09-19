"""Public authenticated UI check via existing owner session. GET + POST /terms/accept only; no auth/provider writes. Run after deploy."""
import json
import os
import re
import tempfile
import sqlite3
import time
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


def check_dialog_bounds(page, selector):
    dialog=page.locator(selector)
    page.evaluate('() => Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
    assert dialog.evaluate('el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&el.scrollWidth<=el.clientWidth+1}'), 'Dialog outside viewport'
    assert dialog.locator('.modal-body p, .modal-body li').evaluate_all('els=>els.every(el=>parseFloat(getComputedStyle(el).fontSize)>=(el.matches("li")?13:12))'), 'Dialog copy below existing caption/body type scale'
    dialog.locator('.modal-body').evaluate('el=>el.scrollTop=el.scrollHeight')
    controls=dialog.locator('.modal-footer button')
    if selector=='#spLoginDialog':
        for control in dialog.locator('form:not([hidden]) input, form:not([hidden]) select, form:not([hidden]) textarea, form:not([hidden]) button').all():
            control.scroll_into_view_if_needed()
            assert control.evaluate('el=>{const r=el.getBoundingClientRect(),d=el.closest("dialog").getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=d.left&&r.right<=d.right&&r.top>=d.top&&r.bottom<=d.bottom&&r.bottom<=innerHeight}'), 'Shopee form control unreachable by scrolling'
    assert controls.evaluate_all('els=>els.every(el=>{const r=el.getBoundingClientRect(),d=el.closest("dialog").getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=d.left&&r.right<=d.right&&r.top>=d.top&&r.bottom<=d.bottom&&r.bottom<=innerHeight})'), 'Dialog consent/action unreachable after body scroll'


def check_notice(page, dialog):
    notice = page.locator(dialog + ' .modal-body > p').first
    expect(notice).to_be_visible()
    lines = notice.evaluate('el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)')
    assert lines <= 3.05, ('Dialog notice exceeds three lines',dialog,page.viewport_size,lines)


BASE = 'https://paygate.38-47-90-111.sslip.io'
ROOT = Path(__file__).resolve().parents[1]
ASSET_VERSION = re.search(r'/static/css/app\.css\?v=([^"\s]+)', (ROOT / 'views/layout.ejs').read_text()).group(1)
assert ASSET_VERSION == 'studio4n', 'Legal/password UX requires studio4n cache-busted assets'
assert os.environ.get('PAYGATE_PUBLIC_QA') == '1', 'Public QA needs explicit post-deploy authorization: PAYGATE_PUBLIC_QA=1'
OUT = Path(tempfile.mkdtemp(prefix='paygate-studio4n-live-accounts-'))
OUT.mkdir(exist_ok=True)
with sqlite3.connect('file:/var/lib/paygate/paygate.db?mode=ro', uri=True) as db:
    row = db.execute('SELECT id FROM sessions WHERE user_id=1 AND expires_at>? ORDER BY created_at DESC LIMIT 1', (int(time.time()*1000),)).fetchone()
assert row, 'Existing owner session required; do not create test users in production'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width':1280,'height':900}, service_workers='block')
    context.add_init_script('window.cspViolations=[];document.addEventListener("securitypolicyviolation",e=>window.cspViolations.push(e.violatedDirective))')
    context.add_cookies([{'name':'paygate_sid','value':row[0],'url':BASE,'httpOnly':True,'secure':True,'sameSite':'Lax'}])
    page = context.new_page()
    errors=[]
    requests=[]
    page.on('request',lambda r:requests.append((r.method,r.url)))
    acknowledgements=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:errors.append(m.text) if m.type == 'error' else None)
    def safe(route):
        request=route.request
        assert urlparse(request.url).scheme == 'https' and urlparse(request.url).netloc == urlparse(BASE).netloc, 'External request forbidden'
        if urlparse(request.url).path.startswith('/api/'):
            assert request.method == 'GET' and urlparse(request.url).path in {'/api/accounts','/api/orders','/api/api-keys','/api/settings','/api/transactions','/api/dashboard/summary'}, 'Only local read-only status APIs allowed'
        if urlparse(request.url).path.startswith('/api/accounts'):
            assert request.method == 'GET' and urlparse(request.url).path == '/api/accounts', 'Merchant status GET only'
        if request.method != 'GET':
            assert request.method == 'POST' and request.url == BASE+'/terms/accept', 'Only terms acknowledgement allowed'
            body=parse_qs(request.post_data or '')
            assert body.get('accepted')==['yes'] and body.get('version')==[terms_version] and body.get('_csrf')
            assert set(body)<={'accepted','version','_csrf','next'}
            acknowledgements.append(request.url)
        route.continue_()
    context.route('**/*', safe)
    response=page.goto(BASE+'/accounts',wait_until='networkidle');check_content(page)
    assert response.status==200 and page.url==BASE+'/terms?next=%2Faccounts'
    check_content(page, response)
    page.set_viewport_size({'width':320,'height':844})
    check_compact_terms(page)
    terms_version = page.locator('input[name=version]').input_value()
    assert terms_version == '2026-09-08-pw1'
    expect(page.locator('script[src*="/terms.js"]')).to_have_attribute('src', f'/static/js/terms.js?v={ASSET_VERSION}')
    license_response = context.request.get(BASE + '/license.txt', max_redirects=0)
    assert license_response.status == 200 and 'text/plain' in license_response.headers.get('content-type', '')
    license_bytes = (ROOT / 'LICENSE').read_bytes()
    assert license_response.body() == license_bytes
    page.get_by_role('button',name='Saya setuju & lanjutkan',exact=True).click()
    assert not acknowledgements
    page.keyboard.press('Escape')
    page.wait_for_url(BASE+'/terms?declined=1&next=%2Faccounts')
    expect(page.get_by_role('status')).to_be_visible()
    check_compact_terms(page)
    assert not acknowledgements and not any(c['name']=='paygate_terms' for c in context.cookies())
    page.locator('#termsAccepted').check()
    with page.expect_response(lambda r:r.url==BASE+'/terms/accept') as accepted:
        page.get_by_role('button',name='Saya setuju & lanjutkan',exact=True).click()
    assert accepted.value.status==303 and len(acknowledgements)==1
    page.wait_for_url(BASE+'/accounts')
    cookie=next(c for c in context.cookies() if c['name']=='paygate_terms')
    assert cookie['secure'] and cookie['httpOnly'] and cookie['sameSite']=='Lax'
    assert cookie['value'].split('.')[0] == terms_version
    assert re.fullmatch(r'[^.]+\.\d{13}\.[a-f0-9]{64}', cookie['value'])
    assert 'paygate_terms=' not in page.evaluate('document.cookie')
    page.reload(wait_until='networkidle')
    assert page.url == BASE+'/accounts'
    expect(page.locator('#termsDialog')).to_have_count(0)
    assert len(acknowledgements)==1
    for theme in ['light', 'dark']:
        for width in [1280, 768, 390, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            for route_name in ['dashboard', 'accounts', 'orders', 'transactions', 'api-keys', 'settings', 'docs', 'tos']:
                response = page.goto(BASE+'/'+route_name, wait_until='networkidle');check_content(page)
                assert response.status == 200 and page.url == BASE+'/'+route_name
                check_content(page, response)
                if route_name == 'tos':
                    check_faq(page)
                expect(page.locator('.risk-banner')).to_have_count(0)
                expect(page.locator('.topbar [aria-label="Info"], .topbar a[href="/settings"]')).to_have_count(0)
                expect(page.locator('.sidebar a[href="/settings"]')).to_have_count(1)
                assert 'LAB UNOFFICIAL' not in page.locator('body').inner_text()
                expect(page.locator('link[rel="stylesheet"]')).to_have_attribute('href',f'/static/css/app.css?v={ASSET_VERSION}')
                if page.evaluate('document.documentElement.dataset.theme') != theme:
                    page.get_by_role('button',name='Ganti tema terang/gelap').click()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (theme, width, route_name)
                assert page.locator('.card-header h2, .docs-section h2').evaluate_all('(els) => els.every(el => parseFloat(getComputedStyle(el).fontSize) <= 18)')
                expect(page.locator('html')).to_have_attribute('data-theme',theme)
                assert page.evaluate('window.cspViolations')==[]
                if route_name == 'tos':
                    settled(page)
                    page.screenshot(path=str(OUT/f'studio4n-tos-{theme}-{width}.png'),full_page=True)
                if route_name == 'dashboard' and width in [1280, 320]:
                    expect(page.locator('#statCards .stat')).to_have_count(4)
                    expect(page.locator('#statCards')).not_to_contain_text('Memuat')
                    page.screenshot(path=str(OUT/f'studio4n-dashboard-{theme}-{width}.png'),full_page=True)
    response=page.goto(BASE+'/accounts',wait_until='networkidle');check_content(page)
    assert page.url == BASE+'/accounts' and response.status==200
    assert response.headers.get('cache-control')=='no-store'
    expect(page.get_by_role('button',name='Hubungkan GoPay',exact=True)).to_be_enabled()
    expect(page.get_by_role('button',name='Login ShopeePay',exact=True)).to_be_enabled()
    expect(page.locator('#spBody')).to_be_visible()
    expect(page.locator('#spGuideDialog, #spConnectDialog, #spToken, #spPassword')).to_have_count(0)
    assert 'Mock' not in page.locator('body').inner_text()
    assert 'DevTools' not in page.locator('body').text_content()
    meta=context.request.get(BASE+'/api/accounts',max_redirects=0).json()
    assert meta['lab']['owner'] and meta['login']['gopay']['available']
    assert meta['login']['shopeepay']['available'] is True
    assert meta['login']['shopeepay']['method']=='browser_password'
    assert not any(a['status']=='active' for a in meta['accounts'])
    for provider,prefix in [('gopay','gp'),('shopeepay','sp')]:
        m=next(m for m in meta['lab']['providers'] if m['provider']==provider)
        if not m['configured']:expect(page.locator('#'+prefix+'Body [data-action^="lab-"]')).to_have_count(0)
    for theme in ['light','dark']:
        if page.evaluate('document.documentElement.dataset.theme')!=theme:
            page.get_by_role('button',name='Ganti tema terang/gelap').click()
        for width in [1280,768,390,320]:
            page.set_viewport_size({'width':width,'height':900})
            page.evaluate('() => Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(OUT/f'studio4n-live-accounts-{theme}-{width}.png'),full_page=True)
    page.get_by_role('button',name='Hubungkan GoPay',exact=True).click()
    expect(page.locator('#gpLoginDialog')).to_be_visible()
    expect(page.locator('#gpPaygatePassword')).to_be_visible()
    check_notice(page, '#gpLoginDialog')
    page.evaluate('() => Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
    assert page.locator('#gpLoginDialog').evaluate('(el) => getComputedStyle(el).opacity') == '1'
    page.screenshot(path=str(OUT/'studio4n-live-gopay-login-320.png'),full_page=True)
    page.keyboard.press('Escape')
    expect(page.get_by_role('button',name='Hubungkan GoPay',exact=True)).to_be_focused()
    for theme in ['light','dark']:
        if page.evaluate('document.documentElement.dataset.theme')!=theme:
            page.get_by_role('button',name='Ganti tema terang/gelap').click()
        for width in [1280,768,390,320]:
            page.set_viewport_size({'width':width,'height':844})
            before=len(requests)
            page.get_by_role('button',name='Login ShopeePay',exact=True).click()
            expect(page.get_by_role('dialog',name='Login ShopeePay',exact=True)).to_be_visible()
            expect(page.locator('#spStartForm')).to_be_visible()
            expect(page.locator('#spOtpForm')).not_to_be_visible()
            expect(page.locator('#spStoreForm')).not_to_be_visible()
            expect(page.locator('#spIdentifier')).to_be_focused()
            expect(page.get_by_label('Password Shopee (bukan PayGate)',exact=True)).to_have_attribute('type','password')
            expect(page.get_by_label('Password PayGate (bukan Shopee)',exact=True)).to_have_attribute('type','password')
            for field in ['spIdentifier','spMerchantPassword','spPaygatePassword','spConsent']:
                assert page.locator('#'+field).get_attribute('required') is not None
            check_notice(page, '#spLoginDialog')
            for key in ['Tab','Shift+Tab']:
                for _ in range(14):
                    page.keyboard.press(key);assert page.evaluate('!!document.activeElement.closest("#spLoginDialog")')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            settled(page)
            assert page.locator('#spLoginDialog').evaluate('(el)=>getComputedStyle(el).opacity')=='1'
            check_dialog_bounds(page, '#spLoginDialog')
            page.screenshot(path=str(OUT/f'studio4n-live-shopee-login-{theme}-{width}.png'),full_page=True)
            page.keyboard.press('Escape')
            expect(page.locator('#spLoginDialog')).not_to_be_visible()
            expect(page.get_by_role('button',name='Login ShopeePay',exact=True)).to_be_focused()
            assert len(requests)==before, 'Login open/Tab/Escape must make no requests'
    assert len(acknowledgements)==1
    before=len(requests)
    page.get_by_role('button',name='Login ShopeePay',exact=True).click()
    page.locator('#spIdentifier').fill('cancel-only@example.test')
    page.locator('#spMerchantPassword').fill('cancel-only-not-submitted')
    page.locator('#spPaygatePassword').fill('cancel-only-not-submitted')
    page.locator('#spConsent').check()
    page.locator('#spLoginDialog').get_by_role('button',name='Batal',exact=True).click()
    expect(page.get_by_role('button',name='Login ShopeePay',exact=True)).to_be_focused()
    page.get_by_role('button',name='Login ShopeePay',exact=True).click()
    for field in ['spIdentifier','spMerchantPassword','spPaygatePassword','spOtp','spQris']:
        expect(page.locator('#'+field)).to_have_value('')
    expect(page.locator('#spConsent')).not_to_be_checked()
    expect(page.locator('#spAutoCheck')).to_be_checked()
    expect(page.locator('#spFinishSubmit')).to_have_text('Simpan & aktifkan')
    page.keyboard.press('Escape')
    expect(page.get_by_role('button',name='Login ShopeePay',exact=True)).to_be_focused()
    assert len(requests)==before, 'Cancelled credentials never submitted; reopen must make no requests'
    assert page.evaluate('Object.keys({...localStorage,...sessionStorage}).every(k=>["paygate_theme","paygate_accent"].includes(k))')
    page.goto(BASE+'/orders',wait_until='networkidle');check_content(page)
    assert page.url == BASE+'/orders'
    expect(page.locator('[data-action="open-create"]')).to_be_disabled()
    page.goto(BASE+'/docs',wait_until='networkidle');check_content(page)
    assert page.url == BASE+'/docs'
    expect(page.get_by_role('link',name='Unduh server checkout')).to_be_visible()
    for name, source in [('WEBSITE.md','docs/WEBSITE.md'),('website.mjs','examples/website.mjs'),('SHOPEE_CONNECT.md','docs/SHOPEE_CONNECT.md')]:
        download=context.request.get(BASE+'/docs/'+name,max_redirects=0)
        assert download.status==200 and 'attachment' in download.headers.get('content-disposition','')
        assert download.body()==(Path('/root/paygate')/source).read_bytes()
        anonymous=browser.new_context()
        try:
            denied=anonymous.request.get(BASE+'/docs/'+name,max_redirects=0)
            assert denied.status in [302,401]
        finally:
            anonymous.close()
    assert not errors, errors
    print(json.dumps({'ok':True,'url':BASE+'/accounts','owner_login_control':True,'shopee_password_login_available':True,'shopee_provider_auth_tested':False,'terms_acknowledgements':len(acknowledgements),'disconnected_order_gate':True,'viewports':[1280,768,390,320],'pages':['dashboard','accounts','orders','transactions','api-keys','settings','docs','tos'],'asset_version':ASSET_VERSION,'themes':['light','dark'],'console_errors':errors,'provider_requests':0,'payment_mutations':0,'artifacts':str(OUT)}))
    browser.close()
