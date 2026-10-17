import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@fluentui/react-components';
import { Folder, Pencil, Plus, Trash2 } from 'lucide-react';
import type { PublicConfig } from '../../api/config';
import { localPathKey, localRootRecords } from '../../api/localRoots';
import { SettingsField } from '../ui/SettingsPrimitives';
import ActionToast from '../ui/ActionToast';
import FolderPathInput from './FolderPathInput';

type Draft = { key: string; name: string; path: string };
const snapshot = (rows: Draft[]) => JSON.stringify(rows.map(({ name, path }) => ({ name, path })));
const fromConfig = (config: PublicConfig): Draft[] => localRootRecords(config).map(row => ({ key: row.root_id, name: row.name, path: row.path }));

export default function LocalRootsPanel({ config, onSave, externalBusy = false }: {
  config: PublicConfig;
  onSave: (patch: Partial<PublicConfig>) => Promise<boolean>;
  externalBusy?: boolean;
}) {
  const [draft, setDraft] = useState(() => fromConfig(config));
  const [saved, setSaved] = useState(() => snapshot(fromConfig(config)));
  const [confirmKey, setConfirmKey] = useState('');
  const [editingKey, setEditingKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const counter = useRef(0);
  const dirty = snapshot(draft) !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const configured = snapshot(fromConfig(config));
  useEffect(() => {
    if (lock.current) return;
    setSaved(configured);
    if (!dirtyRef.current) setDraft(fromConfig(config));
  }, [configured]);

  const update = (key: string, patch: Partial<Draft>) => {
    setDraft(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
    setError('');
  };
  const save = async () => {
    if (lock.current || externalBusy || !dirty) return;
    const paths = new Set<string>();
    for (const row of draft) {
      if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/i.test(row.path.trim())) {
        setError('请选择完整的本地目录路径。'); return;
      }
      const key = localPathKey(row.path);
      if (paths.has(key)) { setError('这个目录已经登记，请保留一条。'); return; }
      paths.add(key);
      if (Array.from(row.name.trim()).length > 24) { setError('目录名称最多 24 个字符。'); return; }
    }
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const rows = draft.map(row => ({ ...row, path: row.path.trim(), name: row.name.trim() || Array.from(row.path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '本地媒体库').slice(0, 24).join('') }));
      const ok = await onSave({ local_roots: rows.map(row => ({ root_id: '', name: row.name, path: row.path })) });
      if (ok) { setDraft(rows); setSaved(snapshot(rows)); setConfirmKey(''); }
    } catch { setError('本地目录未能保存，请重试。'); }
    finally { lock.current = false; setSaving(false); }
  };
  const busy = saving || externalBusy;
  return <div className="sources-root-panel sources-local-roots">
    {draft.map((row, index) => <div className="sources-local-root" key={row.key}>
      <div className="sources-local-root-heading">
        <Folder className="sources-local-root-icon" size={20} aria-hidden="true" />
        <div className="sources-local-root-copy">
          <div className="sources-local-root-title"><strong>{row.name || '新目录'}</strong>{index === 0 && <span className="sources-local-root-default">默认</span>}</div>
          <p className="sources-local-root-path">{row.path || '尚未选择文件夹'}</p>
        </div>
        <div className="sources-local-root-actions">
          <Button appearance="subtle" size="small" disabled={busy} icon={<Pencil size={16} />} aria-label={`编辑${row.name || `目录 ${index + 1}`}`} aria-expanded={editingKey === row.key} onClick={() => setEditingKey(editingKey === row.key ? '' : row.key)}>{editingKey === row.key ? '收起' : '编辑'}</Button>
          <Button appearance="subtle" size="small" disabled={busy} icon={<Trash2 size={16} />} aria-label={`移除${row.name || `目录 ${index + 1}`}`} title="移除登记" onClick={() => setConfirmKey(row.key)} />
        </div>
      </div>
      {confirmKey === row.key && <div className="sources-local-root-confirm sources-openlist-actions">
          <span>移除这条登记？</span><Button size="small" appearance="secondary" disabled={busy} onClick={() => { setDraft(rows => rows.filter(item => item.key !== row.key)); setConfirmKey(''); }}>确认移除</Button>
          <Button size="small" appearance="subtle" disabled={busy} onClick={() => setConfirmKey('')}>取消</Button>
      </div>}
      {editingKey === row.key && <div className="sources-local-root-editor">
        <SettingsField label="名称" className="sources-local-root-name"><Input aria-label={`目录 ${index + 1} 名称`} value={row.name} disabled={busy} placeholder="例如 动画库" onChange={(_, data) => update(row.key, { name: Array.from(data.value).slice(0, 24).join('') })} /></SettingsField>
        <SettingsField label="路径"><FolderPathInput multiline label={`目录 ${index + 1} 路径`} value={row.path} disabled={busy} onChange={path => update(row.key, { path })} /></SettingsField>
      </div>}
    </div>)}
    <div className="sources-local-root-footer">
      <Button appearance="subtle" icon={<Plus size={16} />} disabled={busy || draft.length >= 24} onClick={() => { const key = `draft-${++counter.current}`; setDraft(rows => [...rows, { key, name: '', path: '' }]); setEditingKey(key); setError(''); }}>添加本地目录</Button>
      <div className="sources-openlist-actions">
      {dirty && <span className="sources-dirty-hint">有未保存的更改</span>}
      <Button appearance="primary" disabled={busy || !dirty} onClick={() => void save()}>{saving ? '正在保存…' : '保存本地目录'}</Button>
      </div>
    </div>
    <ActionToast message={error} intent="error" onDismiss={() => setError('')} />
  </div>;
}
