import { useRef, type MouseEvent, type PointerEvent } from 'react';
export function useDialogBackdropClose(close:()=>void) {
 const startedOutside=useRef(false);
 const outside=(e:MouseEvent<HTMLDialogElement>|PointerEvent<HTMLDialogElement>)=>{const box=e.currentTarget.getBoundingClientRect();return e.target===e.currentTarget&&(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom);};
 return {onPointerDown:(e:PointerEvent<HTMLDialogElement>)=>{startedOutside.current=outside(e);},onClick:(e:MouseEvent<HTMLDialogElement>)=>{const dismiss=startedOutside.current&&outside(e);startedOutside.current=false;if(dismiss)close();}};
}
