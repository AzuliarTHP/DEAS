"""Desktop gallery acceptance with synthetic previews and mocked IPC; no native app or models."""
import json
from pathlib import Path
from playwright.sync_api import expect
import verify_postprocessing as runner
import verify_workspace_layout as layout

FIXTURE = layout.FIXTURE + r'''
localStorage.setItem('deas.locale.v1','en');
window.__galleryCalls=[];
const galleryInvoke=window.__TAURI_INTERNALS__.invoke;
const titles=['Aurora portrait','Quiet architecture','Analog light','Botanical study','Cinematic depth','Ink and paper','Golden hour','Soft geometry'];
window.__galleryModels=Array.from({length:96},(_,i)=>({category:i<88?'loras':'checkpoints',name:(i%2?'Portraits/Characters/':'Styles/Illustration/')+titles[i%titles.length]+'-'+i+'.safetensors',path:'/fixture/models/'+i+'.safetensors',size:(i+1)*64*1048576,addedAt:1700000000+i,family:i<88?undefined:'sdxl',info:{sha256:'fixture',size:1,fetchedAt:1,civitai:{description:'Fixture version description',modelId:i+1,versionId:i+1,name:titles[i%titles.length],version:'v'+(i%3+1)+'.0',modelType:'LORA',category:'loras',base:i%3?'SDXL 1.0':'Flux.1 D',nsfw:false,trainedWords:['gallery_trigger_'+i,'soft light'],preview:'https://image.civitai.com/gallery-fixture/'+i+'.svg'}}}));
window.__TAURI_INTERNALS__.invoke=async(c,a)=>{
 window.__galleryCalls.push({c,a});
 if(c==='native_models_scan')return structuredClone(window.__galleryModels);
 if(c==='native_model_scan_status')return {id:'',root:'',state:'idle',completed:0,total:0,remaining:0,failed:0};
 if(c==='native_logs_library_error')return;
 return galleryInvoke(c,a);
};
'''


