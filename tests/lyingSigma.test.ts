import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/lying-sigma.json' with {type:'json'};
import {compileRecipe, type RecipeAllowlist} from '../src/lib/execution.ts';
import {defaultLyingSigma, isLyingSigma} from '../src/lib/lyingSigma.ts';
const intent=fixture.intent;
const allow:RecipeAllowlist={nodes:['KSampler',...new Set(Object.values(fixture.graph).map(n=>n.class_type)),'LoadImage','VAEEncode','ManualSigmas','DEAS_ImagePostprocessGate','ImageScale'],checkpoints:[intent.checkpoint],samplers:['euler','dpm_2','uni_pc'],schedulers:['normal'],images:['source.png']};
test('Lying Sigma matches the native shared graph fixture',()=>{
 assert.deepEqual(compileRecipe(intent,allow).graph,fixture.graph);
});
test('zero is a dependency-free exact opt-out and malformed settings are rejected',()=>{
 const {lyingSigma,...plain}=intent;
 const core={...allow,nodes:['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage']};
 assert.deepEqual(compileRecipe({...plain,lyingSigma:defaultLyingSigma},core).graph,compileRecipe(plain,core).graph);
 assert.throws(()=>compileRecipe(intent,core),{code:'MISSING_CAPABILITY'});
 const withoutWrapper={...allow,nodes:allow.nodes.filter(n=>n!=='DEAS_LyingSigmaSampler')};
 assert.throws(()=>compileRecipe(intent,withoutWrapper),{code:'MISSING_CAPABILITY',field:'DEAS_LyingSigmaSampler'});
 for(const bad of [null,false,{}, {...lyingSigma,factor:-1},{...lyingSigma,factor:NaN},{...lyingSigma,factor:'0'},{...lyingSigma,startPercent:0.9,endPercent:0.1},{...lyingSigma,endPercent:1.1},{...lyingSigma,extra:true}]){
  assert.equal(isLyingSigma(bad),false);
  assert.throws(()=>compileRecipe({...intent,lyingSigma:bad},allow),{code:'INVALID_INPUT',field:'lyingSigma'});
 }
});
test('image edits preserve denoise, latent and conditioning; refine remains unchanged',()=>{
 const {lyingSigma,...plain}=intent;
 const input={...plain,inputImage:'source.png',denoise:0.6,refine:{width:1024,height:1024,denoise:0.3}};
 const before=compileRecipe(input,allow).graph,after=compileRecipe({...input,lyingSigma},allow).graph;
 assert.equal(after.LSZ.inputs.denoise,0.6);
 assert.deepEqual(after['5'].inputs.latent_image,before['5'].inputs.latent_image);
 assert.deepEqual(after.LSG.inputs.positive,before['5'].inputs.positive);
 assert.deepEqual(after.R5,before.R5);
 assert.throws(()=>compileRecipe({...input,lyingSigma,sampler:'dpm_2'},allow),{code:'INVALID_INPUT',field:'lyingSigma'});
 assert.throws(()=>compileRecipe({...input,lyingSigma,denoise:0.00001},allow),{code:'INVALID_INPUT',field:'lyingSigma'});
});
test('an explicit schedule keeps its original sampler, noise, guider and sigma wiring',()=>{
 const {lyingSigma,...plain}=intent;
 const input={...plain,sampler:'dpm_2',steps:2,sigmas:[1,0.5,0]};
 const before=compileRecipe(input,allow).graph,after=compileRecipe({...input,lyingSigma},allow).graph;
 assert.deepEqual(after.LS.inputs.sampler,['Q',0]);
 for(const id of ['N','G','Q','Z'])assert.deepEqual(after[id],before[id]);
 assert.deepEqual(after['5'].inputs.sigmas,before['5'].inputs.sigmas);
 assert.equal(after.LSZ,undefined);
});
test('Anima image edits keep the patched LoRA model and inpaint mask wiring',()=>{
 const {lyingSigma,...plain}=intent;
 const input={...plain,family:'anima',diffusion:{textEncoder:'qwen.safetensors',clipType:'stable_diffusion',vae:'wan.safetensors',family:'anima'},inputImage:'source.png',denoise:0.65,inputMask:'deas-masks/12345678-1234-1234-1234-123456789abc.png',loras:[{name:'style.safetensors',strength:0.7}],options:{attention:'pytorch'}};
 const capable={...allow,nodes:[...allow.nodes,'UNETLoader','CLIPLoader','VAELoader','LoraLoader','LoadImageMask','SetLatentNoiseMask','ImageCompositeMasked','ModelAttentionBackend'],diffusionModels:[intent.checkpoint],textEncoders:['qwen.safetensors'],clipTypes:['stable_diffusion'],vaes:['wan.safetensors'],loras:['style.safetensors'],attention:['pytorch']};
 const before=compileRecipe(input,capable).graph,after=compileRecipe({...input,lyingSigma},capable).graph;
 assert.deepEqual(after.LSG.inputs.model,before['5'].inputs.model);
 assert.deepEqual(after.LSG.inputs.positive,before['5'].inputs.positive);
 assert.deepEqual(after.LSG.inputs.negative,before['5'].inputs.negative);
 assert.deepEqual(after['5'].inputs.latent_image,before['5'].inputs.latent_image);
 assert.deepEqual(after.Y,before.Y);
 assert.equal(after.LSZ.inputs.denoise,0.65);
});
