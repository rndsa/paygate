"""Real-browser regression. Never accepts live URL; runs copied app + fresh DB.
Run: /root/camofox-venv/bin/python tests/ui_smoke.py
Optional CHROMIUM_PATH overrides installed Chromium discovery. No dependencies added.
"""
import json
import hashlib
import hmac
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit, parse_qs

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(tempfile.mkdtemp(prefix='paygate-studio4n-ui-artifacts-'))
ASSET_VERSION = re.search(r'/static/css/app\.css\?v=([^"\s]+)', (ROOT / 'views/layout.ejs').read_text()).group(1)
assert ASSET_VERSION == 'studio4n', 'Legal/password UX requires studio4n cache-busted assets'
ARTIFACTS.mkdir(exist_ok=True)


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


def check_layout(page):
    check_content(page)
    overflow = page.evaluate('document.documentElement.scrollWidth - innerWidth')
    assert overflow <= 0, 'page horizontal overflow by %spx; culprits: %s' % (overflow, page.evaluate("() => { const vw = window.innerWidth; const bad = []; for (const el of document.querySelectorAll('body *')) { if (el.closest('.sidebar') && !el.closest('.sidebar').classList.contains('open')) continue; const r = el.getBoundingClientRect(); if (r.right > vw + 1) { bad.push(el.tagName + '.' + String(el.className).slice(0,80) + ' w=' + Math.round(r.width) + ' right=' + Math.round(r.right)); if (bad.length > 10) break; } } return bad; }"))
    assert page.locator('.card-header h2, .docs-section h2').evaluate_all('(els) => els.every(el => parseFloat(getComputedStyle(el).fontSize) <= 18)'), 'Section headings must stay subordinate to page title'
    assert page.locator('script:not([src])').count() == 0
    assert page.evaluate('!Array.from(document.querySelectorAll("*")).some(el => Array.from(el.attributes).some(a => /^on/i.test(a.name)))')


