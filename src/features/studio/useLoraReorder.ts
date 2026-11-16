import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { SelectedLora } from './LoraSetsDialog';

/** Pointer capture works inside native WebViews without handing the drag to the OS. */
export function useLoraReorder(selected:SelectedLora[],onChange:(value:SelectedLora[])=>void,onMoved:(name:string,position:number)=>void) {
 const panel=useRef<HTMLDivElement>(null);
 const current=useRef({selected,onChange,onMoved});current.current={selected,onChange,onMoved};
 const drag=useRef<{name:string;pointer:number;handle:HTMLButtonElement;capture:HTMLElement;x:number;y:number;startY:number;order:string[];moving:boolean}|null>(null);
 const frame=useRef(0);const previousFrame=useRef(0);const [dragging,setDragging]=useState('');
 const move=(name:string,index:number)=>{const {selected,onChange,onMoved}=current.current;const from=selected.findIndex(l=>l.name===name);if(from<0)return;index=Math.max(0,Math.min(index,selected.length-1));if(from===index)return;const next=[...selected];next.splice(index,0,next.splice(from,1)[0]);current.current.selected=next;onChange(next);onMoved(name,index+1);};
 const place=()=>{const active=drag.current,element=panel.current;if(!active?.moving||!element)return;const bounds=element.getBoundingClientRect();if(active.x<bounds.left||active.x>bounds.right)return;const rows=Array.from(element.querySelectorAll<HTMLElement>('[data-lora-row]')).filter(row=>row.dataset.loraRow!==active.name);const index=rows.findIndex(row=>{const box=row.getBoundingClientRect();return active.y<box.top+box.height/2;});move(active.name,index<0?rows.length:index);};
 const finish=(cancel=false)=>{const active=drag.current;drag.current=null;cancelAnimationFrame(frame.current);frame.current=0;previousFrame.current=0;setDragging('');if(!active)return;if(active.capture.hasPointerCapture?.(active.pointer))active.capture.releasePointerCapture(active.pointer);if(cancel&&active.moving){const {selected,onChange}=current.current;const byName=new Map(selected.map(l=>[l.name,l]));const restored=[...active.order.flatMap(name=>byName.has(name)?[byName.get(name)!]:[]),...selected.filter(l=>!active.order.includes(l.name))];current.current.selected=restored;onChange(restored);}};
 const tick=(time:number)=>{const active=drag.current,element=panel.current;if(!active||!element)return;const dt=previousFrame.current?Math.min(32,time-previousFrame.current):16;previousFrame.current=time;if(active.moving){const bounds=element.getBoundingClientRect(),edge=Math.min(48,bounds.height/4);if(active.x>=bounds.left&&active.x<=bounds.right){const speed=active.y<bounds.top+edge?-Math.min(1,(bounds.top+edge-active.y)/edge):active.y>bounds.bottom-edge?Math.min(1,(active.y-bounds.bottom+edge)/edge):0;element.scrollTop+=speed*700*dt/1000;place();}}frame.current=requestAnimationFrame(tick);};
 useEffect(()=>{const blur=()=>finish(true);window.addEventListener('blur',blur);return()=>{window.removeEventListener('blur',blur);const active=drag.current;drag.current=null;cancelAnimationFrame(frame.current);if(active?.capture.hasPointerCapture?.(active.pointer))active.capture.releasePointerCapture(active.pointer);};},[]);
 useEffect(()=>{if(drag.current&&!selected.some(l=>l.name===drag.current?.name))finish();},[selected]);
 return {panel,dragging,handle:(name:string)=>({
  onPointerDown:(event:PointerEvent<HTMLButtonElement>)=>{if(event.button!==0||drag.current)return;event.preventDefault();event.currentTarget.focus();const capture=panel.current??event.currentTarget;capture.setPointerCapture?.(event.pointerId);drag.current={name,capture,pointer:event.pointerId,handle:event.currentTarget,x:event.clientX,y:event.clientY,startY:event.clientY,order:current.current.selected.map(l=>l.name),moving:false};frame.current=requestAnimationFrame(tick);},
  onKeyDown:(event:KeyboardEvent<HTMLButtonElement>)=>{if(event.key==='Escape'&&drag.current){event.preventDefault();event.stopPropagation();finish(true);return;}if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();const index=current.current.selected.findIndex(l=>l.name===name);move(name,index+(event.key==='ArrowUp'?-1:1));}},
 }),events:{
  onPointerMove:(event:PointerEvent<HTMLDivElement>)=>{const active=drag.current;if(!active||active.pointer!==event.pointerId)return;active.x=event.clientX;active.y=event.clientY;if(!active.moving&&Math.abs(active.y-active.startY)>=4){active.moving=true;setDragging(active.name);}place();},
  onPointerUp:(event:PointerEvent<HTMLDivElement>)=>{if(drag.current?.pointer===event.pointerId){place();finish();}},
  onPointerCancel:()=>finish(true),onLostPointerCapture:()=>{if(drag.current)finish(true);},
 }};
}
