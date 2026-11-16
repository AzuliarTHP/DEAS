import { render,fireEvent,cleanup } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { useDialogBackdropClose } from './useDialogBackdropClose';
afterEach(cleanup);
it('closes only when both press and click are outside the dialog bounds',()=>{
 const close=vi.fn();function Host(){const props=useDialogBackdropClose(close);return <dialog open {...props}><button>Inside</button></dialog>;}
 const view=render(<Host/>);const dialog=view.container.querySelector('dialog')!;
 dialog.getBoundingClientRect=()=>({left:100,right:300,top:100,bottom:300} as DOMRect);
 const down=(x:number)=>fireEvent(dialog,new MouseEvent('pointerdown',{bubbles:true,clientX:x,clientY:150}));
 down(150);fireEvent.click(dialog,{clientX:150,clientY:150});expect(close).not.toHaveBeenCalled();
 down(150);fireEvent.click(dialog,{clientX:50,clientY:150});expect(close).not.toHaveBeenCalled();
 down(50);fireEvent.click(dialog,{clientX:50,clientY:150});expect(close).toHaveBeenCalledTimes(1);
});
