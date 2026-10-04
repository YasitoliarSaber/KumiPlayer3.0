import { Input, Select } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SettingsFeedback, SettingsField, SettingsSection } from '../../src/components/ui/SettingsPrimitives';

test('设置分组使用可访问标题，输入框关联标签和帮助文字', () => {
  render(<SettingsSection title="播放设置">
    <SettingsField label="播放器路径" description="选择已有的 MPV。" action={<button>选择</button>}>
      <Input />
    </SettingsField>
  </SettingsSection>);
  const input = screen.getByRole('textbox', { name: '播放器路径' });
  expect(screen.getByRole('region', { name: '播放设置' })).toContainElement(input);
  expect(input).toHaveAccessibleDescription('选择已有的 MPV。');
  expect(screen.getByRole('button', { name: '选择' })).toBeEnabled();
});

test('禁用选择框仍保留标签和帮助文字', () => {
  render(<SettingsField label="质量" description="关闭效果时无需选择质量。">
    <Select disabled><option>均衡</option></Select>
  </SettingsField>);
  const select = screen.getByRole('combobox', { name: '质量' });
  expect(select).toBeDisabled();
  expect(select).toHaveAccessibleDescription('关闭效果时无需选择质量。');
});

test('普通反馈温和通知，错误反馈立即通知，长消息保留完整内容', () => {
  const message = '保存失败：连接中断，请稍后重新保存。';
  const { rerender } = render(<SettingsFeedback intent="success">已保存</SettingsFeedback>);
  expect(screen.getByRole('status')).toHaveTextContent('已保存');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  rerender(<SettingsFeedback intent="error">{message}</SettingsFeedback>);
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
