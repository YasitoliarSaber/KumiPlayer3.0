import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import HomePage from '../../src/pages/HomePage';

const fixture = vi.hoisted(() => ({
  works: Array.from({length: 8}, (_, index) => ({work_id:`work-${index}`,title:`作品${index}`,year:2026,rating:8,
    media_type:'tv',show_type:'anime_series',seasons:[],assets:[],poster_path:`/fixture/${index}.jpg`,fanart_path:`/fixture/${index}-wide.jpg`})),
  history: [], loading: false, error: null, openWorkDetail:vi.fn(),getWorkDetail:vi.fn(async()=>({})),
}));
vi.mock('../../src/stores/library',()=>({useLibraryStore:(select:(value:unknown)=>unknown)=>select(fixture)}));
vi.mock('../../src/stores/ui',()=>({useUiStore:()=>({goCategory:vi.fn(),goManage:vi.fn(),source:'all',sort:'recent'})}));
vi.mock('../../src/components/library/PosterCard',()=>({default:()=>null}));

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

test('系统减少动态效果时不自动轮播，但保留手动切换',()=>{
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
  const start=vi.spyOn(window,'setInterval');
  render(<HomePage/>);
  expect(screen.getByRole('button',{name:'下一部'})).toBeEnabled();
  expect(start).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:'暂停自动推荐'})).not.toBeInTheDocument();
});

test('用户可以暂停和恢复自动推荐',()=>{
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
  const stop=vi.spyOn(window,'clearInterval');
  render(<HomePage/>);
  fireEvent.click(screen.getByRole('button',{name:'暂停自动推荐'}));
  expect(stop).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'恢复自动推荐'}));
  expect(screen.getByRole('button',{name:'暂停自动推荐'})).toBeEnabled();
});
