import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Textarea } from '@fluentui/react-components';
import { FolderOpen, Pencil } from 'lucide-react';
import { pickFolder } from '../../platform/folderPicker';
import '../../styles/folder-path-input.css';

/** 文件夹选择只更新草稿；保存由所在设置行或导入流程负责。 */
export default function FolderPathInput({ label, value, onChange, disabled = false, inputId, placeholder = '', compact = false, multiline = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputId?: string;
  placeholder?: string;
  compact?: boolean;
  multiline?: boolean;
}) {
  const errorId = useId();
  const alive = useRef(true);
  const choosingRef = useRef(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const choose = async () => {
    if (choosingRef.current || disabled) return;
    choosingRef.current = true;
    setChoosing(true);
    setError('');
    try {
      const selected = await pickFolder(value, `选择${label}`);
      if (alive.current && selected) onChange(selected);
    } catch {
      if (alive.current) setError('无法打开文件夹选择器，请重试或手动输入路径。');
    } finally {
      choosingRef.current = false;
      if (alive.current) setChoosing(false);
    }
  };
  const browse = <Button appearance="secondary" icon={<FolderOpen size={16} />} aria-label={`选择${label}`} disabled={disabled || choosing} onClick={() => void choose()}>浏览…</Button>;
  return <div className={`settings-folder-field${compact ? ' settings-folder-field--compact' : ''}`}>
    {compact && !editing ? <div className="settings-folder-summary">
      <span className={`settings-folder-path${value ? '' : ' is-empty'}`}>{value || '未设置'}</span>
      <div className="settings-folder-actions">
        <Button appearance="subtle" icon={<Pencil size={16} />} aria-label={`手动输入${label}`} disabled={disabled || choosing} onClick={() => setEditing(true)}>编辑</Button>
        {browse}
      </div>
    </div> : <>
    <div className="settings-folder-input">
      {multiline || compact ? <Textarea id={inputId} aria-label={label} aria-describedby={error ? errorId : undefined} value={value} placeholder={placeholder} rows={2} resize="vertical" disabled={disabled || choosing} onChange={(_, data) => onChange(data.value.replace(/[\r\n]/g, ''))} /> : <Input id={inputId} aria-label={label} aria-describedby={error ? errorId : undefined} type="text" value={value} placeholder={placeholder} title={value || undefined} disabled={disabled || choosing} onChange={(_, data) => onChange(data.value)} />}
      {browse}
    </div>
    {compact && <Button className="settings-folder-edit-done" appearance="subtle" size="small" disabled={disabled || choosing} onClick={() => setEditing(false)}>收起编辑</Button>}
    </>}
    {error && <p id={errorId} role="alert" className="settings-folder-error">{error}</p>}
  </div>;
}
