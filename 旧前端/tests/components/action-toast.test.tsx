import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ActionToast from '../../src/components/ui/ActionToast';

test('浮动反馈可关闭，关闭不会影响父组件或重新显示旧消息', () => {
  const onDismiss = vi.fn();
  const view = render(<ActionToast message="配置已保存" intent="success" onDismiss={onDismiss} />);
  expect(screen.getByRole('status')).toHaveTextContent('配置已保存');
  expect(document.body.querySelector('.kp-action-toast')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
  expect(onDismiss).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(<ActionToast message="配置已保存" intent="success" onDismiss={onDismiss} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.rerender(<ActionToast message="另一项配置已保存" intent="success" onDismiss={onDismiss} />);
  expect(screen.getByRole('status')).toHaveTextContent('另一项配置已保存');
});

test('同时存在多个反馈时只显示最新消息，关闭后不复活旧消息', () => {
  const older = render(<ActionToast message="旧的连接信息" />);
  const latest = render(<ActionToast message="新的连接失败" intent="error" />);
  expect(screen.queryByText('旧的连接信息')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('新的连接失败');
  older.unmount();
  expect(screen.getByRole('alert')).toHaveTextContent('新的连接失败');
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('旧的连接信息')).not.toBeInTheDocument();
  latest.unmount();
});

test('新组件清空或卸载后不遮蔽下一次反馈', () => {
  const first = render(<ActionToast message="第一次反馈" />);
  first.rerender(<ActionToast message="" />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  const next = render(<ActionToast message="后续反馈" />);
  first.unmount();
  expect(screen.getByRole('status')).toHaveTextContent('后续反馈');
  next.unmount();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
