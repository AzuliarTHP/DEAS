"""H3 Join: real Chromium/Workbench, strict synthetic native jobs, no backend/GPU.

Run: uv run --no-project --with playwright==1.64.1 python tools/verify_h3_transitions.py
Owns only the isolated Vite/browser children from verify_postprocessing.
"""
import json
from pathlib import Path

from playwright.sync_api import expect
import verify_continuity as continuity
import verify_postprocessing as runner

ROOT = Path(__file__).resolve().parents[1]
LOCALES = ('en', 'de', 'fr', 'ja', 'ru', 'tr', 'zh')
FINDINGS = []
FIXTURE = continuity.INIT.replace(
    'window.__calls.push({command,args});',
    'window.__calls.push({command,args:structuredClone(args)});',
) + r"""
localStorage.setItem('deas.pref.studio.run.pipeline',JSON.stringify('t2i'));
localStorage.setItem('deas.pref.interface.experience',JSON.stringify('advanced'));
localStorage.setItem('deas.pref.studio.run.continuity',JSON.stringify({enabled:false,session:'join-fixture',outputMode:'segment',steps:[]}));
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.__h3={jobs:[],allowed:[],preflights:[],inspections:0,release:0};
const h=window.__h3, originalInvoke=window.__TAURI_INTERNALS__.invoke;
const clone=x=>structuredClone(x);
const fail=message=>{__unexpected.push(message);throw Error(message);};
const keys=(args,expected)=>{if(Object.keys(args).sort().join(',')!==expected)fail('Unexpected argument keys '+JSON.stringify(args));};
const snapshot=()=>clone({jobs:h.jobs,preparing:0,capacity:20,stopAvailable:true,stopping:false,admissionEpoch:7});
const reads=['native_spellcheck_check','plugin:event|listen','plugin:event|unlisten','native_workbench_current','native_workbench_poll','native_llm_read','native_wildcard_library','native_audio_enhance_capabilities','native_audio_enhance_install_status','native_media_thumbnail','native_media_star_status','native_media_star_notice','native_media_list','native_recipe_prerequisites','native_h3_session','native_models_scan'];
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 if(!reads.includes(command)&&!h.allowed.includes(command))return fail('IPC outside phase allowlist '+command);
 const own=['native_logs_continuity_join_notice','native_spellcheck_check','native_audio_enhance_install_status','native_recipe_prerequisites','native_workbench_current','native_workbench_poll','native_video_post_inspect','native_video_post_upload','native_workbench_run','native_workbench_cancel_pending','native_workbench_interrupt_running'];
 if(!own.includes(command))return originalInvoke(command,args);
 __calls.push({command,args:clone(args)});
 if(command==='native_logs_continuity_join_notice'){keys(args,'jobId,reason');if(args.reason!=='cancelled'||args.jobId!==null)return fail('Unexpected join notice '+JSON.stringify(args));return null;}
 if(command==='native_spellcheck_check')return [];
 if(command==='native_audio_enhance_install_status')return {running:false,mode:'',stage:'',downloaded:0,total:0};
 if(command==='native_recipe_prerequisites')return {baseUrl:args.baseUrl,recipeId:'checkpoint-text-to-image-diagnostic',version:1,missingNodes:[],generationReady:false,allowlist:{nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage','UNETLoader'],checkpoints:[],diffusionModels:['MiniMaxH3/h3.safetensors'],loras:[],samplers:['euler','euler_ancestral','euler_cfg_pp','er_sde','dpmpp_2m','dpm_2','res_multistep','uni_pc','lcm'],schedulers:['normal','simple','linear_quadratic','karras','sgm_uniform','beta']}};
 if(command==='native_workbench_current'||command==='native_workbench_poll'){
  keys(args,'');
  if(command==='native_workbench_poll'&&h.runningRace)for(const job of h.jobs)if(job.state==='queued')job.state='running';
  if(command==='native_workbench_poll')for(const job of h.jobs)if(job.state==='queued'&&Number(job.id.split('-')[1])<=h.release){
   job.state='succeeded';
   if(job.intent.recipeId==='h3-join')job.outputs=[{filename:'H3_Joined_fixture.mp4',subfolder:'',type:'output'}];
   else job.transition='h3_transitions/'+job.id+'.mp4';
  }
  return snapshot();
 }
 if(command==='native_video_post_inspect'){
  keys(args,'title');if(!args.title?.trim())return fail('Missing inspection title');
  const n=++h.inspections;
  return {sourceId:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),name:'clip'+n+'.mp4',width:1280,height:720,fpsNumerator:24,fpsDenominator:1,durationSeconds:12,pixelFormat:'yuv420p',fieldOrder:'progressive',colorTransfer:'bt709',audioStreams:1,subtitleStreams:0,blockers:[],timingVerified:false,processingReady:false};
 }
 if(command==='native_video_post_upload'){
  keys(args,'baseUrl,sourceId');if(args.baseUrl!=='http://127.0.0.1:7801'||args.sourceId!=='00000000-0000-4000-8000-'+String(h.inspections).padStart(12,'0'))return fail('Upload source/endpoint mismatch');
  return 'clip'+h.inspections+'.mp4';
 }
 if(command==='native_workbench_run'){
  keys(args,'admissionEpoch,baseUrl,confirmed,intent');
  if(args.confirmed!==true||args.admissionEpoch!==7||args.baseUrl!=='http://127.0.0.1:7801')return fail('Invalid explicit admission');
  if(h.jobs.some(j=>j.state==='queued'||j.state==='running'))return fail('Nonsequential transition submission');
  if(!['video-generation','h3-join'].includes(args.intent.recipeId))return fail('Unexpected recipe');
  const job={id:'join-'+(h.jobs.length+1),baseUrl:args.baseUrl+'/',promptId:'fixture-'+h.jobs.length,intent:clone(args.intent),state:'queued',outputs:[],error:null,generationReady:false};
  h.jobs.push(job);return clone(job);
 }
 keys(args,'confirmed,jobId');
 const job=h.jobs.find(j=>j.id===args.jobId);
 if(!job||args.confirmed!==true||!['queued','running'].includes(job.state))return fail('Invalid scoped cancel');
 if(command==='native_workbench_cancel_pending'&&h.runningRace){job.state='running';return clone(job);}
 job.state='cancelled';return clone(job);
};
"""


