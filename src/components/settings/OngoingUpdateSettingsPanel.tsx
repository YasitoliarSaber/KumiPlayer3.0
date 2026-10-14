import { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Input, Option, Switch } from '@fluentui/react-components';
import type { PublicConfig } from '../../api/config';
import { SettingsField } from '../ui/SettingsPrimitives';
import ActionToast from '../ui/ActionToast';

type UpdateSettings = Pick<PublicConfig, 'ongoing_update_on_startup' | 'ongoing_update_interval_minutes'>;

const intervalOptions = [
  { value: 0, label: '关闭' }, { value: 15, label: '每 15 分钟' },
  { value: 30, label: '每 30 分钟' }, { value: 60, label: '每小时' },
  { value: 120, label: '每 2 小时' }, { value: 360, label: '每 6 小时' },
  { value: 720, label: '每 12 小时' }, { value: 1440, label: '每天' },
  { value: 10080, label: '每周' },
];

export default function OngoingUpdateSettingsPanel({ config, onSave, externalBusy = false, categoryName = '新番', onSaveCategoryName }: {
  config: UpdateSettings;
  onSave: (patch: UpdateSettings) => Promise<void>;
  externalBusy?: boolean;
  categoryName?: string;
  onSaveCategoryName?: (name: string) => string;
}) {
  const [nameDraft, setNameDraft] = useState(categoryName);
  useEffect(() => setNameDraft(categoryName), [categoryName]);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const interval = config.ongoing_update_interval_minutes ?? 0;
  const options = intervalOptions.some(option => option.value === interval)
    ? intervalOptions : [...intervalOptions, { value: interval, label: `每 ${interval} 分钟` }].sort((a, b) => a.value - b.value);
  const disabled = saving || externalBusy;

  const saveName = () => {
    if (disabled || !onSaveCategoryName) return;
    try {
      setNameDraft(onSaveCategoryName(nameDraft));
      setFailed(false);
      setNotice('分类名称已保存');
    } catch (cause) {
      setFailed(true);
      setNotice(`保存失败：${cause instanceof Error ? cause.message : '请稍后重试'}`);
    }
  };

  const save = async (patch: UpdateSettings) => {
    if (pending.current || externalBusy) return;
    const minutes = patch.ongoing_update_interval_minutes;
    if (minutes !== undefined && (!Number.isInteger(minutes) || (minutes !== 0 && (minutes < 15 || minutes > 10080)))) {
      setFailed(true);
      setNotice('更新间隔应为关闭，或 15 到 10080 分钟。');
      return;
    }
    pending.current = true;
    setSaving(true);
    setNotice('');
    setFailed(false);
    try {
      await onSave(patch);
      setNotice('新番更新设置已保存');
    } catch (cause) {
      setFailed(true);
      setNotice(`保存失败：${cause instanceof Error ? cause.message : '请稍后重试'}`);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return <div className="kp-settings-form sources-ongoing-settings">
    <SettingsField label="分类名称" className="settings-config-row sources-ongoing-short-field" description="最多 24 个字符，留空恢复“新番”。"
      action={<Button appearance="secondary" aria-label="保存分类名称" disabled={disabled || !onSaveCategoryName} onClick={saveName}>保存</Button>}>
      <Input value={nameDraft} placeholder="新番" maxLength={48} disabled={disabled}
        onChange={(_, data) => setNameDraft(Array.from(data.value).slice(0, 24).join(''))}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveName(); } }} />
    </SettingsField>
      <Switch className="settings-toggle-row" label="启动时更新新番" checked={config.ongoing_update_on_startup ?? false} disabled={disabled}
        onChange={(_, data) => void save({ ongoing_update_on_startup: data.checked })} />
    <SettingsField label="新番更新间隔" className="settings-config-row sources-ongoing-short-field" description="仅更新新番来源；TXT 需手动导入新清单。">
      <Dropdown value={options.find(option => option.value === interval)?.label || ''} selectedOptions={[String(interval)]} disabled={disabled}
        onOptionSelect={(_, data) => { if (data.optionValue !== undefined) void save({ ongoing_update_interval_minutes: Number(data.optionValue) }); }}>
        {options.map(option => <Option value={String(option.value)} key={option.value}>{option.label}</Option>)}
      </Dropdown>
    </SettingsField>
    <ActionToast message={notice} intent={failed ? 'error' : 'success'} onDismiss={() => setNotice('')} />
  </div>;
}
