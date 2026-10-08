import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { attachPosterWheelSmoothing } from '../../src/utils/posterWheelSmoothing';

let main: HTMLElement;
let wall: HTMLElement;
let detach: () => void;
let frames: Map<number, FrameRequestCallback>;
let clock: number;
let frameId: number;

beforeEach(() => {
  main = document.createElement('main');
  wall = document.createElement('div');
  main.append(wall);
  document.body.append(main);
  Object.defineProperty(main, 'clientHeight', { value: 800 });
  Object.defineProperty(main, 'scrollHeight', { value: 10000 });
  frames = new Map();
  clock = 0;
  frameId = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  detach = attachPosterWheelSmoothing(main, wall);
});

afterEach(() => { detach(); main.remove(); delete document.documentElement.dataset.motion; });

function wheel(deltaY: number, options: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...options });
  wall.dispatchEvent(event);
  return event;
}

function advance(ms = 16) {
  clock += ms;
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach(callback => callback(clock));
}

test('静止时没有动画，普通滚轮只排一个帧并在短缓动后完全停止', () => {
  expect(frames.size).toBe(0);
  expect(wheel(100).defaultPrevented).toBe(true);
  expect(main.scrollTop).toBe(0);
  expect(frames.size).toBe(1);
  advance();
  expect(main.scrollTop).toBeGreaterThan(0);
  expect(main.scrollTop).toBeLessThan(100);
  for (let i = 0; i < 20; i++) advance();
  expect(main.scrollTop).toBe(100);
  expect(frames.size).toBe(0);
});

test('合并缓动目标且反向输入立即停止旧方向，不排多个动画', () => {
  wheel(100); wheel(100);
  expect(frames.size).toBe(1);
  advance();
  const before = main.scrollTop;
  wheel(-40);
  for (let i = 0; i < 20; i++) advance();
  expect(main.scrollTop).toBeCloseTo(before - 40);
  expect(frames.size).toBe(0);
});

test('快速滚动交给原生，取消旧动画并交付已经接收的剩余距离', () => {
  wheel(100);
  expect(wheel(800).defaultPrevented).toBe(false);
  expect(main.scrollTop).toBe(100);
  expect(frames.size).toBe(0);
  expect(wheel(100).defaultPrevented).toBe(false);
});

test('帧耗时过高立即交付目标并冷却，优先恢复原生滚动', () => {
  wheel(100);
  advance(60);
  expect(main.scrollTop).toBe(100);
  expect(frames.size).toBe(0);
  expect(wheel(100).defaultPrevented).toBe(false);
});

test.each([
  { ctrlKey: true }, { shiftKey: true }, { deltaX: 100 }, { cancelable: false },
  { deltaY: 1.5 },
])('缩放、横向、触控板细小增量与不可取消事件保持原生：%j', options => {
  expect(wheel(100, options).defaultPrevented).toBe(false);
  expect(frames.size).toBe(0);
});

test('减少动态效果时不接管滚轮，作品墙外的控件也不接管', () => {
  document.documentElement.dataset.motion = 'reduced';
  expect(wheel(100).defaultPrevented).toBe(false);
  delete document.documentElement.dataset.motion;
  const outside = document.createElement('div');
  main.append(outside);
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
  outside.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(frames.size).toBe(0);
});

test('滚动条拖动、键盘与外部跳转都能终止缓动，卸载清理全部帧', () => {
  wheel(100);
  main.dispatchEvent(new PointerEvent('pointerdown'));
  expect(frames.size).toBe(0);
  wheel(100);
  main.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
  expect(frames.size).toBe(0);
  wheel(100);
  main.scrollTop = 1200;
  main.dispatchEvent(new Event('scroll'));
  expect(frames.size).toBe(0);
  wheel(100);
  detach();
  expect(frames.size).toBe(0);
  expect(wheel(100).defaultPrevented).toBe(false);
});
