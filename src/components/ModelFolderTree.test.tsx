import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { ModelFolderTree } from './ModelFolderTree';
const names=['Flux\\Portraits\\a.pt','Flux\\Styles\\b.pt','SDXL/Portraits/c.pt'];
function Host(){const [selected,setSelected]=useState('');return <I18nProvider><ModelFolderTree names={names} selected={selected} onSelect={setSelected} storageKey="fixture" rootLabel="Root"/></I18nProvider>;}
beforeEach(()=>{localStorage.clear();localStorage.setItem('deas.locale.v1','en');});afterEach(cleanup);
it('collapses nested folders, selects prefixes and remembers expansion independently of selection',()=>{
 let view=render(<Host/>);expect(screen.queryByRole('treeitem',{name:'Styles'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Expand Flux'}));fireEvent.click(screen.getByRole('treeitem',{name:'Styles'}));
 expect(screen.getByRole('treeitem',{name:'Styles'}).getAttribute('data-folder-path')).toBe('Flux/Styles');
 expect(screen.getByRole('treeitem',{name:'Styles'}).getAttribute('aria-selected')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:'Collapse Flux'}));expect(screen.queryByRole('treeitem',{name:'Styles'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Expand Flux'}));view.unmount();view=render(<Host/>);
 expect(screen.getByRole('treeitem',{name:'Styles'})).toBeTruthy();expect(names[0]).toBe('Flux\\Portraits\\a.pt');
});
it('supports arrow-key expansion and folder focus',()=>{
 render(<Host/>);const flux=screen.getByRole('treeitem',{name:'Flux'});flux.focus();fireEvent.keyDown(flux,{key:'ArrowRight'});
 expect(flux.getAttribute('aria-expanded')).toBe('true');fireEvent.keyDown(flux,{key:'ArrowRight'});
 expect(document.activeElement).toHaveProperty('textContent','Portraits1');fireEvent.keyDown(document.activeElement!,{key:'ArrowLeft'});
 expect(document.activeElement).toBe(flux);fireEvent.keyDown(flux,{key:'ArrowLeft'});expect(flux.getAttribute('aria-expanded')).toBe('false');
});