def calls(page, command):
    return page.evaluate('(command)=>__calls.filter(c=>c.command===command)', command)


def clean(page, errors):
    assert not errors, errors
    assert page.evaluate('__unexpected') == [], page.evaluate('__unexpected')


def open_join(page, url):
    page.goto(url+'/tools/inpaint-fixture.html', wait_until='networkidle')
    pipeline = page.locator('[data-pipeline]')
    expect(pipeline.locator('option[value="video"]')).to_be_enabled()
    pipeline.select_option('video')
    page.locator('#run-positive').fill('Captured Workbench camera movement')
    page.locator('[data-continuity-open]').click()
    dialog = page.locator('dialog.continuity-overlay')
    expect(dialog).to_be_visible()
    assert dialog.evaluate('d=>d.matches(":modal")')
    enabled = dialog.locator('[data-cont-enabled]')
    expect(enabled).not_to_be_checked()
    enabled.check()
    dialog.locator('[data-cont-join-mode]').select_option('files')
    expect(dialog.locator('[data-cont-join-transition]')).not_to_be_checked()
    expect(dialog.locator('[data-cont-join-context]')).to_have_value('22')
    expect(dialog.locator('[data-cont-join-length]')).to_have_value('29')
    for selector in ('context', 'length', 'description'):
        expect(dialog.locator('[data-cont-join-'+selector+']')).to_be_disabled()
    assert calls(page, 'native_workbench_run') == []
    return dialog


