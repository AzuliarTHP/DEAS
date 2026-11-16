import {expect,test} from 'vitest';
import {generationSettings} from './imageMetadata';

const graph=()=>({
 sampler:{class_type:'KSampler',inputs:{model:['slg',0],seed:123,steps:50}},
 slg:{class_type:'SkipLayerGuidanceDiTSimple',inputs:{model:['model',0],double_layers:'',single_layers:'19, 22',start_percent:0,end_percent:1}},
 model:{class_type:'UNETLoader',inputs:{unet_name:'moss.safetensors'}}
});
const settings=(g:unknown)=>generationSettings([['prompt',JSON.stringify(g)]]);

test('linked full-schedule single-block SLG restores its literal layer string through model patches',()=>{
 const g=graph();
 expect(settings(g)).toMatchObject({checkpoint:'moss.safetensors',skipLayers:'19, 22'});
 const patched={...g,patch:{class_type:'ModelSamplingAuraFlow',inputs:{model:['slg',0],shift:3}}};
 patched.sampler.inputs.model=['patch',0];
 expect(settings(patched)).toHaveProperty('skipLayers','19, 22');
});
test('an empty single-layer patch is a supported no-op',()=>{
 const g=graph();g.slg.inputs.single_layers='';
 expect(settings(g)).not.toHaveProperty('skipLayers');expect(settings(g)).not.toHaveProperty('skipped');
});
test('unlinked SLG cannot supply skip layers',()=>{
 const g=graph();g.sampler.inputs.model=['model',0];
 expect(settings(g)).not.toHaveProperty('skipLayers');
});
test.each([
 {double_layers:'1'}, {start_percent:0.1}, {end_percent:0.9}, {single_layers:['linked',0]}, {single_layers:'-1'}, {single_layers:'19;22'}
])('unrepresentable linked SLG is disclosed instead of approximated (%j)',change=>{
 const g=graph();Object.assign(g.slg.inputs,change);
 expect(settings(g)).not.toHaveProperty('skipLayers');
 expect(settings(g)?.skipped).toContain('skipLayers');
});
test('multiple linked SLG patches, wrong output ports and unresolved models are disclosed',()=>{
 const g=graph();
 const multiple={...g,outer:{...g.slg,inputs:{...g.slg.inputs,model:['slg',0]}}};multiple.sampler.inputs.model=['outer',0];
 expect(settings(multiple)).not.toHaveProperty('skipLayers');expect(settings(multiple)?.skipped).toContain('skipLayers');
 g.sampler.inputs.model=['slg',1];
 expect(settings(g)).not.toHaveProperty('skipLayers');expect(settings(g)?.skipped).toContain('skipLayers');
 g.sampler.inputs.model=['slg',0];g.slg.inputs.model=['missing',0];
 expect(settings(g)).not.toHaveProperty('skipLayers');expect(settings(g)?.skipped).toContain('skipLayers');
});
