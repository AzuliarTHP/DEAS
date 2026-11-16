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
window.__galleryModels=Array.from({length:96},(_,i)=>({category:i<88?'loras':'checkpoints',name:(i%2?'Portraits/Characters/':'Styles/Illustration/')+titles[i%titles.length]+'-'+i+'.safetensors',path:'/fixture/models/'+i+'.safetensors',size:(i+1)*64*1048576,addedAt:1700000000+i,metadataError:null,detectedFamily:null,familyOverride:null,family:i%3?'sdxl':'flux',...(i%3===1?{familyOverride:'sdxl'}:{}),info:{sha256:'fixture',size:1,fetchedAt:1,civitai:{description:'Fixture version description',modelId:i+1,versionId:i+1,name:titles[i%titles.length],version:'v'+(i%3+1)+'.0',modelType:'LORA',category:'loras',base:i%3?'SDXL 1.0':'Flux.1 D',nsfw:false,trainedWords:['gallery_trigger_'+i,'soft light'],preview:'https://image.civitai.com/gallery-fixture/'+i+'.svg'}}}));
window.__TAURI_INTERNALS__.invoke=async(c,a)=>{
 window.__galleryCalls.push({c,a});
 if(c==='native_models_scan')return structuredClone(window.__galleryModels);
 if(c==='native_model_family_write_many'){const updated=window.__galleryModels.filter(m=>a.paths.includes(m.path)).map(m=>({...m,family:a.family??'sdxl',familyOverride:a.family??null}));window.__galleryModels=window.__galleryModels.map(m=>updated.find(u=>u.path===m.path)??m);return {updated:structuredClone(updated),failed:[]};}
 if(c==='native_model_scan_start'){if(window.__qolOnScan)window.__qolOnScan();window.__qolScanCount=(window.__qolScanCount??0)+1;window.__qolScanStatus={id:'qol-scan-'+window.__qolScanCount,root:a.root,state:'succeeded',completed:a.paths?.length??1,total:a.paths?.length??1,remaining:0,failed:0,file:null};return window.__qolScanStatus;}
 if(c==='native_model_scan_status'&&window.__qolScanStatus)return window.__qolScanStatus;

 if(c==='native_recipe_prerequisites'){const result=await galleryInvoke(c,a);return {...result,allowlist:{...result.allowlist,checkpoints:window.__galleryModels.filter(m=>m.category==='checkpoints').map(m=>m.name),loras:window.__galleryModels.filter(m=>m.category==='loras').map(m=>m.name)}};}
 if(c==='native_model_scan_status')return {id:'',root:'',state:'idle',completed:0,total:0,remaining:0,failed:0};
 if(c==='native_logs_library_error')return;
 if(c==='native_media_list')return {path:a.path,parent:null,entries:['a.png','b.jpg'].filter(name=>!window.__deletedMedia?.includes(a.path+'/'+name)).map(name=>({name,path:a.path+'/'+name,kind:'file',symlink:false,media:'image',size:1,modified:1})),truncated:false};
 if(c==='native_media_thumbnail')return a.path;
 if(c==='native_media_star_status')return {starred:false,unavailable:'Fixture: no native file access'};
 if(c==='native_media_delete'){window.__deletedMedia=[...(window.__deletedMedia||[]),...a.paths];return {deleted:a.paths,failed:[]};}
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
    folders.evaluate('(el)=>el.scrollTop=0')
    cards.evaluate('(el)=>el.scrollTop=0')
    assert cards.evaluate('(el)=>el.scrollHeight>el.clientHeight+5'), (cards_selector,cards.evaluate('(el)=>{const rows=[];for(let p=el;p;p=p.parentElement)rows.push({tag:p.tagName,cls:p.className,height:p.clientHeight,scroll:p.scrollHeight,display:getComputedStyle(p).display,flex:getComputedStyle(p).flex,overflow:getComputedStyle(p).overflow});return rows;}'))
    folder_y=folders.bounding_box()['y']
    box=cards.bounding_box()
    page.mouse.move(box['x']+box['width']/2,box['y']+min(80,box['height']/2))
    page.mouse.wheel(0,350)
    page.wait_for_function('(selector)=>{const el=document.querySelector(selector);return el.scrollTop>=Math.min(350,el.scrollHeight-el.clientHeight)-2;}',arg=cards_selector)
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


def assert_notice(page, notice):
    expect(notice).to_be_visible()
    assert notice.evaluate('(el)=>getComputedStyle(el).position')=='fixed'
    assert notice.evaluate("(el)=>el.matches(':popover-open')")
    box=notice.bounding_box()
    viewport=page.viewport_size
    assert box['x']>=0 and box['y']>=0 and box['x']+box['width']<=viewport['width'] and box['y']+box['height']<=viewport['height']
    assert notice.evaluate('(el)=>el.scrollHeight<=el.clientHeight+1&&el.scrollWidth<=el.clientWidth+1')


def verify(browser, url, shots):
    context = browser.new_context(viewport={'width':1600,'height':1000})
    context.add_init_script(layout.collection.FIXTURE.replace('__MIXED__','false')+FIXTURE)
    context.route('**/*',lambda route: route.continue_() if route.request.url.startswith(url) else route.abort())
    context.route('https://image.civitai.com/gallery-fixture/**', lambda route: route.fulfill(status=200,content_type='image/svg+xml',body=preview(int(route.request.url.rsplit('/',1)[-1].split('.')[0]))))
    try:
        page=context.new_page()
        page.on('pageerror',lambda error: print('PAGE_ERROR',str(error)))
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
        page.locator('.library-card-main').first.click(button='right')
        page.get_by_role('menuitem',name='Add to Studio LoRAs',exact=True).click()
        expect(page.get_by_role('status',exact=True)).to_contain_text('LoRA added')
        assert_notice(page,page.get_by_role('status',exact=True))
        expect(page.get_by_role('dialog')).to_have_count(0)
        page.locator('.library-card-main').first.click()
        expect(page.get_by_role('dialog',name='Model details',exact=True)).to_be_visible()
        actions=page.locator('.library-detail-actions button')
        action_boxes=[button.bounding_box() for button in actions.all()]
        page.get_by_role('button',name='Add to Studio LoRAs',exact=True).click()
        expect(page.get_by_role('dialog').get_by_role('status')).to_contain_text('LoRA added')
        assert action_boxes==[button.bounding_box() for button in actions.all()]
        assert abs(action_boxes[0]['y']-action_boxes[1]['y'])<2
        assert_notice(page,page.get_by_role('dialog').get_by_role('status'))
        # Make storage unavailable, exactly like a quota/permissions failure, without changing user data.
        page.evaluate("()=>{window.__gallerySetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('fixture full','QuotaExceededError');};}")
        for width,height in [(1366,768),(1920,1080),(960,700)]:
            page.set_viewport_size({'width':width,'height':height})
            page.get_by_role('button',name='Add to Studio LoRAs',exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('Could not add the LoRA')
            assert_notice(page,page.get_by_role('alert'))
            page.get_by_role('dialog',name='Model details').evaluate('(el)=>el.scrollTop=el.scrollHeight')
            assert_notice(page,page.get_by_role('alert'))
        page.get_by_role('button',name='Close model details',exact=True).click()
        page.locator('.library-add-lora').first.click()
        assert_notice(page,page.get_by_role('alert'))
        page.evaluate('()=>{Storage.prototype.setItem=window.__gallerySetItem;}')
        page.set_viewport_size({'width':1600,'height':1000})
        page.locator('.library-card-main').first.click()

        expect(page.get_by_text('Fixture version description',exact=True)).to_be_visible()
        rect=page.get_by_role('dialog',name='Model details').bounding_box()
        assert rect['width']<=800 and rect['height']<=980
        page.get_by_label('Personal notes',exact=True).fill('Fixture note: warm light at 0.7')
        page.get_by_label('Edit model tags',exact=True).fill('portrait, warm light')
        page.get_by_label('Edit model tags',exact=True).press('Tab')
        assert page.evaluate('localStorage.getItem("deas.pref.library.local.organization").includes("warm light")')
        page.screenshot(path=str(shots/'gallery-details.png'),full_page=True)
        page.mouse.click(max(2,rect['x']-20),rect['y']+20)
        expect(page.get_by_role('dialog',name='Model details',exact=True)).to_have_count(0)
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
        expect(page.locator('.wb-lora-button')).to_contain_text('1')
        page.locator('[data-dock-tab="models"]').click()
        expect(page.locator('.wb-dock-panel [data-model-folder-tree]')).to_be_visible()
        expect(page.locator('.wb-dock [data-model-sort]')).to_be_visible()
        page.locator('[data-dock-tab="loras"]').click()
        page.get_by_label('Hide other families',exact=True).check()
        expect(page.locator('.studio-model-results .wb-tiles>li')).to_have_count(58)
        page.get_by_label('Hide other families',exact=True).uncheck()
        expect(page.locator('.studio-model-results .wb-tiles>li')).to_have_count(60)
        page.locator('.wb-dock').get_by_label('View all',exact=True).check()
        page.locator('.studio-model-results').evaluate('(el)=>el.scrollTop=el.scrollHeight')
        expect(page.locator('.studio-model-results .wb-tiles>li')).to_have_count(88)
        page.locator('.studio-model-results').evaluate('(el)=>el.scrollTop=0')
        page.locator('.wb-dock').get_by_label('View all',exact=True).uncheck()
        expect(page.locator('.studio-model-results .wb-tiles>li')).to_have_count(60)

        independent_scroll(page,'.wb-model-browser-panel .model-folder-tree','.wb-model-browser-panel .studio-model-results')
        declared=page.locator('.wb-loras .model-declared-compact').first
        expect(declared).to_be_visible()
        assert 'User-declared family' in declared.get_attribute('title')
        declared_box=declared.locator('..').bounding_box()
        normal_box=page.locator('.wb-loras button').filter(has_not=page.locator('.model-declared-compact')).first.bounding_box()
        assert abs(declared_box['height']-normal_box['height'])<2
        grey=page.locator('.wb-loras button[data-family-mismatch="true"]').first
        expect(grey).to_have_attribute('aria-disabled','false')
        grey.click()
        expect(grey).to_have_attribute('aria-pressed','true')
        expect(page.locator('[data-run]')).to_be_enabled()
        page.locator('.wb-lora-button').click()
        popup=page.get_by_role('dialog',name='Selected LoRAs and sets',exact=True)
        expect(popup).to_be_visible()
        popup.locator('input[type="number"]').first.fill('0.65')
        popup.get_by_label('Set name',exact=True).fill('Fixture LoRA set')
        popup.get_by_role('button',name='Save new set',exact=True).click()
        expect(popup.get_by_role('option',name='Fixture LoRA set',exact=True)).to_have_count(1)
        bounds=popup.bounding_box()
        assert 1100<=bounds['width']<=1500 and 650<=bounds['height']<=900
        expect(popup.locator('.lora-set-preview img').first).to_be_visible()
        popup.locator('button.lora-set-preview').first.click()
        details=page.get_by_role('dialog',name='LoRA details',exact=True)
        expect(details).to_be_visible()
        expect(details.locator('.lora-trigger-words')).to_contain_text('gallery_trigger_')
        details.press('Escape')
        expect(details).to_have_count(0)
        expect(popup).to_be_visible()
        expect(popup.get_by_label('Set name',exact=True)).to_have_value('Fixture LoRA set')
        popup.locator('button.lora-set-preview').first.click()
        detail_box=details.bounding_box()
        page.mouse.click(max(2,detail_box['x']-15),detail_box['y']+20)
        expect(details).to_have_count(0)
        expect(popup).to_be_visible()
        page.mouse.click(max(2,bounds['x']-20),bounds['y']+20)
        expect(popup).to_have_count(0)


        page.locator('[data-dock-tab="notes"]').click()
        notebook=page.locator('.prompt-notebook')
        notebook.get_by_label('Folder name',exact=True).fill('Characters')
        notebook.get_by_role('button',name='New folder',exact=True).click()
        notebook.get_by_label('Folder name',exact=True).fill('Portraits')
        notebook.get_by_role('button',name='New folder',exact=True).click()
        notebook.get_by_label('Note name',exact=True).fill('Fixture note')
        notebook.get_by_label('Note positive prompt',exact=True).fill('soft lighting')
        notebook.get_by_label('Note negative prompt',exact=True).fill('blur')
        notebook.get_by_label('Note seed',exact=True).fill('12345')
        notebook.get_by_label('Note positive prompt',exact=True).press('Control+Enter')
        page.locator('[data-dock-tab="loras"]').click()
        page.locator('[data-dock-tab="notes"]').click()
        expect(notebook.get_by_label('Note positive prompt',exact=True)).to_have_value('soft lighting')
        notebook.get_by_role('button',name='Save note',exact=True).click()
        assert page.evaluate('JSON.parse(localStorage.getItem("deas.pref.studio.promptNotebook")).notes[0].seed')==12345
        expect(notebook.locator('.prompt-note-browser').get_by_role('button',name='Fixture note',exact=True)).to_be_visible()
        assert notebook.locator('.prompt-note-folders .prompt-note-list').count()==0
        assert notebook.get_by_role('button',name='Delete note',exact=True).evaluate('(el)=>el.nextElementSibling.textContent')=='New note'
        for width in [1920,1280,960]:
            page.set_viewport_size({'width':width,'height':1000})
            folders=notebook.locator('.prompt-note-folders').bounding_box()
            notes=notebook.locator('.prompt-note-browser').bounding_box()
            editor=notebook.locator('.prompt-note-editor').bounding_box()
            toolbar=notebook.locator('.prompt-note-folder-toolbar')
            buttons=toolbar.locator('button').all()
            assert len(buttons)==4
            button_boxes=[button.bounding_box() for button in buttons]
            assert max(box['y'] for box in button_boxes)-min(box['y'] for box in button_boxes)<2
            assert button_boxes[-1]['x']+button_boxes[-1]['width']<=folders['x']+folders['width']
            assert folders['x']+folders['width']<=notes['x']+1
            assert notes['x']+notes['width']<=editor['x']+1
            labels=notebook.locator('.prompt-note-fields>label').all()
            boxes=[label.bounding_box() for label in labels]
            assert boxes[0]['x']<boxes[1]['x']<boxes[2]['x']
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.set_viewport_size({'width':1600,'height':1000})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')

        page.locator('[data-dock-tab="media"]').click()
        library=page.locator('.wb-dock .media-library')
        expect(library.get_by_role('button',name='a.png',exact=True)).to_be_visible()
        library.get_by_role('button',name='a.png',exact=True).click(button='right')
        library.get_by_role('menuitem',name='Delete…',exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('Permanently delete 1')
        page.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click()
        assert not page.evaluate('__galleryCalls.some(x=>x.c==="native_media_delete")')
        library.get_by_role('button',name='Select files',exact=True).click()
        library.get_by_role('button',name='Select all',exact=True).click()
        expect(library.get_by_text('2 selected',exact=True)).to_be_visible()
        library.get_by_role('button',name='Delete selected…',exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('Permanently delete 2')
        page.get_by_role('dialog').locator('[data-confirm-dialog]').click()
        expect(library.get_by_role('button',name='a.png',exact=True)).to_have_count(0)
        expect(library.get_by_role('button',name='b.jpg',exact=True)).to_have_count(0)
        assert page.evaluate('__galleryCalls.filter(x=>x.c==="native_media_delete").length')==1

        assert not page.evaluate('__galleryCalls.some(x=>x.c==="native_models_scan"&&x.a?.refresh)')
        # Reopen the synthetic app with a long retained selection; no real model/filesystem operations.
        page.evaluate("()=>{localStorage.setItem('deas.pref.studio.run.loras',JSON.stringify(__galleryModels.slice(0,75).map((m,i)=>({name:m.name,strength:(i+1)/100}))));}")
        page.reload(wait_until='networkidle')
        layout.collection.set_locale(page,'en','[data-node="studio"]')
        page.locator('.wb-lora-button').click()
        picker=page.get_by_role('dialog',name='Selected LoRAs and sets',exact=True)
        selected=picker.get_by_role('region',name='Selected LoRAs',exact=True)
        expect(selected.locator('[data-lora-row]')).to_have_count(75)
        assert selected.evaluate('(el)=>el.scrollHeight>el.clientHeight+100')
        thumb=selected.locator('.lora-set-preview').first.bounding_box()
        assert thumb['width']<=44 and thumb['height']<=52
        saved_panel=picker.locator('.lora-saved-panel')
        saved_y=saved_panel.bounding_box()['y']
        first_name=selected.locator('[data-lora-row]').first.get_attribute('data-lora-row')
        handle=selected.get_by_role('button',name='Reorder '+first_name,exact=True)
        box=handle.bounding_box();bounds=selected.bounding_box()
        page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
        page.mouse.down()
        page.mouse.move(box['x']+box['width']/2,bounds['y']+bounds['height']-5,steps=12)
        page.wait_for_function("document.querySelector('.lora-selected-scroll').scrollTop>180")
        page.mouse.up()
        order=selected.locator('[data-lora-row]').evaluate_all('(rows)=>rows.map(row=>row.dataset.loraRow)')
        down_index=order.index(first_name)
        assert down_index>3, down_index
        assert abs(saved_panel.bounding_box()['y']-saved_y)<1
        assert saved_panel.evaluate('(el)=>el.scrollTop')==0
        assert picker.evaluate('(el)=>el.scrollTop')==0
        handle.scroll_into_view_if_needed()
        start_scroll=selected.evaluate('(el)=>el.scrollTop')
        assert start_scroll>100
        box=handle.bounding_box();bounds=selected.bounding_box()
        page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
        page.mouse.down()
        page.mouse.move(box['x']+box['width']/2,bounds['y']+5,steps=12)
        page.wait_for_function('(start)=>document.querySelector(".lora-selected-scroll").scrollTop<start-100',arg=start_scroll)
        page.mouse.up()
        order=selected.locator('[data-lora-row]').evaluate_all('(rows)=>rows.map(row=>row.dataset.loraRow)')
        assert order.index(first_name)<down_index
        # Escape rolls back the current drag and leaves the selection dialog open.
        before_cancel=order
        handle.scroll_into_view_if_needed();box=handle.bounding_box();bounds=selected.bounding_box()
        page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down()
        page.mouse.move(box['x']+box['width']/2,bounds['y']+bounds['height']-5,steps=12)
        page.keyboard.press('Escape');page.mouse.up()
        expect(picker).to_be_visible()
        assert selected.locator('[data-lora-row]').evaluate_all('(rows)=>rows.map(row=>row.dataset.loraRow)')==before_cancel
        selected.evaluate('(el)=>el.scrollTop=0')
        active_name=selected.locator('.lora-enable-toggle[aria-pressed="true"]').first.evaluate('(el)=>el.closest("[data-lora-row]").dataset.loraRow')
        first=selected.locator('[data-lora-row]').filter(has=page.get_by_role('button',name='Reorder '+active_name,exact=True))
        first.get_by_role('button',name='Disable ',exact=False).click()
        expect(first).to_have_class('is-disabled')
        disabled_name=first.get_attribute('data-lora-row')
        picker.get_by_label('Set name',exact=True).fill('Order and switches')
        picker.get_by_role('button',name='Save new set',exact=True).click()
        assert page.evaluate("(name)=>JSON.parse(localStorage.getItem('deas.pref.studio.loraSets')).find(s=>s.name==='Order and switches').loras.find(l=>l.name===name).enabled",disabled_name) is False
        page.evaluate("()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedTriggers=text;}}});}")
        first.locator('.lora-set-preview').click()
        details=page.get_by_role('dialog',name='LoRA details',exact=True)
        chips=details.locator('.lora-trigger-words button')
        chips.first.click();chips.last.click()
        expected=', '.join([chips.first.inner_text(),chips.last.inner_text()])
        details.get_by_role('button',name='Copy selected (2)',exact=True).click()
        page.wait_for_function('(expected)=>window.__copiedTriggers===expected',arg=expected)
        details.get_by_role('button',name='Close',exact=True).click()
        for width,height in [(1366,768),(960,700),(1920,1080)]:
            page.set_viewport_size({'width':width,'height':height})
            expect(selected).to_be_visible()
            assert selected.bounding_box()['height']>200
            assert picker.evaluate('(el)=>el.scrollHeight<=el.clientHeight+1')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            for control in first.locator('button,input').all():
                assert control.evaluate('(el)=>{const b=el.getBoundingClientRect(),r=el.closest(".lora-selected-scroll").getBoundingClientRect();return b.left>=r.left&&b.right<=r.right;}')
        picker.get_by_role('button',name='Close',exact=True).click()
        page.locator('.wb-lora-button').click()
        expect(page.get_by_role('button',name='Enable '+disabled_name,exact=True)).to_be_visible()
        assert not page.evaluate('__galleryCalls.some(x=>x.c==="native_models_scan"&&x.a?.refresh)')
        assert not page.evaluate('__galleryCalls.some(x=>/native_(download_start|model_info|model_scan_start|workbench_run)/.test(x.c))')
        picker.get_by_role('button',name='Close',exact=True).click()
        page.set_viewport_size({'width':1600,'height':1000})
        page.locator('[data-node="optional-downloads"]').click();page.get_by_role('tab',name='Installed',exact=True).click();page.get_by_role('tab',name='LoRAs',exact=True).click()
        page.get_by_role('tab',name='Installed',exact=True).click()
        page.get_by_role('tab',name='LoRAs',exact=True).click()
        page.locator('[data-library-local-search]').fill('gallery_trigger_80')
        favorite_name=page.locator('.library-card-main').first.get_attribute('aria-label')
        page.locator('.library-star').first.click()
        page.get_by_role('button',name='Hide Styles folder',exact=True).click()
        expect(page.locator('.library-card-main')).to_have_count(0)
        page.get_by_role('button',name='Favorites',exact=True).click()
        expect(page.get_by_role('button',name=favorite_name,exact=True)).to_be_visible()
        page.locator('[data-node="studio"]').click()
        page.locator('[data-dock-tab="loras"]').click()
        page.locator('.wb-dock').get_by_role('button',name='Hide Styles folder',exact=True).click()
        page.locator('.studio-favorite-entry').click()
        card=page.locator('.wb-dock').get_by_role('button',name=favorite_name,exact=True)
        expect(card).to_be_visible()
        expect(page.locator('.studio-favorite-entry')).to_have_attribute('aria-current','page')
        card.click(button='right');page.get_by_role('menuitem',name='Remove from favorites',exact=True).click()
        expect(card).to_have_count(0)
        page.locator('[data-node="optional-downloads"]').click();page.get_by_role('tab',name='Installed',exact=True).click();page.get_by_role('tab',name='LoRAs',exact=True).click()
        page.get_by_role('button',name='Favorites',exact=True).click()
        expect(page.locator('.library-card-main')).to_have_count(0)
        page.get_by_role('treeitem',name='All folders',exact=True).click()
        page.get_by_role('button',name='Show Styles folder',exact=True).click()
        page.evaluate("()=>{__galleryModels[80]={...__galleryModels[80],name:'QoL/refreshed.safetensors'};}")
        calls=page.evaluate('__galleryCalls.filter(x=>x.c==="native_models_scan").length')
        page.locator('.library-refresh').click()
        page.locator('[data-library-local-search]').fill('refreshed')
        expect(page.get_by_role('button',name='QoL/refreshed.safetensors',exact=True)).to_be_visible()
        page.locator('[data-node="studio"]').click()
        page.locator('.wb-dock').get_by_role('treeitem',name='LoRAs',exact=True).click()
        page.locator('.wb-dock').get_by_role('button',name='Show Styles folder',exact=True).click()
        page.locator('[data-dock-search]').fill('refreshed')
        expect(page.locator('.wb-dock').get_by_role('button',name='QoL/refreshed.safetensors',exact=True)).to_be_visible()
        assert page.evaluate('__galleryCalls.filter(x=>x.c==="native_models_scan").length')==calls+1
        page.locator('[data-node="optional-downloads"]').click();page.get_by_role('tab',name='Installed',exact=True).click();page.get_by_role('tab',name='LoRAs',exact=True).click()
        page.locator('[data-library-local-search]').fill('')
        page.get_by_role('button',name='Fetch',exact=True).click()
        page.evaluate("()=>{window.__qolOnScan=()=>{__galleryModels[81]={...__galleryModels[81],family:'anima',familyOverride:'anima'};};}")
        page.get_by_role('button',name='Start fetch',exact=True).click()
        page.wait_for_function('__galleryCalls.some(x=>x.c==="native_model_scan_start")')
        page.wait_for_function("document.querySelector('.library-refresh')&&!document.querySelector('.library-refresh').disabled")
        page.wait_for_timeout(1200)
        scan_name=page.evaluate('__galleryModels[81].name')
        page.locator('[data-node="studio"]').click();page.locator('[data-dock-search]').fill(scan_name)
        expect(page.locator('.wb-dock').get_by_role('button',name=scan_name,exact=True).get_by_label('User-declared family: Anima',exact=True)).to_be_visible()
        page.locator('[data-node="optional-downloads"]').click();page.get_by_role('tab',name='Installed',exact=True).click();page.get_by_role('tab',name='LoRAs',exact=True).click()
        page.evaluate("()=>{window.__qolOnScan=()=>{__galleryModels[82]={...__galleryModels[82],family:'anima',familyOverride:'anima'};};}")
        page.get_by_role('button',name='Scan Files',exact=True).click()
        page.wait_for_function('__galleryCalls.filter(x=>x.c==="native_model_scan_start").length===2')
        page.wait_for_timeout(1200)
        scan_name2=page.evaluate('__galleryModels[82].name')
        page.locator('[data-node="studio"]').click();page.locator('[data-dock-search]').fill(scan_name2)
        expect(page.locator('.wb-dock').get_by_role('button',name=scan_name2,exact=True).get_by_label('User-declared family: Anima',exact=True)).to_be_visible()
        page.locator('[data-node="studio"]').click();page.locator('[data-dock-search]').fill('refreshed')
        selected_before=page.locator('.wb-lora-button').inner_text()
        for width in [1920,1600,1280,1024]:
            page.set_viewport_size({'width':width,'height':1000})
            control=page.locator('[data-family-select]')
            expect(control).to_be_visible()
            assert control.evaluate('(el)=>{const b=el.getBoundingClientRect(),s=document.querySelector("[data-dock-search]").getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&(b.bottom<=s.top+1||b.right<=s.left+1);}')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.set_viewport_size({'width':1600,'height':1000})
        page.get_by_role('button',name='Select models',exact=True).click()
        expect(page.get_by_role('button',name='Select unknown',exact=True)).to_have_count(0)
        for width in [1920,1600,1280,1024]:
            page.set_viewport_size({'width':width,'height':1000})
            tools=page.locator('.studio-family-tools')
            assert tools.locator('.studio-selection-icon').count()==5
            assert tools.evaluate('(el)=>{const b=el.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&[...el.querySelectorAll("button")].every(n=>{const r=n.getBoundingClientRect();return r.left>=b.left&&r.right<=b.right&&r.bottom<=b.bottom;});}')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.set_viewport_size({'width':1920,'height':1000})
        assert page.locator('.studio-family-toolbar').evaluate('(el)=>{const b=el.getBoundingClientRect(),d=document.querySelector("[data-family-select]").getBoundingClientRect();return Math.abs(b.top+b.height/2-d.top-d.height/2)<2&&b.right<=d.left;}')
        page.set_viewport_size({'width':1600,'height':1000})
        page.locator('.studio-family-choice').first.check();page.get_by_role('button',name='Select matching label',exact=True).click()
        expect(page.locator('.studio-family-choice')).to_be_checked()
        expect(page.get_by_text('1 selected',exact=True)).to_be_visible()
        page.get_by_role('button',name='Set family…',exact=True).click()
        family_dialog=page.get_by_role('dialog',name='Set family…',exact=True)
        family_dialog.get_by_role('combobox').select_option('anima')
        family_dialog.get_by_role('button',name='Apply family',exact=True).click()
        expect(family_dialog.get_by_role('status')).to_contain_text('1/1 processed')
        family_dialog.get_by_role('button',name='Close',exact=True).click()
        page.get_by_role('button',name='Done selecting',exact=True).click()
        expect(page.locator('.wb-lora-button')).to_have_text(selected_before)
        page.locator('[data-node="studio"]').click();page.locator('[data-dock-search]').fill('refreshed')
        card=page.locator('.wb-dock').get_by_role('button',name='QoL/refreshed.safetensors',exact=True)
        expect(card.get_by_label('User-declared family: Anima',exact=True)).to_be_visible()
        card.click(button='right');page.get_by_role('menuitem',name='Add to favorites',exact=True).click()
        page.locator('[data-dock-search]').fill('')
        page.get_by_role('button',name='Select models',exact=True).click()
        page.locator('.wb-dock').get_by_role('button',name='QoL/refreshed.safetensors',exact=True).click();page.get_by_role('button',name='Select matching label',exact=True).click()
        selected_count=int(page.locator('.studio-family-toolbar > span[aria-live]').inner_text().split()[0])
        assert selected_count==3
        page.get_by_role('button',name='Add to favorites',exact=True).click()
        expect(page.locator('.studio-favorite-entry small')).to_have_text(str(selected_count))
        page.get_by_role('button',name='Remove from favorites',exact=True).click()
        expect(page.locator('.studio-favorite-entry small')).to_have_text('0')
        page.get_by_role('button',name='Done selecting',exact=True).click()
        expect(page.locator('.wb-lora-button')).to_have_text(selected_before)
        page.locator('[data-dock-search]').fill('refreshed')
        card.click(button='right');page.get_by_role('menuitem',name='Add to favorites',exact=True).click()
        page.locator('[data-node="optional-downloads"]').click();page.get_by_role('tab',name='Installed',exact=True).click();page.get_by_role('tab',name='LoRAs',exact=True).click();page.get_by_role('button',name='Favorites',exact=True).click()
        expect(page.get_by_role('button',name='QoL/refreshed.safetensors',exact=True)).to_be_visible()
        assert not page.evaluate('__galleryCalls.some(x=>/native_(download_start|model_info|workbench_run)/.test(x.c))')
        result={'status':'PASS','kind':'Chromium; synthetic gallery and strict mocked IPC; no DEAS capture or real models','checks':['Library context-menu addition reaches retained Studio without navigation or scans','detail action buttons stay aligned during added toast','nullable native index metadata handoff','success and failure notices stay fully visible above containment and scrolled dialogs','compact independently scrolling selected LoRAs','pointer drag reordering with stationary edge auto-scroll up and down','Escape cancels drag without closing the picker','saved order and on/off flags','selective trigger-word copying without system clipboard access','Library and Studio Favorites sidebar views include hidden folders','right-click favorite edits propagate both directions','explicit Library refresh and completed scan update Studio without duplicate folder scan','inline selection icons stay beside Done selecting and match the last selected card’s displayed label without changing generation picks','desktop gallery geometry','independent folder/card wheel scrolling in Library and Studio','folder visibility and Fetch options','collapsible Library and Studio folder trees','all model sort modes','compact declared-family badge without taller cards','non-blocking selected LoRA family labels','folder action icons beside All notes','manual Notes folders/prompts/seed and retained draft','confirmed single/bulk Media delete with mocked paths','model details popup','nested LoRA details and trigger words with Escape/backdrop isolation','three separate Notes panes and reordered fields at desktop widths','60-card bound','navigation reuses snapshot','trigger-word search','details','persisted notes and tags','grid/list switching','no implicit scan, metadata fetch, download or generation'],'artifacts':str(shots)}
        (shots/'result.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(result,indent=2))
    finally:
        context.close()


if __name__=='__main__':
    runner.verify=verify
    runner.main(artifact_root=Path(__file__).resolve().parents[1]/'output/playwright')
