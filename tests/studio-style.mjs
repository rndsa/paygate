// Standalone CSS/render checks. No server, DB, credentials or provider requests.
// Run: node tests/studio-style.mjs
// Requires Python Playwright; override STUDIO_PYTHON / CHROMIUM_PATH if needed.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ejs from 'ejs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const css = read('public/css/app.css');
// Studio2 visual contract: glass surfaces, tinted mesh and layered depth are allowed.
// Remote resources and the legacy --glow token stay banned; contrast/geometry checks below are unchanged.
assert.doesNotMatch(css, /--glow:/);
assert.doesNotMatch(css, /url\(\s*['"]?(?:https?:|\/\/)/i);
assert.doesNotMatch(css, /@import/i);
assert.match(css, /--primary:\s*#059669;/);
assert.match(css, /\.consent-dialog\s*\{[^}]*max-width:\s*480px/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
const locals = {config:{labUnofficialEnabled:true,labUserId:7}, user:{id:7,username:'style_test',role:'admin'}, active:'dashboard',title:'Dashboard',body:'',error:null,next:'/',csrfToken:'style-test-only',loginInert:false,declined:false,version:'style-only',licenseText:read('LICENSE')};
const render = (name, extra = {}) => ejs.render(read(name), {...locals,...extra}, {filename:path.join(root,name)});
const pages = {};
for (const name of ['dashboard','accounts','orders','transactions','apikeys','settings','docs','tos','console']) {
  const view = `views/pages/${name}.ejs`;
  if (existsSync(path.join(root,view))) pages[name] = render('views/layout.ejs',{active:name,title:name,body:render(view)});
}
for (const name of ['login','terms','terms-detail','license']) pages[name]=render(`views/${name}.ejs`);
// Only CSS and real theme.js are evaluated. All application scripts are excluded.
for (const name in pages) pages[name]=pages[name].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
const py = String.raw`
import json, os, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
p=json.load(sys.stdin)
artifacts=Path(tempfile.mkdtemp(prefix='paygate-studio-style-'))
checked=0
forbidden=[]
contrast_checks=0
with sync_playwright() as pw:
    cached=sorted(Path('/root/.cache/ms-playwright').glob('chromium-*/chrome-linux64/chrome'))
    executable=os.environ.get('CHROMIUM_PATH') or (str(cached[-1]) if cached else None)
    browser=pw.chromium.launch(headless=True,executable_path=executable,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1280,'height':844},reduced_motion='reduce',service_workers='block')
    def block(route):
        forbidden.append(route.request.url)
        route.abort()
    context.route('**/*',block)
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    for name,html in p['pages'].items():
        page.goto('about:blank')
        page.set_content(html)
        page.add_style_tag(content=p['css'])
        page.add_script_tag(content=p['theme'])
        if name=='console':
            page.evaluate("""() => {
              const list=document.querySelector('#consoleList');
              const row=document.createElement('li'); row.className='console-entry';
              const meta=document.createElement('div'); meta.className='console-entry-meta';
              for(const [tag,cls,text] of [['time','console-time','09 Sep 2026, 15.00'],['span','console-level console-level-error','Error'],['span','console-module','GoPay']]){const el=document.createElement(tag);el.className=cls;el.textContent=text;meta.append(el)}
              const content=document.createElement('div');content.className='console-entry-content';
              const summary=document.createElement('p');summary.className='console-summary';summary.textContent='Style-only example: provider request failed.';
              const event=document.createElement('span');event.className='console-event';event.textContent='#1 · GOPAY_LOGIN_START';content.append(summary,event);
              const detail=document.createElement('button');detail.className='console-button console-detail-button';detail.textContent='Detail';
              row.append(meta,content,detail);list.append(row);document.querySelector('#consoleStatus').hidden=true;
              const field=document.createElement('div');field.className='console-detail-field';
              const dt=document.createElement('dt');dt.className='console-detail-label';dt.textContent='Request ID';
              const dd=document.createElement('dd');dd.className='console-detail-value';dd.textContent='11111111-2222-3333-4444-555555555555';field.append(dt,dd);document.querySelector('#consoleDetailFields').append(field);
            }""")
        for theme in ['light','dark']:
            page.evaluate('(t)=>applyTheme(t)',theme)
            for width in [320,390,768,1280]:
                page.set_viewport_size({'width':width,'height':844})
                overflow=page.evaluate('document.documentElement.scrollWidth-innerWidth')
                assert overflow<=0,(name,theme,width,'overflow',overflow)
                assert page.locator('.card-header h2').evaluate_all('els=>els.every(el=>parseFloat(getComputedStyle(el).fontSize)<=18)')
                if name=='terms':
                    data=page.locator('.consent-dialog').evaluate('el=>{let r=el.getBoundingClientRect();return {width:r.width,height:r.height,scroll:el.scrollHeight-el.clientHeight}}')
                    assert data['width']<=480 and data['height']<600 and data['scroll']<=0,(theme,width,data)
                if name=='console':
                    bad=page.locator(".console-select,.console-input,.console-button").evaluate_all("els=>els.filter(e=>!e.closest('dialog')&&!e.hidden&&e.offsetParent!==null).map(el=>({id:el.id,left:Math.round(el.getBoundingClientRect().left),right:Math.round(el.getBoundingClientRect().right),w:Math.round(el.getBoundingClientRect().width)})).filter(r=>r.left<0||r.right>innerWidth||r.w<=0)")
                    assert not bad,(bad,theme,width)
                if width in [320,1280] and name in ['dashboard','accounts','login','console','terms']:
                    page.screenshot(path=str(artifacts/f'{name}-{theme}-{width}.png'),full_page=True)
                checked+=1
            for selector in ['#gpLoginDialog','#spLoginDialog','#consoleDetailDialog']:
                if page.locator(selector).count():
                    page.set_viewport_size({'width':320,'height':844})
                    page.locator(selector).evaluate('el=>el.showModal()')
                    assert page.locator(selector).evaluate('el=>{const r=el.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&el.scrollWidth<=el.clientWidth&&getComputedStyle(el).opacity==="1"}'),(name,theme,selector)
                    page.screenshot(path=str(artifacts/f'{name}-{theme}-{selector[1:]}-320.png'))
                    page.locator(selector).evaluate('el=>el.close()')
    # Compute real colors, composited against current surfaces, including hover.
    page.goto('about:blank'); page.set_content('<main><button class="btn btn-primary">Primary</button><button class="btn btn-success">Success</button><button class="btn btn-danger">Danger</button><span class="badge badge-success">Success</span><span class="badge badge-danger">Error</span><span class="badge badge-warning">Warning</span><span class="badge badge-info">Info</span><p class="muted">Caption</p></main>')
    page.add_style_tag(content=p['css']);page.add_script_tag(content=p['theme'])
    contrast_js="""el => {
      const rgba = s => {const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d');c.fillStyle=s;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v)};
      const over=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));
      let bg=[255,255,255];const chain=[];for(let n=el;n;n=n.parentElement)chain.unshift(n);
      for(const n of chain)bg=over(rgba(getComputedStyle(n).backgroundColor),bg);
      const fg=over(rgba(getComputedStyle(el).color),bg);
      const lum=a=>a.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    }"""
    for theme in ['light','dark']:
        page.evaluate('(t)=>applyTheme(t)',theme)
        for accent in ['#059669','#2563eb','#ea580c','#ffffff','#000000']:
            page.evaluate('(a)=>applyAccent(a)',accent)
            for selector in ['.btn-primary','.btn-success','.btn-danger','.badge-success','.badge-danger','.badge-warning','.badge-info','.muted']:
                for hover in [False,True]:
                    if hover:page.locator(selector).hover()
                    else:page.mouse.move(0,0)
                    ratio=page.locator(selector).evaluate(contrast_js)
                    assert ratio>=4.5,(theme,accent,selector,hover,ratio)
                    assert page.locator(selector).evaluate('el=>getComputedStyle(el).transform==="none"')
                    contrast_checks+=1
    # No-JS fallback: default emerald uses dark text; consent always dark green/white.
    page.goto('about:blank');page.set_content('<button class="btn btn-primary">Primary</button><div class="consent-dialog"><button class="btn btn-primary">Consent</button></div>');page.add_style_tag(content=p['css'])
    for selector in ['body > .btn-primary','.consent-dialog .btn-primary']:
        ratio=page.locator(selector).evaluate(contrast_js);assert ratio>=4.5,(selector,ratio);contrast_checks+=1
    assert not errors,errors
    assert not forbidden,forbidden
    browser.close()
print(json.dumps({'ok':True,'render_cases':checked,'contrast_checks':contrast_checks,'viewports':[320,390,768,1280],'themes':['light','dark'],'network_requests':len(forbidden),'browser_errors':errors,'artifacts':str(artifacts),'scope':'static real-template CSS checks; synthetic Console example; no API/provider behavior'}))
`;
const python = process.env.STUDIO_PYTHON || (existsSync('/root/camofox-venv/bin/python') ? '/root/camofox-venv/bin/python' : 'python3');
const result = spawnSync(python,['-c',py],{input:JSON.stringify({css,theme:read('public/js/theme.js'),pages}),encoding:'utf8',maxBuffer:10*1024*1024,timeout:180000});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
assert.equal(result.status,0,'Studio static browser style checks failed');
