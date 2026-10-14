import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, Switch } from '@fluentui/react-components';
import { SettingsFeedback, SettingsSection } from '../ui/SettingsPrimitives';
import { getWindowPreferences, hideToTray, saveWindowPreferences, type WindowPreferences } from '../../platform/windowPreferences';
import ActionToast from '../ui/ActionToast';

export default function WindowSettingsPanel({ active = true }: { active?: boolean }) {
  const [preferences, setPreferences] = useState<WindowPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const saving = useRef(false);

  useEffect(() => {
    let disposed = false;
    void getWindowPreferences().then(value => {
      if (!disposed) setPreferences(value);
    }).catch(() => {
      if (!disposed) setError('无法读取窗口设置，请重试。');
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, []);

  const reload = async () => {
    setLoading(true);
    setError('');
    try { setPreferences(await getWindowPreferences()); }
    catch { setError('无法读取窗口设置，请重试。'); }
    finally { setLoading(false); }
  };

  const save = async (patch: Partial<WindowPreferences>) => {
    if (!preferences || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      setPreferences(await saveWindowPreferences({ ...preferences, ...patch }));
      setSaved(true);
    } catch { setError('窗口设置未能保存，请重试。'); }
    finally { saving.current = false; setBusy(false); }
  };

  const hide = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try { await hideToTray(); }
    catch { setError('无法收到托盘，请重试。'); }
    finally { saving.current = false; setBusy(false); }
  };

  return <SettingsSection title="窗口与托盘">
    {loading && <SettingsFeedback busy>正在读取窗口设置…</SettingsFeedback>}
    {preferences && <>
      <Switch label="最小化到托盘" labelPosition="before" className="settings-toggle-row" checked={preferences.minimize_to_tray} disabled={loading || busy}
        onChange={(_, data) => void save({ minimize_to_tray: data.checked })} />
      <Switch label="关闭窗口时收到托盘" labelPosition="before" className="settings-toggle-row" checked={preferences.close_to_tray} disabled={loading || busy}
        onChange={(_, data) => void save({ close_to_tray: data.checked })} />
      <p className="field-help">收到托盘后，播放和后台任务会继续运行。</p>
      <Button appearance="secondary" disabled={loading || busy} onClick={() => void hide()}
        icon={busy ? <Spinner size="tiny" /> : undefined}>立即收到托盘</Button>
    </>}
    <ActionToast message={active ? error || (saved ? '窗口设置已保存' : '') : ''} intent={error ? 'error' : 'success'} onDismiss={() => { setError(''); setSaved(false); }} />
    {!preferences && !loading && <Button appearance="secondary" onClick={() => void reload()}>重新读取</Button>}
  </SettingsSection>;
}
