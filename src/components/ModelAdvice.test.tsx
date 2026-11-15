import {cleanup, render} from '@testing-library/react';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {I18nProvider, LOCALE_STORAGE_KEY} from '../i18n/I18nProvider';
import type {ModelCheck} from '../lib/modelCheck';
import {ModelAdvice} from './ModelAdvice';

beforeEach(()=>localStorage.setItem(LOCALE_STORAGE_KEY,'en'));
afterEach(()=>{cleanup();localStorage.clear();});
const base:ModelCheck={identity:'unverified',compatibility:'unknown',availability:'available',evidence:[],reasons:[{code:'unverified'}]};

test.each(['suitable','unknown'] as const)('hides generic %s model advice without changing the check',compatibility=>{
 const check={...base,compatibility};
 const {container}=render(<I18nProvider><ModelAdvice check={check}/></I18nProvider>);
 expect(container.textContent).toBe('');
 expect(check.reasons).toEqual([{code:'unverified'}]);
});

test.each([
 {...base,compatibility:'blocked',reasons:[{code:'integrity'}]},
 {...base,availability:'missing',reasons:[{code:'missingLoader',detail:'VAELoader'}]},
 {...base,reasons:[{code:'pickleFormat'}]},
] satisfies ModelCheck[])('preserves actionable advice: %j',check=>{
 const {container}=render(<I18nProvider><ModelAdvice check={check}/></I18nProvider>);
 expect(container.querySelector('[data-model-check]')).not.toBeNull();
});
