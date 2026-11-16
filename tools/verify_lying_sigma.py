"""Image Lying Sigma UI acceptance: Chromium and read-only native IPC fixtures.

No backend, model scan, upload or generation. Artifacts remain in ignored output/.
"""
import json
from pathlib import Path
from playwright.sync_api import expect
import verify_postprocessing as runner
import verify_workbench_collection as collection
import verify_workspace_layout as layout

CAPABILITY = r'''
const lyingInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
 const result=await lyingInvoke(command,args);
 if(command==='native_models_scan')return [{category:'checkpoints',name:'Example/SDXL.safetensors',path:'/fixture/models/example.safetensors',family:'sdxl',size:1,info:null}];
 if(command!=='native_recipe_prerequisites')return result;
 return {...result,allowlist:{...result.allowlist,checkpoints:['Example/SDXL.safetensors'],nodes:[...new Set([...result.allowlist.nodes,
 'DEAS_LyingSigmaSampler','RandomNoise','CFGGuider','KSamplerSelect','BasicScheduler','SamplerCustomAdvanced'])]}};
};
'''


def verify(browser, url, shots):
    original = collection.FIXTURE
    collection.FIXTURE += layout.FIXTURE + CAPABILITY
    try:
        context, page, errors = collection.open_studio(browser, url, False)
    finally:
        collection.FIXTURE = original
    try:
        factor = page.locator('[data-lying-sigma-factor]')
        control = page.locator('[data-lying-sigma]')
        expect(factor).to_have_value('0')
        assert factor.evaluate('e=>!e.validity.stepMismatch')
        expect(control).to_contain_text('0 = Off')
        heading = control.locator('.wb-lying-sigma-heading')
        expect(heading).to_contain_text('0 = Off')
        label, status = heading.locator('label').bounding_box(), heading.locator('small').bounding_box()
        assert abs(label['y'] - status['y']) < 4
        assert label['x'] + label['width'] < status['x']
        scheduler = page.locator('[data-pick="studio.recipe.scheduler"]').bounding_box()
        box, seed = control.bounding_box(), page.locator('[data-seed]').bounding_box()
        assert scheduler['y'] + scheduler['height'] <= box['y'] + 1
        assert box['y'] + box['height'] <= seed['y'] + 1
        actions = page.locator('[data-seed-actions]')
        expect(actions.locator('button')).to_have_count(5)
        actions_box = actions.bounding_box()
        assert actions_box['y'] + actions_box['height'] <= seed['y'] + 1
        assert actions_box['x'] + actions_box['width'] <= seed['x'] + seed['width'] + 1
        page.locator('.wb-side').screenshot(path=str(shots/'lying-sigma-off.png'))

        factor.press('ArrowDown')
        expect(factor).to_have_value('-0.01')
        factor.press('ArrowUp')
        expect(factor).to_have_value('0')
        factor.fill('-0.05')
        control.locator('summary').click()
        expect(page.locator('[data-lying-sigma-start]')).to_have_value('25')
        expect(page.locator('[data-lying-sigma-end]')).to_have_value('90')
        page.locator('[data-lying-sigma-start]').fill('20')
        page.locator('[data-lying-sigma-end]').fill('80')
        expect(page.locator('[data-lying-sigma-start]')).to_have_value('20')
        expect(page.locator('[data-lying-sigma-end]')).to_have_value('80')
        expected = {'factor': -0.05, 'startPercent': 0.2, 'endPercent': 0.8}
        assert page.evaluate("JSON.parse(localStorage.getItem('deas.pref.studio.run.lyingSigma'))") == expected
        expect(control.get_by_role('status')).to_have_count(0)
        page.locator('.wb-side').screenshot(path=str(shots/'lying-sigma-enabled.png'))
        checks = []
        for locale in collection.LOCALES:
            collection.set_locale(page, locale, '[data-node="studio"]')
            for width, height in [(1440, 960), (1024, 768), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height})
                layout.assert_viewport(page, f'lying-sigma:{locale}:{width}x{height}')
                checks.append(f'{locale}:{width}x{height}')
        factor.fill('0')
        expect(page.locator('[data-lying-sigma-start]')).to_have_count(0)
        collection.assert_clean(page, errors)
        forbidden = page.evaluate("__collection.calls.filter(c=>/(_start|_stop|_write|_send|_generate|_run|_submit|_cancel)$/.test(c.command))")
        assert not forbidden, forbidden
        result = {'status': 'PASS', 'checks': checks, 'placement': 'below scheduler, above seed',
                  'defaultFactor': 0, 'defaultTiming': [25, 90], 'factorStep': 0.01, 'savedSettings': expected, 'seedActions': 'on the Seed heading row',
                  'kind': 'Chromium; simulated read-only native IPC; no generation', 'screenshots': str(shots)}
        (shots/'result.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
        print(json.dumps(result, indent=2))
    finally:
        context.close()


if __name__ == '__main__':
    runner.verify = verify
    runner.main(artifact_root=Path(__file__).resolve().parents[1]/'output/playwright')
