import {expect,test} from 'vitest';
import fixture from '../../tests/fixtures/lying-sigma.json';
import {generationSettings} from './imageMetadata';

test('embedded graph restores the selected sampler and exact linked Lying Sigma values',()=>{
 const settings=generationSettings([['prompt',JSON.stringify(fixture.graph)]]);
 expect(settings).toMatchObject({sampler:'euler',scheduler:'normal',steps:20,seed:123,lyingSigma:fixture.intent.lyingSigma});
 const legacy=structuredClone(fixture.graph);
 legacy.LS.class_type='LyingSigmaSampler';
 expect(generationSettings([['prompt',JSON.stringify(legacy)]])).toMatchObject({sampler:'euler',lyingSigma:fixture.intent.lyingSigma});
});
test('unrelated nodes cannot supply Lying Sigma settings; malformed linked values are disclosed',()=>{
 const graph=structuredClone(fixture.graph);
 graph['5'].inputs.sampler=['LSQ',0];
 expect(generationSettings([['prompt',JSON.stringify(graph)]])).not.toHaveProperty('lyingSigma');
 graph['5'].inputs.sampler=['LS',0];
 graph.LS.inputs.start_percent=0.95;
 const settings=generationSettings([['prompt',JSON.stringify(graph)]]);
 expect(settings).not.toHaveProperty('lyingSigma');
 expect(settings?.skipped).toContain('lyingSigma');
});