def add_files(page, count=3):
    page.evaluate("__h3.allowed=['native_video_post_inspect','native_video_post_upload']")
    for n in range(count):
        page.locator('[data-cont-join-add]').click()
        expect(page.locator('[data-cont-join-file]')).to_have_count(n+1)
    assert len(calls(page, 'native_video_post_inspect')) == count
    assert len(calls(page, 'native_video_post_upload')) == count
    assert calls(page, 'native_workbench_run') == []


def preflight(page):
    page.locator('[data-cont-join-preflight]').click()
    expect(page.locator('[data-cont-join-preflight-result]')).to_contain_text('re-encode')
    expect(page.locator('[data-cont-join-run]')).to_be_enabled()
    body = page.evaluate('__h3.preflights.at(-1)')
    assert body == {'version':1,'rows':[
        {'kind':'media','filename':'clip1.mp4','trim_start':2,'trim_end':10},
        {'kind':'media','filename':'clip2.mp4','trim_start':0,'trim_end':None},
        {'kind':'media','filename':'clip3.mp4','trim_start':0,'trim_end':None},
    ],'repair_transitions':False,'audio_policy':'preserve','copy_video':False}, body


def geometry(page, locale, width, shots):
    dialog = page.locator('dialog.continuity-overlay')
    data = dialog.evaluate('''d=>{
      const b=d.getBoundingClientRect(),body=d.querySelector('.continuity-overlay-body');
      return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,
       overflow:d.scrollWidth-d.clientWidth,bodyOverflow:body.scrollWidth-body.clientWidth,
       controls:[...d.querySelectorAll('input,select,textarea,button')].filter(e=>e.getClientRects().length).map(e=>{
        const r=e.getBoundingClientRect();return {tag:e.tagName,left:r.left,right:r.right,width:r.width};})};
    }''')
    problems = []
    if data['left'] < 0 or data['right'] > width+1 or data['top'] < 0 or data['bottom'] > page.viewport_size['height']+1:
        problems.append('dialog escapes viewport')
    if data['overflow'] > 1 or data['bodyOverflow'] > 1:
        problems.append('horizontal dialog scrollbar')
    for control in data['controls']:
        if control['width'] <= 0 or control['left'] < data['left']-1 or control['right'] > data['right']+1:
            problems.append('control outside dialog: '+str(control))
    for selector in ('context','length','description','preflight','run'):
        control = dialog.locator('[data-cont-join-'+selector+']')
        control.focus()
        assert control.evaluate('e=>e===document.activeElement'), (locale,width,selector,'keyboard focus unreachable',control.evaluate('e=>({disabled:e.matches(":disabled"),dialog:e.closest("dialog").open,active:document.activeElement?.outerHTML,preflight:document.querySelector("[data-cont-join-preflight-result]")?.textContent})'))
        control.scroll_into_view_if_needed()
        rect = control.bounding_box()
        assert rect and rect['y'] >= 0 and rect['y'] < page.viewport_size['height'], (locale,width,selector,rect)
    dialog.locator('[data-cont-join-transition]').scroll_into_view_if_needed()
    shot = shots/f'h3-join-{locale}-{width}.png'
    page.screenshot(path=str(shot))
    if problems:
        finding = {'locale':locale,'width':width,'problems':problems,'geometry':data,'screenshot':str(shot)}
        FINDINGS.append(finding)
        print('PRODUCT_BUG '+json.dumps(finding), flush=True)
    return data


async_search = '''async()=>{
 const [{default:React},client,{I18nProvider},{GlobalSearch}]=await Promise.all([
  import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),
  import('/src/i18n/I18nProvider.tsx'),import('/src/components/setup/GlobalSearch.tsx')]);
 const host=document.createElement('div');document.body.prepend(host);
 client.default.createRoot(host).render(React.createElement(I18nProvider,null,React.createElement(GlobalSearch,{onNavigate:entry=>{window.__searchEntry=entry;}})));
}'''


