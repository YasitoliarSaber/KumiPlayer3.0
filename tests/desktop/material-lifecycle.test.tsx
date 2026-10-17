import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiquidSurface } from '../../src/renderer/shared/ui/LiquidSurface';
import { MaterialPreferences } from '../../src/renderer/features/settings/MaterialPreferences';
import { getDemoState, resetDemoState, updateDemoState } from '../../src/renderer/mock/demo-store';

const { create, destroy } = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn() }));
vi.mock('quick-liquid/core', () => ({
  LiquidGlassEngine: class {
    constructor(...args: unknown[]) { create(...args); }
    destroy() { destroy(); }
  },
}));

let reducedTransparency = false;
let forcedColors = false;
const listeners = new Set<() => void>();
beforeEach(() => {
  resetDemoState();
  create.mockClear();
  destroy.mockClear();
  listeners.clear();
  reducedTransparency = false;
  forcedColors = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('transparency') ? reducedTransparency : forcedColors; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
});
afterEach(() => { resetDemoState(); vi.unstubAllGlobals(); });

function material(value: 'solid' | 'mica' | 'acrylic' | 'liquid') {
  act(() => updateDemoState((current) => ({ settings: {
    ...current.settings, appearance: { ...current.settings.appearance, material: value },
  } })));
}

describe('材质的资源边界', () => {
  it.each(['solid', 'mica', 'acrylic'] as const)('%s 不创建折射引擎', async (value) => {
    material(value);
    const view = render(<LiquidSurface />);
    expect(view.container.querySelector('[data-liquid-ready]')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('液态玻璃关闭持续特效，切回纯色销毁实例并退订', async () => {
    material('liquid');
    const view = render(<LiquidSurface />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      cursorTracking: false, parallax: false, inertia: false, dynamicLighting: false,
      chromaticAberration: 0, quality: 'low',
    });
    expect(view.container.firstChild).toHaveAttribute('aria-hidden', 'true');
    material('solid');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('减少透明度与高对比模式阻止引擎，并能在偏好改变时清理', async () => {
    reducedTransparency = true;
    material('liquid');
    const view = render(<LiquidSurface />);
    await act(async () => { await Promise.resolve(); });
    expect(create).not.toHaveBeenCalled();
    reducedTransparency = false;
    await act(async () => { listeners.forEach((listener) => listener()); });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    forcedColors = true;
    await act(async () => { listeners.forEach((listener) => listener()); });
    expect(destroy).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it('卸载期间的异步模块加载不能留下实例', async () => {
    material('liquid');
    const view = render(<LiquidSurface />);
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(create).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('四种材质和字体写入本机偏好，切换不重置其他外观字段', () => {
    render(<MaterialPreferences />);
    fireEvent.click(screen.getByRole('radio', { name: '液态玻璃', exact: true }));
    fireEvent.click(screen.getByRole('radio', { name: '霞鹜文楷', exact: true }));
    expect(getDemoState().settings.appearance).toMatchObject({ material: 'liquid', font: 'wenkai', theme: 'mica' });
    expect(JSON.parse(localStorage.getItem('kumiplayer-demo-v1')!).settings.appearance.font).toBe('wenkai');
    expect(screen.getAllByRole('radio').length).toBe(7);
  });
});
