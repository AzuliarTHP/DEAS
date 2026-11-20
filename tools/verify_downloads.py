"""Integrated optional-plugin browser rendering. Native IPC uses fixtures, not live provider access."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright
from deas_locale import set_locale
root=Path(__file__).resolve().parents[1]
url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:1420'
results=[]
fixture=r"""window.isTauri=true;window.__DEAS_CALLS__=[];window.__TAURI_INTERNALS__={invoke:async(c,a)=>{window.__DEAS_CALLS__.push(c);if(c==='native_install_defaults')return {storagePath:'/executable-folder/deas-environment',backend:'cpu',hardware:null,warnings:[]};if(c==='native_install_plan')return {id:'fixture-plan',request:a.request,steps:[],warnings:[],unsupportedOptions:[],canExecute:true};if(c==='native_media_list')return {path:'/fixture',parent:null,entries:[],truncated:false};if(c==='native_download_catalog'||c==='native_download_import_catalog')return {version:1,providers:[{id:'fixture',kind:'http',label:'Fixture HTTPS provider',origin:'https://example.invalid',scopes:['index'],anonymousNotice:'Fixture only; no live provider contacted.'},{id:'civitai',kind:'civitai',label:'CivitAI',origin:'https://civitai.com',scopes:['user','model','search'],anonymousNotice:'Fixture CivitAI.'}],entries:[{id:'fixture-lora',label:'Fixture LoRA',providerId:'fixture',scope:'index',locator:'https://example.invalid/a.json',kind:'model',target:'loras',preview:'https://image.civitai.com/fixture.jpeg'},{id:'fixture-workflow',label:'Fixture workflow',providerId:'fixture',scope:'index',locator:'https://example.invalid/w.json',kind:'workflow',target:'workflows'},{id:'fixture-ckpt',label:'Fixture checkpoint',providerId:'fixture',scope:'index',locator:'https://example.invalid/c.json',kind:'model',target:'checkpoints',media:'image',auth:true}]};if(c==='native_download_browse')return a.request.scope==='search'?{resources:[{id:'civitai:1',label:'Found model · v1',kind:'repo',downloadable:false,locator:'1',category:'loras',preview:'https://image.civitai.com/found.jpeg'}],nextCursor:null,warnings:[]}:{resources:[{id:'fixture-file',label:'Fixture data file',kind:'file',url:'https://example.invalid/a.json',downloadable:true,size:23,preview:'https://image.civitai.com/file.jpeg'}],nextCursor:null,warnings:[]};if(c==='native_pick_directory')return '/scratch-fixture';if(c==='native_download_plan')return {id:'fixture-plan',target:'/scratch-fixture/new-files',resources:a.request.resources,totalKnownBytes:23,unknownSizeCount:0,warnings:[],canExecute:true};if(c==='native_download_start_queue'){window.__DEAS_STARTED__=1;return {state:'running',completed:0,total:1,bytesDownloaded:0,error:null,jobs:[{id:'fixture-plan',label:'loras',provider:{id:'fixture',kind:'http',label:'Fixture HTTPS provider',origin:'https://example.invalid'},target:'/scratch-fixture/new-files',resources:[{id:'fixture-file',label:'Fixture data file',kind:'file',url:'https://example.invalid/a.json',downloadable:true,size:23}],state:'running',completed:0,total:1,bytesPlaced:0,totalBytes:23,currentFile:'a.json',error:null}]};}if(c==='native_download_resume'||c==='native_download_clear_queue')return {state:'idle',completed:0,total:0,bytesDownloaded:0,error:null,jobs:[]};if(c==='native_download_status')return window.__DEAS_STARTED__?{state:'succeeded',completed:1,total:1,bytesDownloaded:23,error:null,jobs:[{id:'fixture-plan',label:'loras',provider:{id:'fixture',kind:'http',label:'Fixture HTTPS provider',origin:'https://example.invalid'},target:'/scratch-fixture/new-files',resources:[{id:'fixture-file',label:'Fixture data file',kind:'file',url:'https://example.invalid/a.json',downloadable:true,size:23}],state:'succeeded',completed:1,total:1,bytesPlaced:23,totalBytes:23,currentFile:null,error:null}]}:{state:'idle',completed:0,total:0,bytesDownloaded:0,error:null,jobs:[]};if(c==='native_auth_status')return [{providerId:'huggingface',configured:false,persisted:false}];throw Error('Unexpected fixture command');}};"""
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for width in (1440,1024,768,390,320):
  for native in (False,True):
   page=browser.new_page(viewport={'width':width,'height':960},reduced_motion='reduce')
   errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   if native:page.add_init_script(fixture)
   page.goto(url,wait_until='networkidle')
   welcome=page.locator('.experience-welcome .experience-choice')
   if welcome.count():welcome.nth(1).click()  # first-run choice: advanced (setup with the Library workspace)
   page.locator('.experience-welcome').wait_for(state='detached')
   set_locale(page,'en')
   page.locator('[data-node="settings"]').click()
   page.get_by_role('tab',name='Library',exact=True).click()
   if native:
    page.get_by_role('tab',name='Installed',exact=True).wait_for()
    page.get_by_role('tab',name='Catalog',exact=True).click()
    assert page.get_by_text('Login / API key needed',exact=True).count()==1
    page.get_by_label('Model type',exact=True).select_option('video');assert page.locator('.download-card').count()==0
    page.get_by_label('Model type',exact=True).select_option('all')
    page.get_by_role('tab',name='LoRAs',exact=True).click()
    assert set(page.evaluate("__DEAS_CALLS__.filter(x=>x.startsWith('native_download_'))"))=={'native_download_catalog','native_download_status'}  # dev StrictMode may mount twice; mount reconnects to the persisted queue
    assert page.locator('.download-card .download-preview').count()==1
    page.get_by_role('tab',name='Workflows',exact=True).click();assert page.get_by_role('button',name='Fixture workflow',exact=True).count()==1
    page.get_by_role('tab',name='LoRAs',exact=True).click()
    page.get_by_label('Search catalog & CivitAI',exact=True).fill('found');page.get_by_label('Search catalog & CivitAI',exact=True).press('Enter')
    page.get_by_role('button',name='Found model · v1',exact=True).wait_for()
    assert page.get_by_role('button',name='Fixture LoRA',exact=True).count()==0  # typed text narrows catalog cards
    page.get_by_label('Catalog source',exact=True).select_option('')  # live search results persist; return to the bundled catalog
    page.get_by_role('button',name='Fixture LoRA',exact=True).click()
    page.get_by_label('Fixture data file',exact=True).check()
    assert page.locator('.download-resource img.download-preview').count()==1
    assert page.get_by_text('/executable-folder/deas-environment/ComfyUI/models/loras',exact=True).count()==1
    assert page.get_by_role('button',name='Choose existing parent folder',exact=True).count()==0  # managed env uses the Settings models folder
    assert page.get_by_role('region',name='Selected for download',exact=True).get_by_text('Fixture data file',exact=True).count()==1
    page.get_by_role('button',name='Download all (1)',exact=True).click()
    queue=page.locator('[data-download-queue]')
    queue.wait_for()  # the byte footer is gone: a per-job Queue view opens with its own statistics
    queue.get_by_text('Succeeded',exact=True).wait_for()
    assert queue.get_by_text('23 B',exact=False).count()>=1  # human-readable sizes, not raw bytes
    assert 'native_download_start_queue' in page.evaluate('__DEAS_CALLS__')
    assert 'native_download_plan' in page.evaluate('__DEAS_CALLS__')
    page.get_by_role('tab',name='Catalog',exact=True).click()  # queue view does not hide the catalog
    assert page.get_by_role('button',name='Download all (0)',exact=True).is_disabled()  # downloaded files leave the basket
   else:
    assert page.get_by_text('Browser preview',exact=False).count()>0
    assert page.locator('.download-start-all').count()==0  # browser mode fails closed: no native catalog controls at all
   page.locator('[data-node="settings"]').click()
   page.get_by_label('Token',exact=True).wait_for()
   assert page.get_by_label('Token',exact=True).get_attribute('type')=='password'
   assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
   if native:assert 'native_auth_status' in page.evaluate('__DEAS_CALLS__')
   assert not errors,errors
   if width in (1440,320) and native:page.screenshot(path=str(root/'assets'/f'deas-downloads-fixture-{width}.png'),full_page=True)
   results.append({'width':width,'mode':'native IPC fixture' if native else 'browser fails closed','setupIntegration':True,'noOverflow':True,'noRuntimeErrors':True})
   page.close()
 browser.close()
print(json.dumps(results,indent=2))