def lab_ui_checks(browser, url, app):
    """Explicit contract fixtures. Browser requests intercepted; no upstream login or payments."""
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, service_workers='block')
    forbidden = []
    def fixture_only(route):
        req = route.request
        if urlsplit(req.url)[:2] == urlsplit(url)[:2] and req.method == 'GET' and urlsplit(req.url).path.startswith('/static/'):
            route.continue_()
        else:
            forbidden.append((req.method, urlsplit(req.url).path))
            route.abort()
    ctx.route('**/*', fixture_only)
    ctx.add_cookies([{'name': 'paygate_csrf', 'value': 'fixture-csrf', 'url': url}])
    page = ctx.new_page()
    errors, writes, held, held_gets, requests = [], [], [], [], []
    page.on('request', lambda r: requests.append((r.method, r.url)))
    page.on('pageerror', lambda e: errors.append(str(e)))
    dev_logs=[]
    page.on('console', lambda m: dev_logs.append(m.args[1].json_value()) if m.type=='warning' and m.text.startswith('[PayGate] Request failed') else None)
    state = {'owner': True, 'fail': False, 'status': 'unconfigured', 'sp_status': 'unconfigured', 'available': True}
    source = """import ejs from 'ejs';const d={config:{labUnofficialEnabled:true,labUserId:7},user:{id:7,username:'UI fixture'},title:'UI fixture',active:process.argv[1]};d.body=await ejs.renderFile('views/pages/'+d.active+'.ejs',d);console.log(await ejs.renderFile('views/layout.ejs',d));"""
    for name in ['accounts','orders']:
        html=subprocess.run(['node','--input-type=module','-e',source,name],cwd=app,check=True,capture_output=True,text=True).stdout
        page.route(url+'/'+name,lambda r,req,html=html:r.fulfill(status=200,content_type='text/html',headers={'Content-Security-Policy':"default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data:;connect-src 'self'"},body=html))
    def api(route):
        req=route.request; p=req.url.removeprefix(url)
        if req.method=='POST':
            assert p in {'/api/orders/create','/api/accounts/login/start','/api/accounts/login/verify','/api/accounts/login/finish','/api/accounts/login/cancel','/api/accounts/shopee/login/start','/api/accounts/shopee/login/verify','/api/accounts/shopee/login/finish','/api/accounts/shopee/login/cancel','/api/accounts/test','/api/accounts/pause','/api/accounts/resume'}, 'Unexpected fixture mutation'
            assert req.headers.get('x-csrf-token')=='fixture-csrf'
            writes.append((p,req.post_data_json));held.append(route);return
        assert req.method == 'GET', 'Unexpected fixture method'
        if p=='/api/accounts':
            if state['fail']: route.fulfill(status=503,json={'error':'Metadata unavailable'});return
            statuses={'gopay':state['status'],'shopeepay':state['sp_status']}
            payload={'accounts':[{'provider':provider,'label':'UI fixture','status':s,'last_validated_at':1 if s=='active' else 0,'next_poll_at':state.get('cooldown',0),'last_error':state.get('last_error','')} for provider,s in statuses.items() if s!='unconfigured'],'lab':{'enabled':True,'owner':state['owner'],'poll_interval_ms':60000,'providers':[{'provider':provider,'configured':state.get('configured',s!='unconfigured'),'status':s} for provider,s in statuses.items()]},'login':{'gopay':{'available':state['available'],'reason':'UI fixture'},'shopeepay':{'available':state.get('sp_available',True),'method':'browser_password','reason':'UI fixture'}}}
        elif p=='/api/orders':payload={'orders':[{'id':'LEGACY','provider':'gopay','amount':1,'status':'paid','payment_origin':'legacy_unverified'}]}
        elif p=='/api/orders/LEGACY/status':payload={'order_id':'LEGACY','provider':'gopay','amount':1,'status':'pending','payment_origin':'legacy_unverified','mock':False,'lab_unofficial':True,'qris_image':'data:image/png;base64,aA==','qris_payload':'DO NOT DISPLAY','expires_at':int(time.time()*1000)+60000}
        else:raise AssertionError(p)
        if p=='/api/accounts' and state.get('hold_accounts'):held_gets.append((route,payload));return
        route.fulfill(status=200,json=payload)
    page.route(url+'/api/**',api)
    page.goto(url+'/orders',wait_until='networkidle');check_content(page);expect(page.locator('[data-action="open-create"]')).to_be_disabled()
    page.get_by_role('button',name='Detail',exact=True).click();expect(page.locator('#detailBody')).to_contain_text('Order lama dari sistem sebelumnya');assert page.locator('#detailBody img').count()==0;assert 'DO NOT DISPLAY' not in page.locator('#detailBody').inner_text();page.keyboard.press('Escape')
    page.route(url+'/api/orders/LIVE/status',lambda r:r.fulfill(status=200,json={'order_id':'LIVE','provider':'gopay','amount':1,'status':'pending','payment_origin':'live','lab_unofficial':True,'qris_image':'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0n8AAAAASUVORK5CYII=','qris_payload':'NONPAYABLE FIXTURE','expires_at':int(time.time()*1000)+60000}))
    page.locator('[data-action="open-detail"]').evaluate("el=>el.dataset.id='LIVE'")
    page.get_by_role('button',name='Detail',exact=True).click();expect(page.locator('#detailBody img')).to_be_visible();page.keyboard.press('Escape')
    for status in ['paused','blocked','error','configured']:
        state['status']=status;page.reload(wait_until='networkidle');check_content(page);expect(page.locator('[data-action="open-create"]')).to_be_disabled()
    state['status']='active';state['owner']=False;page.reload(wait_until='networkidle');check_content(page);expect(page.locator('[data-action="open-create"]')).to_be_disabled()
    state['owner']=True;state['fail']=True;page.reload(wait_until='networkidle');check_content(page);expect(page.locator('[data-action="open-create"]')).to_be_disabled()
    state['fail']=False;page.reload(wait_until='networkidle');check_content(page);page.locator('[data-action="open-create"]').click()
    expect(page.locator('#createModal')).to_be_visible()
    for _ in range(10):
        page.keyboard.press('Tab');assert page.evaluate('!!document.activeElement.closest("dialog")')
    page.locator('#oAmount').fill('100001');page.locator('#btnCreate').click();assert not writes
    page.locator('#oAmount').fill('25000');page.locator('#btnCreate').click();assert not writes
    page.locator('#labConsent').check();page.locator('#btnCreate').click();expect(page.locator('#btnCreate')).to_be_disabled()
    assert writes[-1][1]=={'amount':25000,'provider':'gopay','description':''}
    state['status']='paused';held.pop().fulfill(status=503,json={'error':'Account paused'});expect(page.locator('#btnCreate')).to_be_disabled();expect(page.locator('#createError')).to_contain_text('Account paused')
    page.keyboard.press('Escape');writes.clear()
    state['status']='unconfigured';page.goto(url+'/accounts',wait_until='networkidle');check_content(page);assert not writes
    assert page.locator('#spBody input').count()==0
    assert not errors, errors
    expect(page.locator('[data-action="shopee-guide"]')).to_have_text('Hubungkan ShopeePay')
    for sel in ['#spGuideDialog','#spConnectDialog','#spToken','#spPassword']:
        assert not page.locator(sel).first.is_visible(), ('unexpected visible shopee control',sel)
    assert 'DevTools' not in page.locator('body').text_content()
    page.set_default_timeout(5000)
    def stopped(count):
        page.wait_for_load_state('networkidle')
        assert len(writes)==count and not held, ('unexpected automatic request', writes)
    def pending(count):
        deadline=time.monotonic()+5
        while len(writes)<count and time.monotonic()<deadline:page.wait_for_timeout(20)
        assert len(writes)==count and len(held)==1, ('missing/duplicate request',writes)
    for status,configured,error,cooldown,action,label in [
        ('unconfigured',False,'',0,None,None), ('paused',False,'ENV_INCOMPLETE',0,None,None),
        ('active',True,'',0,'lab-pause',None), ('paused',True,'',0,'lab-resume','Aktifkan otomatis'),
        ('configured',True,'',0,'lab-test','Aktifkan otomatis'), ('error',True,'NETWORK',0,'lab-test','Cek kembali'),
        ('blocked',True,'AUTH_REJECTED',0,None,None), ('blocked',True,'CHALLENGE',0,None,None),
        ('configured',True,'RATE_LIMITED',int(time.time()*1000)+3600000,None,None),
        ('active',True,'',int(time.time()*1000)+3600000,'lab-pause',None)]:
        state.update(status=status,sp_status=status,configured=configured,last_error=error,cooldown=cooldown)
        page.reload(wait_until='networkidle');check_content(page)
        for prefix in ['gp','sp']:
            box=page.locator('#'+prefix+'Body')
            expect(box.locator('[data-action="gopay-login"], [data-action="shopee-guide"]')).to_be_enabled()
            if not configured:expect(page.locator('#'+prefix+'Badge')).to_have_text('Belum terhubung')
            actions=box.locator('[data-action^="lab-"]')
            assert actions.evaluate_all('els=>els.map(el=>el.dataset.action)')==([action] if action else []), (prefix,status,configured,error,cooldown)
            if action:
                expect(actions).to_be_enabled()
                if label:expect(actions).to_have_text(label)
            if cooldown and status != 'active':
                stamp=page.evaluate('v=>PayGate.fmtDate(v)',cooldown)
                expect(box).to_contain_text(stamp)
            if status == 'active':
                expect(box).not_to_contain_text('Pemeriksaan dijeda sampai')
        assert not writes and not held
    state.update(status='unconfigured',sp_status='unconfigured')
    for key in ['configured','last_error','cooldown']:state.pop(key,None)
    page.reload(wait_until='networkidle')
    page.get_by_role('button',name='Hubungkan GoPay',exact=True).click()
    for _ in range(10):
        page.keyboard.press('Tab');assert page.evaluate('!!document.activeElement.closest("dialog")')
    page.keyboard.press('Escape');expect(page.locator('#gpLoginDialog')).not_to_be_visible();expect(page.locator('[data-action="gopay-login"]')).to_be_focused()
    page.locator('[data-action="gopay-login"]').click()
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844});check_layout(page);check_notice(page, '#gpLoginDialog')
    page.locator('#gpPhone').fill('081234567890');page.locator('#gpPaygatePassword').fill('private-password');page.locator('#gpRiskConsent').check();page.locator('[data-action="gopay-start"]').click()
    expect(page.locator('[data-action="gopay-start"]')).to_be_disabled();assert len(held)==1
    exp={'provider':'gopay','phone':'+62'+'81234567890','password':'private-password','otp_channel':'sms','consent':True}
    assert writes[-1]==('/api/accounts/login/start',exp),('login/start payload',writes[-1])

    held.pop().fulfill(status=200,json={'ok':True,'attempt_id':'opaque-attempt','step':'otp','expires_at':int(time.time()*1000)+60000})
    expect(page.locator('#gpStepOtp')).to_be_visible();expect(page.locator('#gpPaygatePassword')).to_have_value('')
    page.locator('#gpOtp').fill('123456');page.locator('[data-action="gopay-verify"]').click();expect(page.locator('[data-action="gopay-verify"]')).to_be_disabled()
    assert writes[-1][1]=={'provider':'gopay','attempt_id':'opaque-attempt','otp':'123456'}
    held.pop().fulfill(status=200,json={'ok':True,'attempt_id':'opaque-attempt','step':'merchant','merchants':[{'id':'choice-a','label':'Merchant A'},{'id':'choice-b','label':'Merchant B'}]})
    expect(page.locator('#gpStepMerchant')).to_be_visible();expect(page.locator('#gpOtp')).to_have_value('');expect(page.locator('#gpAutoCheck')).to_be_checked();page.locator('#gpMerchant').select_option('choice-b');page.get_by_role('button',name='Simpan & aktifkan',exact=True).click()
    assert writes[-1][1]=={'provider':'gopay','attempt_id':'opaque-attempt','merchant':'choice-b'}
    assert [p for p,_ in writes]==['/api/accounts/login/start','/api/accounts/login/verify','/api/accounts/login/finish']
    count=len(writes)
    page.locator('[data-action="gopay-finish"]').dispatch_event('click');page.keyboard.press('Escape')
    expect(page.locator('#gpLoginDialog')).to_be_visible();assert len(writes)==count
    state['status']='configured';held.pop().fulfill(status=200,json={'ok':True,'detail':'Saved.'})
    pending(count+1);assert writes[-1]==('/api/accounts/test',{'provider':'gopay'})
    expect(page.locator('[data-action="gopay-login"]')).to_be_disabled()
    page.locator('[data-action="gopay-login"]').dispatch_event('click');assert len(writes)==count+1
    held.pop().fulfill(status=503,json={'error':'Blocked <img src=x>'})
    expect(page.locator('#gpBody')).to_contain_text('Blocked <img src=x>');assert page.locator('#gpBody img').count()==0
    expect(page.locator('#gpLoginDialog')).not_to_be_visible();stopped(count+1)
    assert page.evaluate('JSON.stringify({...localStorage,...sessionStorage})')=='{}'
    page.locator('[data-action="gopay-login"]').click();page.locator('#gpPhone').fill('081234567890');page.locator('#gpPaygatePassword').fill('private-password');page.locator('#gpRiskConsent').check();page.locator('[data-action="gopay-start"]').click()
    count=len(writes);held.pop().fulfill(status=403,json={'error':'Provider rejected <img src=x>; retry manually','code':'AUTH_REJECTED'});expect(page.locator('#gpLoginError')).to_contain_text('Provider rejected <img src=x>');assert page.locator('#gpLoginError img').count()==0;expect(page.locator('#gpPaygatePassword')).to_have_value('');expect(page.locator('#gpStepStart')).to_be_visible();stopped(count)
    page.keyboard.press('Escape');page.locator('[data-action="gopay-login"]').click();page.locator('#gpPhone').fill('081234567890');page.locator('#gpPaygatePassword').fill('private-password');page.locator('#gpRiskConsent').check()
    nlogs=len(dev_logs);before_phone=len(writes)
    page.locator('[data-action="gopay-start"]').click();pending(before_phone+1)
    phone_copy='GoBiz menolak login dengan nomor telepon ini. Periksa nomor dan akses akun merchant melalui portal resmi GoBiz.'
    diagnostic_id='918bd087-7f5c-489e-b36e-3545cb799f7c'
    held.pop().fulfill(status=503,json={'error':phone_copy,'code':'PHONE_REJECTED','diagnostic':{'id':diagnostic_id,'stage':'otp_request','provider_status':401,'body':'NEVER_EXPOSE'}})
    expect(page.locator('#gpLoginError')).to_have_text(phone_copy)
    expect(page.locator('#gpPaygatePassword')).to_have_value('');expect(page.locator('#gpStepStart')).to_be_visible()
    assert len(dev_logs)==nlogs+1 and dev_logs[-1]['code']=='PHONE_REJECTED'
    assert dev_logs[-1]['id']==diagnostic_id and dev_logs[-1]['provider_status']==401
    assert not any(secret in json.dumps(dev_logs[-1]) for secret in ['NEVER_EXPOSE','+6281234567890','private-password'])
    stopped(before_phone+1);page.locator('#gpPhone').fill('')
    for width in [390,320]:
        page.set_viewport_size({'width':width,'height':844});check_layout(page);check_notice(page,'#gpLoginDialog')
    page.screenshot(path=str(ARTIFACTS/'gopay-phone-rejected-client-320.png'))
    page.keyboard.press('Escape');page.locator('[data-action="gopay-login"]').click();page.locator('#gpPhone').fill('081234567890');page.locator('#gpPaygatePassword').fill('private-password');page.locator('#gpRiskConsent').check();page.locator('[data-action="gopay-start"]').click()
    held.pop().fulfill(status=200,json={'ok':True,'attempt_id':'cancel-attempt','step':'otp','expires_at':int(time.time()*1000)+60000});expect(page.locator('#gpStepOtp')).to_be_visible();page.keyboard.press('Escape')
    assert writes[-1]==('/api/accounts/login/cancel',{'provider':'gopay','attempt_id':'cancel-attempt'})
    held.pop().fulfill(status=200,json={'ok':True});expect(page.locator('#gpLoginDialog')).not_to_be_visible();expect(page.locator('#gpPhone')).to_have_value('')
    # Same OTP/discovery contract: save failure stops, unchecked save skips test, checked save activates once.
    for mode in ['save-failure','save-only','activate']:
        begin=len(writes)
        page.locator('[data-action="gopay-login"]').click();page.locator('#gpPhone').fill('081234567890');page.locator('#gpPaygatePassword').fill('private-password');page.locator('#gpRiskConsent').check();page.locator('[data-action="gopay-start"]').click()
        held.pop().fulfill(status=200,json={'ok':True,'attempt_id':'repeat-attempt','step':'otp','expires_at':int(time.time()*1000)+60000})
        expect(page.locator('#gpStepOtp')).to_be_visible();page.locator('#gpOtp').fill('123456');page.locator('[data-action="gopay-verify"]').click()
        held.pop().fulfill(status=200,json={'ok':True,'attempt_id':'repeat-attempt','step':'merchant','merchants':[{'id':'choice-a','label':'Merchant A'}]})
        expect(page.locator('#gpStepMerchant')).to_be_visible();expect(page.locator('#gpAutoCheck')).to_be_checked()
        if mode=='save-only':page.locator('#gpAutoCheck').uncheck()
        page.locator('[data-action="gopay-finish"]').click();assert writes[-1]==('/api/accounts/login/finish',{'provider':'gopay','attempt_id':'repeat-attempt','merchant':'choice-a'})
        if mode=='save-failure':
            held.pop().fulfill(status=503,json={'error':'Save rejected <img src=x>'})
            expect(page.locator('#gpLoginError')).to_contain_text('Save rejected <img src=x>');assert page.locator('#gpLoginError img').count()==0;stopped(begin+3)
            page.keyboard.press('Escape');pending(begin+4)
            assert writes[-1]==('/api/accounts/login/cancel',{'provider':'gopay','attempt_id':'repeat-attempt'})
            held.pop().fulfill(status=200,json={'ok':True})
            expect(page.locator('#gpLoginDialog')).not_to_be_visible();stopped(begin+4)
        else:
            state['status']='configured';held.pop().fulfill(status=200,json={'ok':True,'detail':'Saved.'})
            if mode=='activate':
                pending(begin+4);assert writes[-1]==('/api/accounts/test',{'provider':'gopay'})
                state['status']='active';held.pop().fulfill(status=200,json={'ok':True,'detail':'Fixture feed validated'})
            expect(page.locator('#gpLoginDialog')).not_to_be_visible()
            expect(page.locator('#gpBadge')).to_have_text('Aktif' if mode=='activate' else 'Tersimpan');stopped(begin+(4 if mode=='activate' else 3))
    state['status']='configured';page.reload(wait_until='networkidle')
    assert not re.search(r'localStorage|sessionStorage', (app/'public/js/pages.js').read_text())
    writes.clear()
    sp = page.locator('[data-action="shopee-guide"]')
    def open_shopee():
        before=len(requests)
        # Two-step flow: launcher opens a guide dialog with two choices
        # (browser login / session import); browser login opens the wizard.
        if not page.locator('#spLoginDialog').is_visible():
            sp.click()
            expect(page.get_by_role('dialog',name='Hubungkan ShopeePay',exact=True)).to_be_visible()
            page.locator('#spGuideDialog .modal-footer [data-action="shopee-browser"]').click()
        expect(page.get_by_role('dialog',name='Login ShopeePay',exact=True)).to_be_visible()
        expect(page.locator('#spIdentifier')).to_be_focused()
        expect(page.locator('#spStartForm')).to_be_visible()
        expect(page.locator('#spOtpForm')).not_to_be_visible()
        expect(page.locator('#spStoreForm')).not_to_be_visible()
        expect(page.locator('#spAutoCheck')).to_be_checked()
        expect(page.locator('#spFinishSubmit')).to_have_text('Simpan & aktifkan')
        assert len(requests)==before, 'Opening login must make no requests'
    def fill_shopee():
        for field,value in {'spIdentifier':'merchant@example.test','spMerchantPassword':'merchant-private-password','spPaygatePassword':'private-password'}.items():page.locator('#'+field).fill(value)
    def clear_secrets():
        for field in ['spMerchantPassword','spPaygatePassword','spOtp','spQris']:expect(page.locator('#'+field)).to_have_value('')
        assert page.evaluate('Object.keys({...localStorage,...sessionStorage}).every(k=>k==="paygate_theme")')
    def reply_store(attempt='store-attempt'):
        held.pop().fulfill(status=200,json={'ok':True,'attempt_id':attempt,'step':'store','expires_at':int(time.time()*1000)+60000,'choices':[{'id':'opaque-a','label':'Store A <img src=x>'},{'id':'opaque-b','label':'Store B'}]})
        expect(page.locator('#spStoreForm')).to_be_visible()
        expect(page.locator('#spChoice')).to_be_focused()
        assert page.locator('#spChoice img').count()==0
        expect(page.locator('#spChoice option').first).to_have_text('Store A <img src=x>')
        expect(page.locator('#spAutoCheck')).to_be_checked()
        expect(page.locator('#spFinishSubmit')).to_have_text('Simpan & aktifkan')
    def start_store():
        open_shopee();fill_shopee();page.locator('#spConsent').check();page.locator('#spStartSubmit').click();reply_store()
    def finish_store():
        page.locator('#spChoice').select_option('opaque-b')
        page.locator('#spQris').fill('NONPAYABLE QRIS FIXTURE')
        page.locator('#spFinishSubmit').click()
        assert writes[-1]==('/api/accounts/shopee/login/finish',{'attempt_id':'store-attempt','choice':'opaque-b','qris_static':'NONPAYABLE QRIS FIXTURE'})
    expect(sp).to_be_enabled()
    for theme in ['light','dark']:
        page.evaluate('theme => localStorage.setItem("paygate_theme",theme)',theme)
        page.reload(wait_until='networkidle')
        for width in [1280,768,390,320]:
            page.set_viewport_size({'width':width,'height':844});open_shopee()
            for key in ['Tab','Shift+Tab']:
                for _ in range(14):
                    page.keyboard.press(key);assert page.evaluate('!!document.activeElement.closest("#spLoginDialog")')
            check_layout(page);check_notice(page, '#spLoginDialog');check_dialog_bounds(page, '#spLoginDialog')
            page.screenshot(path=str(ARTIFACTS/f'shopee-login-{theme}-{width}.png'),full_page=True)
            page.keyboard.press('Escape');expect(page.locator('#spLoginDialog')).not_to_be_visible();expect(sp).to_be_focused()
            assert not writes and not held
    page.evaluate('localStorage.removeItem("paygate_theme")')
    open_shopee();fill_shopee();page.locator('#spStartSubmit').click();assert not writes
    page.locator('#spLoginDialog').get_by_role('button',name='Batal',exact=True).click();clear_secrets()
    expect(page.locator('#spIdentifier')).to_have_value('');assert not writes
    open_shopee();fill_shopee();page.locator('#spConsent').check();page.locator('#spStartSubmit').click()
    expect(page.locator('#spStartSubmit')).to_be_disabled();expect(page.locator('#spLoginDialog')).to_have_attribute('aria-busy','true')
    clear_secrets()
    page.locator('#spStartForm').dispatch_event('submit')
    assert len(writes)==1 and len(held)==1
    assert writes[-1]==('/api/accounts/shopee/login/start',{'identifier':'merchant@example.test','merchant_password':'merchant-private-password','password':'private-password','consent':True})
    held.pop().fulfill(status=200,json={'ok':True,'attempt_id':'otp-attempt','step':'otp','expires_at':int(time.time()*1000)+60000})
    expect(page.locator('#spOtp')).to_be_focused();expect(page.locator('#spLoginExpiry')).to_be_visible()
    page.locator('#spOtp').fill('123456');page.locator('#spVerifySubmit').click()
    assert writes[-1]==('/api/accounts/shopee/login/verify',{'attempt_id':'otp-attempt','otp':'123456'})
    expect(page.locator('#spVerifySubmit')).to_be_disabled();expect(page.locator('#spOtp')).to_have_value('')
    page.locator('#spOtpForm').dispatch_event('submit');assert len(writes)==2
    reply_store('store-attempt')
    page.locator('#spFinishSubmit').click();assert len(writes)==2, 'QRIS required before save'
    finish_store();expect(page.locator('#spFinishSubmit')).to_be_disabled();clear_secrets()
    page.locator('#spStoreForm').dispatch_event('submit');assert len(writes)==3
    state['sp_status']='configured';held.pop().fulfill(status=200,json={'ok':True,'expiry_source':'local_lease','expires_at':int(time.time()*1000)+12*60*60*1000})
    pending(4);assert writes[-1]==('/api/accounts/test',{'provider':'shopeepay'})
    expect(sp).to_be_disabled();expect(page.locator('#spBody')).to_have_attribute('aria-busy','true')
    sp.dispatch_event('click');page.locator('#spStoreForm').dispatch_event('submit');assert len(writes)==4
    held.pop().fulfill(status=503,json={'error':'Feed rejected <img src=x>'})
    expect(page.locator('#spBody')).to_contain_text('Feed rejected <img src=x>');assert page.locator('#spBody img').count()==0
    expect(page.locator('#spLoginDialog')).not_to_be_visible();expect(page.locator('#spBadge')).to_have_text('Tersimpan')
    expect(page.locator('#spLoginDialog')).not_to_have_attribute('aria-busy','true');clear_secrets();stopped(4)
    # Password/challenge/transport failure stops; no retries or automatic OTP resend.
    for code,status in [('AUTH_REJECTED',403),('CHALLENGE',403),('RATE_LIMITED',429),('NETWORK',503)]:
        start=len(writes);open_shopee();fill_shopee();page.locator('#spConsent').check();page.locator('#spStartSubmit').click()
        held.pop().fulfill(status=status,json={'error':'Provider rejected <img src=x>','code':code})
        expect(page.locator('#spLoginError')).to_contain_text('Provider rejected <img src=x>');assert page.locator('#spLoginError img').count()==0
        clear_secrets();expect(page.locator('#spStartSubmit')).to_be_disabled();page.locator('#spStartForm').dispatch_event('submit');stopped(start+1)
        page.keyboard.press('Escape');expect(sp).to_be_focused()
    # Cancellation wins over late start completion; returned attempt canceled exactly once.
    # click()/fulfill() do not await the route callback or the application's finally block.
    count=len(writes)
    open_shopee();fill_shopee();page.locator('#spConsent').check();page.locator('#spStartSubmit').click()
    pending(count+1)
    assert writes[-1]==('/api/accounts/shopee/login/start',{'identifier':'merchant@example.test','merchant_password':'merchant-private-password','password':'private-password','consent':True})
    expect(page.locator('#spLoginDialog')).to_have_attribute('aria-busy','true')
    start_route=held.pop()
    assert start_route.request.url==url+'/api/accounts/shopee/login/start'
    page.keyboard.press('Escape');expect(page.locator('#spLoginDialog')).not_to_be_visible();clear_secrets()
    start_route.fulfill(status=200,json={'ok':True,'attempt_id':'late-attempt','step':'otp','expires_at':int(time.time()*1000)+60000})
    pending(count+2);assert writes[-1]==('/api/accounts/shopee/login/cancel',{'attempt_id':'late-attempt'})
    # Require the fresh metadata response triggered after cancellation, then final DOM/focus.
    with page.expect_response(lambda r:r.url==url+'/api/accounts' and r.request.method=='GET') as refreshed:
        held.pop().fulfill(status=200,json={'ok':True})
    assert refreshed.value.status==200
    expect(page.locator('#spLoginDialog')).not_to_have_attribute('aria-busy','true')
    expect(page.locator('#spBody')).not_to_have_attribute('aria-busy','true')
    expect(sp).to_be_enabled()
    expect(sp).to_be_focused()
    stopped(count+2)
    late_cancel_focus = sp.evaluate('el => el === document.activeElement')
    # OTP rejection stops and cancel clears request-scoped state.
    open_shopee();fill_shopee();page.locator('#spConsent').check();page.locator('#spStartSubmit').click()
    held.pop().fulfill(status=200,json={'ok':True,'attempt_id':'cancel-attempt','step':'otp','expires_at':int(time.time()*1000)+60000})
    expect(page.locator('#spOtp')).to_be_focused();page.locator('#spOtp').fill('123456');page.locator('#spVerifySubmit').click()
    held.pop().fulfill(status=403,json={'error':'OTP rejected <img src=x>','code':'AUTH_REJECTED'})
    expect(page.locator('#spLoginError')).to_contain_text('OTP rejected <img src=x>');clear_secrets();count=len(writes)
    expect(page.locator('#spVerifySubmit')).to_be_disabled();page.locator('#spOtpForm').dispatch_event('submit');stopped(count)
    page.keyboard.press('Escape');pending(count+1)
    assert writes[-1]==('/api/accounts/shopee/login/cancel',{'attempt_id':'cancel-attempt'})
    held.pop().fulfill(status=200,json={'ok':True});stopped(count+1)
    # Save failure never tests; explicit save-only never activates.
    for mode in ['save-failure','save-only']:
        start_store()
        if mode=='save-only':
            page.locator('#spAutoCheck').uncheck();expect(page.locator('#spFinishSubmit')).to_have_text('Simpan saja')
        finish_store();count=len(writes)
        if mode=='save-failure':
            held.pop().fulfill(status=503,json={'error':'Save rejected <img src=x>'})
            expect(page.locator('#spLoginError')).to_contain_text('Save rejected <img src=x>');clear_secrets();stopped(count)
            page.keyboard.press('Escape');pending(count+1)
            assert writes[-1]==('/api/accounts/shopee/login/cancel',{'attempt_id':'store-attempt'})
            held.pop().fulfill(status=200,json={'ok':True});stopped(count+1)
        else:
            state['sp_status']='configured';held.pop().fulfill(status=200,json={'ok':True,'expiry_source':'local_lease','expires_at':int(time.time()*1000)+12*60*60*1000})
            expect(page.locator('#spLoginDialog')).not_to_be_visible();expect(page.locator('#spBadge')).to_have_text('Tersimpan');stopped(count)
    page.goto(url+'/orders',wait_until='networkidle');check_content(page);expect(page.locator('[data-action="open-create"]')).to_be_disabled()
    page.goto(url+'/accounts',wait_until='networkidle');check_content(page)
    test=page.locator('[data-action="lab-test"][data-provider="shopeepay"]');test.click()
    expect(test).to_be_disabled();expect(page.locator('#spBody')).to_have_attribute('aria-busy','true')
    assert writes[-1]==('/api/accounts/test',{'provider':'shopeepay'})
    held.pop().fulfill(status=503,json={'error':'Feed rejected'})
    expect(page.locator('#spBody')).to_contain_text('Feed rejected');expect(test).to_be_enabled();expect(page.locator('#spBody')).not_to_have_attribute('aria-busy','true');stopped(len(writes))
    test.click();state['sp_status']='active';held.pop().fulfill(status=200,json={'ok':True,'detail':'Fixture feed validated'})
    expect(page.locator('#spBadge')).to_have_text('Aktif');expect(test).to_have_count(0);expect(page.locator('#spBody')).not_to_have_attribute('aria-busy','true')
    pause=page.locator('[data-action="lab-pause"][data-provider="shopeepay"]');expect(pause).to_be_focused()
    pause.click();assert writes[-1]==('/api/accounts/pause',{'provider':'shopeepay'});state['sp_status']='paused';held.pop().fulfill(status=200,json={'ok':True,'detail':'Paused'})
    resume=page.locator('[data-action="lab-resume"][data-provider="shopeepay"]');expect(resume).to_be_focused()
    resume.click();assert writes[-1]==('/api/accounts/resume',{'provider':'shopeepay'});state['sp_status']='active';held.pop().fulfill(status=200,json={'ok':True,'detail':'Resumed'})
    expect(page.locator('[data-action="lab-pause"][data-provider="shopeepay"]')).to_be_focused()
    # Mutation completion must queue fresh metadata behind overlapping stale GET.
    state['hold_accounts']=True;page.locator('[data-action="refresh-accounts"]').dispatch_event('click')
    deadline=time.monotonic()+5
    while not held_gets and time.monotonic()<deadline:page.wait_for_timeout(20)
    assert len(held_gets)==1, 'Missing held account GET'
    page.locator('[data-action="lab-pause"][data-provider="shopeepay"]').click()
    state['sp_status']='paused';held.pop().fulfill(status=200,json={'ok':True,'detail':'Paused'})
    stale_route,stale_payload=held_gets.pop();state['hold_accounts']=False
    stale_route.fulfill(status=200,json=stale_payload)
    expect(page.locator('#spBadge')).to_have_text('Dijeda')
    expect(page.locator('[data-action="lab-resume"][data-provider="shopeepay"]')).to_be_focused()
    # Default selection resets after save-only; successful auto-check activates once.
    start_store();count=len(writes);finish_store()
    state['sp_status']='configured';held.pop().fulfill(status=200,json={'ok':True,'expiry_source':'local_lease','expires_at':int(time.time()*1000)+12*60*60*1000})
    pending(count+2);assert writes[-1]==('/api/accounts/test',{'provider':'shopeepay'})
    state['sp_status']='active';held.pop().fulfill(status=200,json={'ok':True,'detail':'Fixture feed validated'})
    expect(page.locator('#spBadge')).to_have_text('Aktif');stopped(count+2)
    page.goto(url+'/orders',wait_until='networkidle');check_content(page);expect(page.locator('[data-action="open-create"]')).to_be_enabled()
    assert page.evaluate('JSON.stringify({...localStorage,...sessionStorage})')=='{}'
    # Metadata failure while wizard is already open must stop before writes, not throw.
    page.goto(url+'/accounts',wait_until='networkidle')
    page.locator('[data-action="gopay-login"]').click()
    page.locator('#gpPhone').fill('081234567890');page.locator('#gpPaygatePassword').fill('private-password');page.locator('#gpRiskConsent').check()
    state['fail']=True
    page.locator('[data-action="refresh-accounts"]').dispatch_event('click')
    expect(page.locator('#gpBody')).to_contain_text('Status gagal dimuat')
    count=len(writes);error_count=len(errors)
    page.locator('[data-action="gopay-start"]').click()
    page.wait_for_load_state('networkidle')
    assert len(writes)==count and not held, 'Missing metadata must fail closed before provider mutation'
    page.keyboard.press('Escape');expect(page.locator('#gpLoginDialog')).not_to_be_visible()
    metadata_errors=errors[error_count:]
    state['fail']=False;page.reload(wait_until='networkidle')
    # Form.reset() does not emit change: checkbox and label reset after cancellation.
    start_store();page.locator('#spAutoCheck').uncheck()
    expect(page.locator('#spFinishSubmit')).to_have_text('Simpan saja')
    count=len(writes);page.keyboard.press('Escape');pending(count+1)
    assert writes[-1]==('/api/accounts/shopee/login/cancel',{'attempt_id':'store-attempt'})
    held.pop().fulfill(status=200,json={'ok':True});stopped(count+1);expect(sp).to_be_focused()
    start_store();expect(page.locator('#spAutoCheck')).to_be_checked()
    reset_label=page.locator('#spFinishSubmit').inner_text()
    settled(page);check_dialog_bounds(page, '#spLoginDialog')
    page.screenshot(path=str(ARTIFACTS/'shopee-reopened-unchecked-320.png'),full_page=True)
    count=len(writes);page.keyboard.press('Escape');pending(count+1)
    held.pop().fulfill(status=200,json={'ok':True});stopped(count+1);expect(sp).to_be_focused()
    assert not metadata_errors and reset_label=='Simpan & aktifkan', {'metadata_submit_pageerrors':metadata_errors,'unchecked_escape_reopen_label':reset_label}
    # Lost metadata and unavailable runtime fail before Shopee provider requests.
    open_shopee();fill_shopee();page.locator('#spConsent').check();state['fail']=True
    page.locator('[data-action="refresh-accounts"]').dispatch_event('click');expect(page.locator('#spBody')).to_contain_text('Status gagal dimuat')
    count=len(writes);page.locator('#spStartSubmit').click();stopped(count);clear_secrets()
    expect(page.locator('#spLoginError')).to_contain_text('Status akun gagal dimuat')
    page.keyboard.press('Escape');state['fail']=False;state['sp_available']=False
    page.reload(wait_until='networkidle');expect(sp).to_have_count(0)
    state['sp_available']=True
    state['owner']=False;page.goto(url+'/accounts',wait_until='networkidle');check_content(page);assert page.locator('#providerCards [data-action="gopay-login"], #providerCards [data-action="shopee-guide"]').count()==0
    assert late_cancel_focus, 'Busy Shopee cancellation must restore launcher focus after late response settles'
    assert not errors,errors
    assert not forbidden, ('Unscoped fixture request blocked', forbidden)
    assert not held and not held_gets, 'Unresolved fixture request'
    ctx.close();return {'contract_fixture':True,'upstream_tested':False,'checks':['owner','failed/no account','legacy QR hidden','busy','OTP','discovery select/save','state controls + cooldown + legacy metadata; password dialog no requests; password/OTP/store contract; late cancel; challenge/rate/network stop; automatic save/test exactly once + save-only','CSRF scoped fields','no secrets in storage','320/390 named dialog Tab/Escape/focus']}