def preview(index):
    colors = ['#648477', '#a98461', '#767da5', '#9c7886', '#728da0', '#b8a77e', '#ac7859', '#668686']
    color = colors[index % len(colors)]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="450" height="600"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="{color}"/><stop offset="1" stop-color="#151b24"/></linearGradient></defs><rect width="450" height="600" fill="url(#g)"/><circle cx="{120+index%4*35}" cy="210" r="125" fill="#ffffff" opacity=".1"/><path d="M0 530 170 245 450 480V600H0Z" fill="#121a25" opacity=".55"/><path d="M0 440 270 320 450 380V600H0Z" fill="{color}" opacity=".6"/><circle cx="310" cy="115" r="28" fill="#f2ddba" opacity=".6"/></svg>'''


def independent_scroll(page, folders_selector, cards_selector):
    folders=page.locator(folders_selector)
    cards=page.locator(cards_selector)
    assert cards.evaluate('(el)=>el.scrollHeight>el.clientHeight+5'), (cards_selector,cards.evaluate('(el)=>{const rows=[];for(let p=el;p;p=p.parentElement)rows.push({tag:p.tagName,cls:p.className,height:p.clientHeight,scroll:p.scrollHeight,display:getComputedStyle(p).display,flex:getComputedStyle(p).flex,overflow:getComputedStyle(p).overflow});return rows;}'))
    folder_y=folders.bounding_box()['y']
    box=cards.bounding_box()
    page.mouse.move(box['x']+box['width']/2,box['y']+min(80,box['height']/2))
    page.mouse.wheel(0,350)
    page.wait_for_function('(selector)=>document.querySelector(selector).scrollTop>0',arg=cards_selector)
    assert folders.evaluate('(el)=>el.scrollTop')==0
    assert abs(folders.bounding_box()['y']-folder_y)<1
    card_scroll=cards.evaluate('(el)=>el.scrollTop')
    folders.evaluate("(el)=>{const extra=document.createElement('div');extra.dataset.scrollFixture='';extra.style.height='1600px';extra.style.flex='none';el.append(extra);}")
    box=folders.bounding_box()
    page.mouse.move(box['x']+box['width']/2,box['y']+min(60,box['height']/2))
    page.mouse.wheel(0,250)
    page.wait_for_function('(selector)=>document.querySelector(selector).scrollTop>0',arg=folders_selector)
    assert abs(cards.evaluate('(el)=>el.scrollTop')-card_scroll)<2
    folders.evaluate("(el)=>{el.querySelector('[data-scroll-fixture]').remove();el.scrollTop=0;}")
    cards.evaluate('(el)=>el.scrollTop=0')


def verify(browser, url, shots):
    context = browser.new_context(viewport={'width':1600,'height':1000})
    context.add_init_script(layout.collection.FIXTURE.replace('__MIXED__','false')+FIXTURE)
    context.route('**/*',lambda route: route.continue_() if route.request.url.startswith(url) else route.abort())
    context.route('https://image.civitai.com/gallery-fixture/**', lambda route: route.fulfill(status=200,content_type='image/svg+xml',body=preview(int(route.request.url.rsplit('/',1)[-1].split('.')[0]))))
    try:
        page=context.new_page()
        page.set_default_timeout(8000)
        page.goto(url,wait_until='networkidle')
        layout.collection.set_locale(page,'en','[data-node="studio"]')
        page.locator('[data-node="optional-downloads"]').click()
        before=page.evaluate('__galleryCalls.filter(x=>x.c==="native_models_scan").length')
        page.get_by_role('tab',name='Installed',exact=True).click()
        expect(page.get_by_role('region',name='Your collection',exact=True)).to_be_visible()
        page.get_by_role('tab',name='LoRAs',exact=True).click()
        expect(page.locator('.library-card')).to_have_count(60)
        expect(page.locator('.library-refresh')).to_be_enabled()
        assert page.locator('.library-native-actions').get_by_role('button',name='Fetch',exact=True).count()==1
        fetch_box=page.get_by_role('button',name='Fetch',exact=True).bounding_box()
        refresh_box=page.locator('.library-refresh').bounding_box()
        assert abs(fetch_box['y']-refresh_box['y'])<2
        assert abs(fetch_box['height']-refresh_box['height'])<2

        assert page.locator('.library-browse [role="tablist"]').count()==1
        assert page.locator('.library-sidebar [role="tablist"]').count()==0
        assert page.locator('.library-browse').bounding_box()['y'] < page.locator('.library-layout').bounding_box()['y']

        after=page.evaluate('__galleryCalls.filter(x=>x.c==="native_models_scan").length')
        assert after==before+1
        page.get_by_role('button',name='Fetch',exact=True).click()
        expect(page.get_by_role('group',name='Fetch',exact=True)).to_be_visible()
        expect(page.get_by_label('Only missing metadata or previews')).to_be_checked()
        for width in [1920,1440,1280,960]:
            page.set_viewport_size({'width':width,'height':1000})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),width
            assert page.locator('.library-card').first.bounding_box()['width']>120
            expect(page.get_by_role('tree',name='Model folders',exact=True)).to_be_visible()
            assert page.locator('.library-sidebar').evaluate('(el)=>el.scrollWidth<=el.clientWidth+1')
            for eye in page.locator('.library-sidebar .model-folder-visibility').all():
                assert eye.evaluate('(el)=>{const box=el.getBoundingClientRect(),row=el.parentElement.getBoundingClientRect();return box.right<=row.right+1&&box.left>=row.left;}')

        page.get_by_role('button',name='Fetch',exact=True).click()
        page.set_viewport_size({'width':1600,'height':1000})
        independent_scroll(page,'.library-sidebar','.library-body')
        page.get_by_role('button',name='Hide Styles folder',exact=True).click()
        expect(page.locator('.library-card')).to_have_count(44)
        page.get_by_role('button',name='Show Styles folder',exact=True).click()
        expect(page.locator('.library-card')).to_have_count(60)
        page.get_by_role('button',name='Expand Styles',exact=True).click()
        expect(page.get_by_role('treeitem',name='Illustration',exact=True)).to_be_visible()
        page.get_by_role('button',name='Collapse Styles',exact=True).click()
        expect(page.get_by_role('treeitem',name='Illustration',exact=True)).to_have_count(0)
        page.screenshot(path=str(shots/'gallery-grid.png'),full_page=True)
        page.get_by_role('tab',name='Catalog',exact=True).click()
        page.get_by_role('tab',name='Installed',exact=True).click()
        page.get_by_role('tab',name='LoRAs',exact=True).click()
        expect(page.locator('.library-card')).to_have_count(60)
        assert page.evaluate('__galleryCalls.filter(x=>x.c==="native_models_scan").length')==after
        page.locator('[data-library-local-search]').fill('gallery_trigger_0')
        expect(page.locator('.library-card')).to_have_count(1)
        page.locator('.library-card-main').first.click()
        expect(page.get_by_role('dialog',name='Model details',exact=True)).to_be_visible()
        expect(page.get_by_text('Fixture version description',exact=True)).to_be_visible()
        rect=page.get_by_role('dialog',name='Model details').bounding_box()
        assert rect['width']<=800 and rect['height']<=980
        page.get_by_label('Personal notes',exact=True).fill('Fixture note: warm light at 0.7')
        page.get_by_label('Edit model tags',exact=True).fill('portrait, warm light')
        page.get_by_label('Edit model tags',exact=True).press('Tab')
        assert page.evaluate('localStorage.getItem("deas.pref.library.local.organization").includes("warm light")')
        page.screenshot(path=str(shots/'gallery-details.png'),full_page=True)
        page.get_by_role('button',name='Close model details',exact=True).click()
        page.get_by_role('button',name='Clear search',exact=True).click()
        page.locator('[data-model-sort]').select_option('newest')
        expect(page.locator('.library-card-main').first).to_have_attribute('aria-label','Portraits/Characters/Soft geometry-87.safetensors')
        page.locator('[data-model-sort]').select_option('random')
        page.get_by_role('button',name='Shuffle',exact=True).click()
        page.get_by_role('button',name='List view',exact=True).click()
        expect(page.locator('.library-card-grid.is-list')).to_be_visible()
        page.screenshot(path=str(shots/'gallery-list.png'),full_page=True)
        assert page.evaluate('__galleryCalls.filter(x=>x.c==="native_models_scan").length')==after
        assert not page.evaluate('__galleryCalls.some(x=>/native_(download_start|model_info|model_scan_start|workbench_run)/.test(x.c))')
        page.get_by_role('button',name='Clear filters',exact=True).first.click()
        page.get_by_label('View all',exact=True).check()
        page.locator('.library-body').evaluate('(el)=>el.scrollTop=el.scrollHeight')
        expect(page.locator('.library-card')).to_have_count(88)
        assert page.get_by_role('button',name='Show 28 more',exact=True).count()==0
        page.get_by_label('View all',exact=True).uncheck()
        expect(page.locator('.library-card')).to_have_count(60)
        page.locator('[data-node="studio"]').click()
        page.locator('[data-dock-tab="models"]').click()
        expect(page.locator('.wb-dock-panel [data-model-folder-tree]')).to_be_visible()
        expect(page.locator('.wb-dock [data-model-sort]')).to_be_visible()
        page.locator('[data-dock-tab="loras"]').click()
        page.locator('.wb-dock').get_by_label('View all',exact=True).check()
        page.locator('.studio-model-results').evaluate('(el)=>el.scrollTop=el.scrollHeight')
        expect(page.locator('.studio-model-results .wb-tiles>li')).to_have_count(88)
        page.locator('.wb-dock').get_by_label('View all',exact=True).uncheck()
        expect(page.locator('.studio-model-results .wb-tiles>li')).to_have_count(60)

        independent_scroll(page,'.wb-model-browser-panel .model-folder-tree','.wb-model-browser-panel .studio-model-results')

        assert not page.evaluate('__galleryCalls.some(x=>x.c==="native_models_scan"&&x.a?.refresh)')
        result={'status':'PASS','kind':'Chromium; synthetic gallery and strict mocked IPC; no DEAS capture or real models','checks':['desktop gallery geometry','independent folder/card wheel scrolling in Library and Studio','folder visibility and Fetch options','collapsible Library and Studio folder trees','all model sort modes','model details popup','60-card bound','navigation reuses snapshot','trigger-word search','details','persisted notes and tags','grid/list switching','no implicit scan, metadata fetch, download or generation'],'artifacts':str(shots)}
        (shots/'result.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(result,indent=2))
    finally:
        context.close()


if __name__=='__main__':
    runner.verify=verify
    runner.main(artifact_root=Path(__file__).resolve().parents[1]/'output/playwright')
