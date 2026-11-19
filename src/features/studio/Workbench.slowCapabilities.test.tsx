import { evidence } from './Workbench.testHarness';
import { act, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';

afterEach(()=>{vi.useRealTimers();});

// #39: object_info answers slower than the 3 s poll must not be superseded and re-requested forever.
test('a capability read slower than the poll is joined, accepted, and ends the poll',async()=>{
 vi.useFakeTimers();
 let answer:(value:typeof evidence)=>void=()=>{};
 vi.mocked(checkRecipePrerequisites).mockImplementation(()=>new Promise(resolve=>{answer=resolve;}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{}}/></I18nProvider>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 // Three poll ticks passed while the first read was pending; none of them queued another request.
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
 await act(async()=>{answer(evidence);await vi.advanceTimersByTimeAsync(0);});
 await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 // The late answer was accepted, so the waiting poll stopped instead of asking again.
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
});

test('a failed capability read is retried one at a time',async()=>{
 vi.useFakeTimers();
 const pending:((reason:Error)=>void)[]=[];
 vi.mocked(checkRecipePrerequisites).mockImplementation(()=>new Promise((_,reject)=>{pending.push(reject);}));
 render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{}}/></I18nProvider>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(7_000);});
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(1);
 await act(async()=>{pending[0](new Error('BACKEND_TIMEOUT: slow'));await vi.advanceTimersByTimeAsync(3_000);});
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(2);
 await act(async()=>{await vi.advanceTimersByTimeAsync(9_000);});
 expect(checkRecipePrerequisites).toHaveBeenCalledTimes(2);
});