with tempfile.TemporaryDirectory(prefix='paygate-ui-') as tmp:
    app = Path(tmp)
    for name in ['src', 'views', 'public', 'docs']:
        shutil.copytree(ROOT / name, app / name)
    for name in ['package.json', 'LICENSE']:
        shutil.copy2(ROOT / name, app / name)
    (ARTIFACTS / 'source-sha256.json').write_text(json.dumps({str(p.relative_to(app)): hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['src','views','public'] for p in sorted((app / folder).rglob('*')) if p.is_file()}, indent=2))
    (app / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    assert port != 3000
    url = f'http://127.0.0.1:{port}'
    env = dict(os.environ, HOST='127.0.0.1', PORT=str(port), NODE_ENV='development',
               DB_PATH=str(app / 'isolated.db'), PAYGATE_DATA_DIR=str(app / 'data'), BASE_URL=url, LAB_UNOFFICIAL='0', LAB_USER_ID='',
               GOPAY_ACCESS_TOKEN='', GOPAY_MERCHANT_ID='', GOPAY_QRIS_STATIC='',
               SHOPEEPAY_TOKEN='', SHOPEEPAY_MERCHANT_ID='', SHOPEEPAY_STORE_ID='', SHOPEEPAY_QRIS_STATIC='',
               ENCRYPTION_KEY='ab' * 32, COOKIE_SECRET='ui-isolated-' + 'cd' * 32,
               RATE_LIMIT_MAX='10000', POLL_INTERVAL_MS='60000', ORDER_TTL_MINUTES='7')
    seed = '''import { db } from './src/db/index.js';
import { hashPassword } from './src/lib/crypto.js';
db.prepare('INSERT INTO users (username,password_hash,created_at,updated_at) VALUES (?,?,?,?)').run('ui_smoke', await hashPassword('Ui-test-password-123!'), Date.now(), Date.now()); db.close();'''
    subprocess.run(['node', '--input-type=module', '-e', seed], cwd=app, env=env, check=True, capture_output=True)
    with (app / 'server.log').open('w+') as log:
        # Both provider adapters use native fetch. Fail before any upstream socket opens.
        boot = '''globalThis.fetch=async()=>{console.error('UI_TEST_UPSTREAM_FORBIDDEN');throw new Error('UI_TEST_UPSTREAM_FORBIDDEN')};await import('./src/server.js');'''
        server = subprocess.Popen(['node', '--input-type=module', '-e', boot], cwd=app, env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 15
            while True:
                if server.poll() is not None:
                    raise AssertionError('isolated server exited: ' + str(server.returncode))
                try:
                    with urllib.request.urlopen(url + '/healthz', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    pass
                assert time.monotonic() < deadline, 'isolated server readiness timeout'
                time.sleep(0.1)

            with sync_playwright() as pw:
                cached = sorted(Path('/root/.cache/ms-playwright').glob('chromium-*/chrome-linux64/chrome'))
                executable = os.environ.get('CHROMIUM_PATH') or (str(cached[-1]) if cached else None)
                browser = pw.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])
                context = browser.new_context(viewport={'width': 1280, 'height': 900}, service_workers='block')
                forbidden = []
                def local_only(route):
                    req = route.request
                    if urlsplit(req.url)[:2] != urlsplit(url)[:2] or (urlsplit(req.url).path.startswith('/api/accounts') and req.method != 'GET'):
                        forbidden.append((req.method, urlsplit(req.url).path))
                        route.abort()
                    else:
                        route.continue_()
                context.route('**/*', local_only)
                context.add_init_script('window.cspViolations = []; document.addEventListener("securitypolicyviolation", e => window.cspViolations.push(e.violatedDirective));')
                page = context.new_page()
                errors = []
                posts = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
                page.on('request', lambda req: posts.append(req) if req.method == 'POST' else None)

                def visit(route):
                    response = page.goto(url + route, wait_until='networkidle');check_content(page)
                    assert response.status == 200, (route, response.status)
                    check_content(page, response)
                    if route == '/tos':
                        check_faq(page)
                    assert page.url == url + route, ('unexpected redirect', route, page.url)
                    assert "script-src 'self'" in response.headers['content-security-policy']
                    expect(page.locator('.risk-banner')).to_have_count(0)
                    expect(page.locator('.topbar [aria-label="Info"], .topbar a[href="/settings"]')).to_have_count(0)
                    if page.locator('.sidebar').count():expect(page.locator('.sidebar a[href="/settings"]')).to_have_count(1)
                    assert 'LAB UNOFFICIAL' not in page.locator('body').inner_text()
                    expect(page.locator('link[rel="stylesheet"]')).to_have_attribute('href', f'/static/css/app.css?v={ASSET_VERSION}')
                    assert page.evaluate('window.cspViolations') == []
                    check_layout(page)

                response = page.goto(url + '/login', wait_until='networkidle');check_content(page)
                assert response.status == 200 and page.url == url + '/terms?next=%2Flogin'
                check_content(page, response)
                page.set_viewport_size({'width':320,'height':844})
                initial_bounds = check_compact_terms(page)
                shared_login = login_signature(page)
                terms_version = page.locator('input[name=version]').input_value()
                assert terms_version == '2026-09-08-pw1', 'Server-handled Shopee password flow needs fresh consent'
                expect(page.locator('script[src*="/terms.js"]')).to_have_attribute('src', f'/static/js/terms.js?v={ASSET_VERSION}')
                license_bytes = (app / 'LICENSE').read_bytes()
                raw = context.request.get(url + '/license.txt', max_redirects=0)
                assert raw.status == 200 and 'text/plain' in raw.headers.get('content-type', '')
                assert raw.body() == license_bytes
                denied_tos = context.request.get(url + '/tos', max_redirects=0)
                assert denied_tos.status == 302 and denied_tos.headers['location'].startswith('/login?'), '/tos must remain authenticated'
                # Old signed acknowledgement cannot bypass substantive password-flow consent.
                stale_payload = f'2026-09-08-source-mit.{int(time.time()*1000)+86400000}'
                stale_proof = hmac.new(env['COOKIE_SECRET'].encode(), ('paygate:terms:'+stale_payload).encode(), hashlib.sha256).hexdigest()
                stale = browser.new_context(service_workers='block')
                try:
                    stale.add_cookies([{'name':'paygate_terms','value':stale_payload+'.'+stale_proof,'url':url,'httpOnly':True,'sameSite':'Lax'}])
                    denied = stale.request.get(url + '/login', max_redirects=0)
                    assert denied.status == 303 and denied.headers['location'] == '/terms?next=%2Flogin', 'Old source-mit consent must be rejected'
                finally:
                    stale.close()
                expect(page.locator('#termsAccepted')).not_to_be_checked()
                page.get_by_role('button', name='Saya setuju & lanjutkan', exact=True).click()
                assert not posts and page.url == url + '/terms?next=%2Flogin'
                assert page.locator('#termsAccepted').evaluate('el => el.validity.valueMissing')
                page.keyboard.press('Escape')
                page.wait_for_url(url + '/terms?declined=1&next=%2Flogin')
                expect(page.get_by_role('status')).to_contain_text('Persetujuan belum disimpan')
                check_compact_terms(page)
                assert not posts and not any(c['name']=='paygate_terms' for c in context.cookies())
                page.get_by_role('link', name='Tidak setuju', exact=True).click()
                page.wait_for_load_state('networkidle')
                expect(page.get_by_role('status')).to_be_visible()
                assert not posts and not any(c['name']=='paygate_terms' for c in context.cookies())
                # The FAQ is real same-origin navigation in a new tab, never inline growth.
                link = page.locator('#termsDialog a[href="/terms/details"]')
                expect(link).to_have_attribute('target', '_blank')
                assert {'noopener','noreferrer'} <= set(link.get_attribute('rel').split())
                before = check_compact_terms(page)
                parent_url = page.url
                with context.expect_page() as detail_info:
                    link.click()
                detail_page = detail_info.value
                detail_page.on('pageerror', lambda error: errors.append(str(error)))
                detail_page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
                detail_page.wait_for_load_state('networkidle')
                assert detail_page.url == url + '/terms/details' and detail_page.evaluate('window.opener === null')
                check_faq(detail_page)
                detail_page.close()
                assert page.url == parent_url and check_compact_terms(page) == before, 'Detail link changed/grows consent popup'
                assert not posts and not any(c['name']=='paygate_terms' for c in context.cookies())
                geometry = []
                for theme in ['dark', 'light']:
                    # Theme control behind dialog is intentionally inert; use real public FAQ control.
                    visit('/terms/details')
                    if page.evaluate('document.documentElement.dataset.theme') != theme:
                        page.get_by_role('button', name='Ganti tema terang/gelap').click()
                    page.reload(wait_until='networkidle');check_content(page)
                    expect(page.locator('html')).to_have_attribute('data-theme', theme)
                    for width in [1280,768,390,320]:
                        page.set_viewport_size({'width':width,'height':844})
                        for route in ['/terms', '/terms/details', '/license']:
                            visit(route)
                            expect(page.locator('html')).to_have_attribute('data-theme', theme)
                            if route == '/terms':
                                box = check_compact_terms(page)
                                geometry.append({'theme':theme,'viewport_width':width,**box})
                            elif route == '/terms/details':
                                check_faq(page)
                            else:
                                check_license(page, license_bytes)
                            settled(page)
                            page.screenshot(path=str(ARTIFACTS / f'{route[1:].replace("/","-")}-{theme}-{width}.png'), full_page=True)
                            if route == '/terms/details':
                                page.locator('.terms-faq-item > summary').first.press('Enter')
                                settled(page)
                                page.screenshot(path=str(ARTIFACTS / f'faq-open-{theme}-{width}.png'), full_page=True)
                visit('/license')
                check_license(page, license_bytes)
                (ARTIFACTS / 'legal-geometry.json').write_text(json.dumps(geometry, indent=2))
                download_license(page, license_bytes, ARTIFACTS / 'LICENSE.txt')
                assert page.url == url + '/license'
                assert not posts and not any(c['name']=='paygate_terms' for c in context.cookies())
                visit('/terms')
                page.locator('#termsAccepted').check()
                with page.expect_response(lambda r: r.url == url + '/terms/accept') as accepted:
                    page.get_by_role('button', name='Saya setuju & lanjutkan', exact=True).click()
                assert accepted.value.status == 303
                acceptance = parse_qs(accepted.value.request.post_data)
                assert acceptance.get('version') == [terms_version] and acceptance.get('accepted') == ['yes'] and acceptance.get('_csrf')
                assert len(posts) == 1 and accepted.value.headers['location'] == '/login'
                page.wait_for_url(url + '/login')
                terms_cookie = next(c for c in context.cookies() if c['name']=='paygate_terms')
                assert terms_cookie['httpOnly'] and terms_cookie['sameSite']=='Lax'
                assert terms_cookie['value'].split('.')[0] == terms_version
                assert re.fullmatch(r'[^.]+\.\d{13}\.[a-f0-9]{64}', terms_cookie['value'])
                assert 180 * 86400 - 60 <= terms_cookie['expires'] - time.time() <= 180 * 86400 + 5
                assert 'paygate_terms=' not in page.evaluate('document.cookie')
                assert login_signature(page) == shared_login, 'Consent background must be same real login, not fake dashboard'
                expect(page.locator('.auth-wrap')).not_to_have_attribute('inert', '')
                page.reload(wait_until='networkidle');check_content(page);assert page.url == url + '/login'
                expect(page.locator('#termsDialog')).to_have_count(0)
                assert len(posts) == 1, 'Acceptance repeated without user action'
                page.set_viewport_size({'width':1280,'height':900})
                visit('/login')
                page.screenshot(path=str(ARTIFACTS / 'login-light-1280.png'), full_page=True)
                page.get_by_role('button', name='Ganti tema terang/gelap').click()
                assert page.evaluate('document.documentElement.dataset.theme') == 'dark'
                page.reload(wait_until='networkidle');check_content(page)
                assert page.evaluate('document.documentElement.dataset.theme') == 'dark', 'theme must persist after reload'
                assert page.evaluate('localStorage.getItem("paygate_theme")') == 'dark'
                page.get_by_role('button', name='Ganti tema terang/gelap').click()
                assert page.evaluate('document.documentElement.dataset.theme') == 'light'
                page.evaluate('localStorage.removeItem("paygate_theme")')
                page.get_by_label('Username', exact=True).fill('ui_smoke')
                page.get_by_label('Password', exact=True).fill('Ui-test-password-123!')
                page.get_by_role('button', name='Masuk', exact=True).click()
                page.wait_for_url(url + '/dashboard')
                expect(page.locator('#statCards .stat')).to_have_count(4)
                expect(page.locator('#statCards .skeleton')).to_have_count(0)
                check_layout(page)
                # Wait for actual CSS animations to finish before judging visual contrast.
                page.evaluate('() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))')
                page.screenshot(path=str(ARTIFACTS / 'desktop-dashboard.png'), full_page=True)

                visit('/orders')
                expect(page.locator('#orderRows')).not_to_contain_text('Memuat')
                expect(page.locator('[data-action="open-create"]')).to_be_disabled()
                assert not any('simulate-payment' in req.url for req in posts)
                # CSRF rejection uses browser context cookies, but no page console noise.
                bad = context.request.post(url + '/api/orders/create', data={'amount': 1, 'provider': 'gopay'}, max_redirects=0)
                assert bad.status == 403, bad.text()
                csrf = next(c['value'] for c in context.cookies() if c['name'] == 'paygate_csrf')
                unsupported = context.request.post(url + '/api/orders/create', headers={'X-CSRF-Token': csrf}, data={'amount': 1, 'provider': 'gopay'}, max_redirects=0)
                assert unsupported.status == 503, unsupported.text()

                page.set_viewport_size({'width': 1280, 'height': 900})
                visit('/accounts')
                expect(page.locator('#providerCards')).to_be_visible()
                assert page.locator('[data-action="gopay-login"]').count()==0
                expect(page.locator('#providerCards')).to_contain_text('Koneksi hanya dapat dikelola pemilik instalasi.')
                page.get_by_text('Cara kerja dan batas penggunaan', exact=True).click()
                expect(page.get_by_role('region', name='Cara kerja', exact=True).locator('.setup-steps')).to_contain_text('Simpan & aktifkan')
                page.locator('.official-guide > summary').click()
                for name in ['Daftar integrasi GoBiz', 'Panduan onboarding ShopeePay', 'Daftar Midtrans']:
                    expect(page.get_by_role('link', name=name, exact=True)).to_be_visible()
                visit('/transactions')
                expect(page.locator('#txRows')).to_contain_text('Belum ada transaksi')
                expect(page.locator('[data-action="poll-now"]')).to_have_count(0)
                page.get_by_text('Pembayaran belum cocok dengan tagihan mana pun', exact=True).click()
                expect(page.locator('.setup-guide')).to_contain_text('tidak terhubung ke tagihan')

                visit('/docs')
                expect(page.locator('.docs-body')).to_contain_text('X-Api-Key')
                expect(page.locator('.docs-body')).to_contain_text('/api/orders/create')
                expect(page.locator('.docs-body')).to_contain_text('legacy_unverified')
                expect(page.locator('.alert-warning')).to_have_count(0)
                with page.expect_download() as download_info:
                    page.get_by_role('link', name='docs/API.md').click()
                assert download_info.value.suggested_filename == 'API.md'

                visit('/api-keys')
                page.get_by_role('button', name='Buat Kunci Baru', exact=True).click()
                expect(page.locator('#newKeyBox')).not_to_be_visible()
                page.get_by_label('Nama kunci', exact=True).fill('smoke')
                page.get_by_role('button', name='Buat Kunci', exact=True).click()
                expect(page.locator('#newKeyValue')).to_contain_text('pgk_')
                old_key = page.locator('#newKeyValue').inner_text()
                page.keyboard.press('Escape')
                page.once('dialog', lambda dialog: dialog.accept())
                page.get_by_role('button', name='Ganti Kunci', exact=True).click()
                expect(page.locator('#newKeyValue')).not_to_have_text(old_key)
                page.keyboard.press('Escape')
                page.once('dialog', lambda dialog: dialog.accept())
                page.get_by_role('button', name='Cabut', exact=True).click()
                expect(page.locator('#keyRows')).to_contain_text('Dicabut')

                visit('/settings')
                expect(page.locator('#setTtl')).to_have_value('7')
                assert page.locator('#setProvider').get_attribute('readonly') is not None
                for field in ['setPoll', 'setTolerance', 'setTtl']:
                    assert page.locator('#' + field).get_attribute('readonly') is not None
                page.locator('#accentColor').fill('#2563eb')
                assert page.evaluate('localStorage.getItem("paygate_accent")') == '#2563eb'
                assert page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()') == '#2563eb'
                visit('/docs')
                assert page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()') == '#2563eb'
                visit('/settings')
                expect(page.locator('#accentColorValue')).to_have_text('#2563EB')
                page.get_by_role('button', name='Kembalikan', exact=True).click()
                assert page.evaluate('localStorage.getItem("paygate_accent")') is None
                assert page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()') == '#059669'
                for accent, contrast in [('#ffffff', '#0b1220'), ('#000000', '#ffffff')]:
                    page.locator('#accentColor').fill(accent)
                    assert page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--primary-contrast").trim()') == contrast
                page.get_by_role('button', name='Kembalikan', exact=True).click()
                page.get_by_label('Password sekarang', exact=True).fill('Ui-test-password-123!')
                page.get_by_label('Password baru', exact=True).fill('Ui-new-password-456!')
                page.get_by_label('Ulangi password baru', exact=True).fill('Ui-new-password-456!')
                with page.expect_response(lambda r: r.url.endswith('/change-password') and r.request.method == 'POST') as changed:
                    page.get_by_role('button', name='Simpan Password', exact=True).click()
                assert changed.value.status == 200
                expect(page.locator('#pwNew')).to_have_value('')

                for theme in ['dark', 'light']:
                    if page.evaluate('document.documentElement.dataset.theme') != theme:
                        page.get_by_role('button', name='Ganti tema terang/gelap').click()
                    for width in [1280, 768, 390, 320]:
                        page.set_viewport_size({'width': width, 'height': 844})
                        for route in ['/dashboard', '/orders', '/accounts', '/api-keys', '/transactions', '/income', '/docs', '/tos', '/settings']:
                            visit(route)
                            expect(page.locator('html')).to_have_attribute('data-theme', theme)
                            expect(page.get_by_role('button', name='Ganti tema terang/gelap')).to_have_attribute('aria-pressed', str(theme == 'dark').lower())
                            if route == '/tos' or (route in ['/dashboard', '/docs', '/accounts'] and width in [1280, 320]):
                                page.screenshot(path=str(ARTIFACTS / f'{route[1:]}-{theme}-{width}.png'), full_page=True)
                page.screenshot(path=str(ARTIFACTS / 'mobile-settings.png'), full_page=True)
                page.get_by_role('button', name='Menu', exact=True).click()
                expect(page.locator('.burger')).to_have_attribute('aria-expanded', 'true')
                expect(page.locator('#sidebarScrim')).to_be_visible()
                expect(page.locator('main')).to_have_attribute('inert', '')
                assert page.evaluate('document.activeElement?.outerHTML') and page.evaluate('document.activeElement.matches(".sidebar .nav-item.active")'), page.evaluate('document.activeElement?.outerHTML')
                page.locator('#sidebarScrim').click(position={'x': 310, 'y': 20})
                expect(page.locator('.burger')).to_have_attribute('aria-expanded', 'false')
                expect(page.locator('#sidebar')).not_to_have_class(re.compile(r'\bopen\b'))
                expect(page.get_by_role('button', name='Menu', exact=True)).to_be_focused()
                page.get_by_role('button', name='Menu', exact=True).click()
                expect(page.locator('.burger')).to_have_attribute('aria-expanded', 'true')
                page.keyboard.press('Escape')
                expect(page.locator('.burger')).to_have_attribute('aria-expanded', 'false')
                expect(page.get_by_role('button', name='Menu', exact=True)).to_be_focused()
                page.get_by_role('button', name='Menu', exact=True).click()
                page.locator('.sidebar').get_by_role('link', name='Tagihan', exact=True).click()
                page.wait_for_url(url + '/orders')
                expect(page.locator('.burger')).to_have_attribute('aria-expanded', 'false')
                page.set_viewport_size({'width': 1280, 'height': 900})
                visit('/settings')
                page.once('dialog', lambda dialog: dialog.accept())
                page.get_by_role('button', name='Keluar dari Semua Perangkat').click()
                page.wait_for_url(url + '/login')
                page.get_by_label('Username', exact=True).fill('ui_smoke')
                page.get_by_label('Password', exact=True).fill('Ui-new-password-456!')
                page.get_by_role('button', name='Masuk', exact=True).click()
                page.wait_for_url(url + '/dashboard')
                assert errors == [], errors
                assert not forbidden, ('Nonlocal/provider mutation blocked', forbidden)
                assert page.evaluate('window.cspViolations') == []
                lab_result = lab_ui_checks(browser, url, app)
                browser.close()

            with sqlite3.connect(app / 'isolated.db') as db:
                assert db.execute('SELECT count(*) FROM payment_accounts').fetchone()[0] == 0
                assert db.execute('SELECT count(*) FROM orders').fetchone()[0] == 0
                assert db.execute('SELECT count(*) FROM seen_transactions WHERE consumed_by IS NOT NULL').fetchone()[0] == 0
            log.flush();log.seek(0)
            assert 'UI_TEST_UPSTREAM_FORBIDDEN' not in log.read(), 'Unexpected server upstream attempt blocked'
            screenshots = sorted(ARTIFACTS.glob('*.png'))
            assert screenshots and all(p.stat().st_size > 1000 and p.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n' for p in screenshots)
            (ARTIFACTS / 'legal-geometry.json').write_text(json.dumps(geometry, indent=2))
            (ARTIFACTS / 'source-sha256.json').write_text(json.dumps({str(p.relative_to(app)): hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['src','views','public'] for p in sorted((app / folder).rglob('*')) if p.is_file()}, indent=2))
            print(json.dumps({'ok': True, 'legal_browser_real_http': True, 'legal_dialog_geometry': geometry, 'asset_version': ASSET_VERSION, 'screenshot_count': len(screenshots), 'upstream_requests': 0, 'browser': 'Chromium', 'isolated_port': port, 'checks': ['login', 'theme toggle + persist', '8 authenticated pages under CSP + terms first visit/decline/required/accept/reload', 'docs page + download', 'disconnected order gate', 'zero payment writes', 'reject missing CSRF + unsupported provider', 'named dialogs + Tab + Escape + focus return', 'keys generate/regenerate/revoke', 'read-only runtime config', 'password update + logout + re-login', '320px + 390px mobile'], 'console_errors': errors, 'lab_ui': lab_result, 'screenshots': str(ARTIFACTS)}))
        except Exception:
            print(json.dumps({'ok':False,'screenshots':str(ARTIFACTS)}))
            raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