def search_navigation(page, dialog):
    # Mount the actual GlobalSearch beside the fixture's actual Workbench, not a fake search UI.
    page.evaluate(async_search)
    for query, target, disabled in (
        ('Generate an H3 transition', 'transition', False),
        ('Context per side (frames)', 'context', True),
        ('Transition length (frames)', 'length', True),
        ('Transition description', 'description', True),
    ):
        if dialog.count():
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)
        page.keyboard.press('Control+k')
        search = page.locator('#global-search-panel input')
        search.fill(query)
        page.locator('.search-results button').filter(has_text=query).first.click()
        expect(dialog).to_be_visible()
        expect(dialog.locator('[data-cont-join-mode]')).to_have_value('files')
        expect(dialog.locator('[data-cont-join-transition]')).not_to_be_checked()
        control = dialog.locator('[data-cont-join-'+target+']')
        if disabled:
            expect(control).to_be_disabled()
        else:
            expect(control).to_be_focused()
        assert calls(page, 'native_workbench_run') == []
        assert calls(page, 'native_video_post_upload') == []
    page.keyboard.press('Escape')
    expect(dialog).to_have_count(0)
    page.locator('[data-continuity-open]').click()
    dialog.locator('[data-cont-join-mode]').select_option('files')


def verify(browser, url, shots):
    checks = []
    for locale in LOCALES:
        context = browser.new_context(viewport={'width':1440,'height':960}, reduced_motion='reduce')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(FIXTURE.replace('LOCALE', json.dumps(locale)))
        def route_preflight(route):
            assert route.request.method == 'POST', route.request.method
            body = route.request.post_data_json
            page.evaluate('body=>__h3.preflights.push(body)', body)
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok':True,'issues':[],'seconds':32,'mode':'re-encode'}), headers={'access-control-allow-origin':'*'})
        # No request to a real backend is permitted; only this explicit synthetic route exists.
        context.route('http://127.0.0.1:7801/**', lambda route: route.abort())
        context.route('http://127.0.0.1:7801/df_h3_continuity/assembly/preflight', route_preflight)
        try:
            dialog = open_join(page, url)
            if locale == 'en':
                search_navigation(page, dialog)
            toggle = dialog.locator('[data-cont-join-transition]')
            toggle.check()
            assert calls(page, 'native_workbench_run') == []
            translations = json.loads((ROOT/'src/features/studio/locales'/f'{locale}.json').read_text(encoding='utf-8'))
            for selector, key in (('mode','mode'),('add','addVideo'),('preflight','preflight'),('run','run')):
                control = dialog.locator('[data-cont-join-'+selector+']')
                label = translations['studio.run.cont.join.'+key]
                expect(dialog.get_by_role('combobox' if selector=='mode' else 'button', name=label, exact=True)).to_have_count(1)
                assert control.count() == 1
            for suffix, role in (('transitions','checkbox'),('context','spinbutton'),('length','spinbutton'),('description','textbox')):
                label = translations['studio.run.cont.join.'+suffix]
                expect(dialog.get_by_role(role, name=label, exact=True)).to_be_visible()
            add_files(page)
            page.locator('[data-cont-join-trim-start="clip1.mp4"]').fill('2')
            page.locator('[data-cont-join-trim-end="clip1.mp4"]').fill('10')
            page.locator('[data-cont-join-description]').fill('  smooth camera bridge  ')
            preflight(page)
            assert calls(page, 'native_workbench_run') == []
            for width, height in ((1440,960),(390,844),(320,480)):
                page.set_viewport_size({'width':width,'height':height})
                geometry(page, locale, width, shots)
                checks.append(f'{locale} {width}px labels, accessible fields, bounds and keyboard reachability')
            page.set_viewport_size({'width':1440,'height':960})
            page.evaluate("__h3.allowed=['native_workbench_run','native_workbench_cancel_pending','native_workbench_interrupt_running','native_logs_continuity_join_notice']")
            page.locator('[data-cont-join-run]').click()
            page.wait_for_function('__h3.jobs.length===1')
            first = calls(page, 'native_workbench_run')[0]
            intent = first['args']['intent']
            assert intent['family'] == 'minimax-h3' and intent['model'] == 'MiniMaxH3/h3.safetensors', intent
            assert intent['positivePrompt'] == 'Captured Workbench camera movement', intent
            assert intent['textEncoder'] == 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', intent
            assert intent['vae'] == 'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors', intent
            assert intent['h3']['audioVae'] == 'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors', intent
            assert intent['h3']['transition'] == {'files':[{'filename':'clip1.mp4','trimStart':2,'trimEnd':10},{'filename':'clip2.mp4'}],'contextFrames':22,'transitionFrames':29,'prompt':'smooth camera bridge'}, intent
            assert 'continuity' not in intent['h3']
            for selector in ('[data-cont-enabled]','[data-cont-join-context]','[data-cont-join-length]','[data-cont-join-description]','[data-cont-join-add]'):
                expect(dialog.locator(selector)).to_be_disabled()
            close = dialog.locator('header button')
            dialog.evaluate('d=>{window.__cancelEvents=[];d.addEventListener("cancel",e=>queueMicrotask(()=>__cancelEvents.push({cancelable:e.cancelable,prevented:e.defaultPrevented,open:d.open})));}')
            for width, height in ((1440,960),(390,844),(320,480)):
                page.set_viewport_size({'width':width,'height':height})
                expect(close).to_be_disabled()
                cancel = dialog.locator('[data-cont-join-cancel]')
                expect(cancel).to_be_enabled()
                cancel.focus()
                expect(cancel).to_be_focused()
                cancel.scroll_into_view_if_needed()
                assert cancel.evaluate('e=>{const r=e.getBoundingClientRect(),d=e.closest("dialog").getBoundingClientRect();return r.left>=d.left&&r.right<=d.right&&r.top>=d.top&&r.bottom<=d.bottom;}'), (locale,width,'Cancel unreachable')
                page.keyboard.press('Escape')
                print('BUSY_ESCAPE '+json.dumps({'locale':locale,'width':width,'events':page.evaluate('__cancelEvents'),'open':dialog.evaluate('d=>d.open')}), flush=True)
                if not dialog.evaluate('d=>d.open'):
                    shot = shots/f'busy-escape-{locale}-{width}.png'
                    page.screenshot(path=str(shot))
                    finding = {'locale':locale,'width':width,'problem':'Repeated Escape closes busy native dialog; final cancel event non-cancelable','events':page.evaluate('__cancelEvents'),'screenshot':str(shot)}
                    FINDINGS.append(finding)
                    print('PRODUCT_BUG '+json.dumps(finding), flush=True)
                    # Restore only to finish independent fixture checks; this remains a failing product finding.
                    dialog.evaluate('d=>d.showModal()')
                else:
                    checks.append(f'{locale} {width}px busy Close/Escape locked; Cancel reachable')
            page.set_viewport_size({'width':1440,'height':960})
            assert len(calls(page, 'native_workbench_run')) == 1
            assert calls(page, 'native_workbench_run')[0] == first
            if locale == 'en':
                page.evaluate('__h3.release=1')
                page.wait_for_function('__h3.jobs.length===2')
                expect(dialog.locator('[data-cont-join-bridges]')).to_contain_text('h3_transitions/join-1.mp4')
                second = calls(page, 'native_workbench_run')[1]['args']['intent']
                expected = dict(intent)
                expected['h3'] = dict(intent['h3'], transition=dict(intent['h3']['transition'], files=[{'filename':'clip2.mp4'},{'filename':'clip3.mp4'}]))
                assert second == expected, (second, expected)
                page.evaluate('__h3.release=2')
                page.wait_for_function('__h3.jobs.length===3')
                joined = calls(page, 'native_workbench_run')[2]['args']['intent']
                assert joined == {'recipeId':'h3-join','version':1,'h3':{'join':{'kind':'files','files':[{'filename':'clip1.mp4','trimStart':2,'trimEnd':10},{'filename':'h3_transitions/join-1.mp4'},{'filename':'clip2.mp4'},{'filename':'h3_transitions/join-2.mp4'},{'filename':'clip3.mp4'}]}}}, joined
                page.evaluate('__h3.release=3')
                expect(dialog.locator('[data-cont-join-result]')).to_contain_text('H3_Joined_fixture.mp4')
                checks.append('sequential two bridges then exact interleaved Join; captured real Workbench intent immutable')
                # Retry explicitly, retain one bridge, cancel the next scoped job: never assemble partial success.
                page.locator('[data-cont-join-run]').click()
                page.wait_for_function('__h3.jobs.length===4')
                page.evaluate('__h3.release=4')
                page.wait_for_function('__h3.jobs.length===5')
            if locale == 'de':
                page.evaluate('__h3.runningRace=true')
                page.wait_for_function('__h3.jobs.at(-1).state==="running"')
            page.locator('[data-cont-join-cancel]').click()
            expect(dialog.locator('[data-cont-join-cancel]')).to_have_count(0)
            expect(close).to_be_enabled()
            submitted = len(calls(page, 'native_workbench_run'))
            assert len(calls(page, 'native_workbench_cancel_pending')) == 1
            assert calls(page, 'native_workbench_cancel_pending')[0]['args'] == {'jobId':f'join-{submitted}','confirmed':True}
            if locale == 'de':
                assert calls(page, 'native_workbench_interrupt_running') == [{'command':'native_workbench_interrupt_running','args':{'jobId':f'join-{submitted}','confirmed':True}}]
                checks.append('queued-to-running reconciliation: pending delete returns running, exact-ID interrupt cancels; no global Stop')
            else:
                assert calls(page, 'native_workbench_interrupt_running') == []
            page.wait_for_timeout(650)
            assert len(calls(page, 'native_workbench_run')) == submitted
            expect(dialog.locator('[data-cont-join-result]')).to_have_count(0)
            if locale == 'en':
                expect(dialog.locator('[data-cont-join-bridges]')).to_contain_text('h3_transitions/join-4.mp4')
            clean(page, errors)
            assert calls(page, 'native_logs_continuity_join_notice') == [{'command':'native_logs_continuity_join_notice','args':{'reason':'cancelled','jobId':None}}]
            evidence = {'locale':locale,'calls':page.evaluate('__calls'),'preflights':page.evaluate('__h3.preflights'),'jobs':page.evaluate('__h3.jobs')}
            (shots/f'ipc-{locale}.json').write_text(json.dumps(evidence,indent=2)+'\n', encoding='utf-8')
            checks.append(f'{locale} explicit enable/upload/preflight; locked Escape/Close; scoped Cancel, no later submit')
            page.keyboard.press('Escape')
            expect(dialog).to_have_count(0)
        except Exception:
            page.screenshot(path=str(shots/f'failure-{locale}.png'), full_page=True)
            print('FAILURE_STATE '+json.dumps({'locale':locale,'unexpected':page.evaluate('__unexpected'),'errors':errors,'calls':page.evaluate('__calls.slice(-10)')}), flush=True)
            raise
        finally:
            context.close()
    result = {'status':'FAIL' if FINDINGS else 'PASS','checksPassed':len(checks),'checks':checks,'productFindings':FINDINGS,'kind':'real Chromium; actual Workbench and GlobalSearch; simulated Tauri job lifecycle and browser-routed preflight, no native/GPU execution','screenshots':str(shots)}
    (shots/'result.json').write_text(json.dumps(result,indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result,indent=2), flush=True)
    assert not FINDINGS, 'Product geometry findings; see result.json'


if __name__ == '__main__':
    runner.verify = verify
    runner.main()
