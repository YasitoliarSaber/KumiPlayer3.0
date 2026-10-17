import { useState } from 'react';
import { Button, Checkbox, Dropdown, Input, Option } from '@fluentui/react-components';
import { SettingsField } from '../ui/SettingsPrimitives';
import ActionToast from '../ui/ActionToast';
import FolderPathInput from './FolderPathInput';
import { type OpenListDiscoverItem, type OpenListRouteItem } from '../../api/openlist';
import type { OpenListRoute, ProviderId } from '../../api/types';

/**
 * OpenList 来源目录（路由）面板（OL-4：Settings IA）。
 *
 * 职责：
 * - 刷新来源目录（discover）与保存更改；
 * - 紧凑卡片：☑ 名称 / 远端目录 / 内容提供商 / 推导本地路径（只读）；
 * - 点击「编辑」展开高级字段（显示名称 / 内容提供商 / 可作为媒体来源开关）；
 * - 有未保存更改时提示「有 N 项更改尚未保存」。
 */
const ROUTE_PROVIDER_OPTIONS: Array<{ value: ProviderId; label: string }> = [
  { value: 'pan115', label: '115 网盘' },
  { value: 'baidu', label: '百度网盘' },
  { value: 'quark', label: '夸克网盘' },
  { value: 'other', label: '其他远程来源' },
];

interface OpenListSourceRoutesProps {
  configured: boolean;
  routes: OpenListRoute[];
  draft: OpenListRouteItem[];
  discoverItems: OpenListDiscoverItem[];
  notice: string;
  busy?: string | null;
  onDiscover: () => Promise<void>;
  onSave: () => Promise<void>;
  onUpdateDraft: (prefix: string, patch: Partial<OpenListRouteItem>) => void;
}

export default function OpenListSourceRoutes({
  configured,
  routes,
  draft,
  discoverItems,
  notice,
  busy,
  onDiscover,
  onSave,
  onUpdateDraft,
}: OpenListSourceRoutesProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dirtyPrefixes, setDirtyPrefixes] = useState<Record<string, boolean>>({});
  const [actionLock, setActionLock] = useState<string | null>(null);
  const [localError, setLocalError] = useState('');

  // 新发现但尚未保存的目录（route_id 为空）本身就是待确认更改：
  // 用户确认建议提供商后必须能直接「保存更改」，不能依赖先手动改动某个字段。
  const isItemDirty = (route: OpenListRouteItem) =>
    route.route_id === '' || Boolean(dirtyPrefixes[route.remote_prefix]);

  const dirtyCount = draft.filter(isItemDirty).length;
  const isBusy = actionLock !== null || Boolean(busy);

  const toggleEdit = (prefix: string) => {
    setExpanded((current) => ({ ...current, [prefix]: !current[prefix] }));
  };

  const handleUpdate = (prefix: string, patch: Partial<OpenListRouteItem>) => {
    onUpdateDraft(prefix, patch);
    setDirtyPrefixes((current) => ({ ...current, [prefix]: true }));
  };

  const handleDiscover = async () => {
    if (actionLock) return; // 单操作锁：双击不产生并发
    setActionLock('refresh');
    setLocalError('');
    try {
      await onDiscover();
    } catch (error) {
      setLocalError((error as Error)?.message || '刷新来源目录失败');
    } finally {
      setActionLock(null);
    }
  };

  const handleSave = async () => {
    if (actionLock) return;
    setActionLock('save');
    setLocalError('');
    try {
      await onSave();
      setDirtyPrefixes({});
    } catch (error) {
      setLocalError((error as Error)?.message || '保存来源目录失败');
    } finally {
      setActionLock(null);
    }
  };

  const localPathFor = (prefix: string) =>
    routes.find((route) => route.remote_prefix === prefix)?.local_path ?? '';

  return (
    <div className="sources-routes-panel sources-route-selection">
      {!configured ? (
        <p className="settings-openlist-notice">请先保存 OpenList 连接，再刷新并配置来源目录。</p>
      ) : (
        <>
          <div className="sources-openlist-actions">
            <Button appearance="secondary" size="small" onClick={() => void handleDiscover()} disabled={isBusy}>
              {actionLock === 'refresh' ? '处理中…' : '刷新来源目录'}
            </Button>
            <Button appearance="primary" size="small" onClick={() => void handleSave()} disabled={dirtyCount === 0 || isBusy}>
              {actionLock === 'save' ? '处理中…' : '保存更改'}
            </Button>
            {dirtyCount > 0 && <span className="sources-dirty-hint">有 {dirtyCount} 项更改尚未保存。</span>}
          </div>

          <ActionToast message={localError || notice} intent={localError ? 'error' : 'info'} onDismiss={() => setLocalError('')} />
          {draft.length === 0 && discoverItems.length === 0 && (
            <p className="settings-openlist-notice">尚未读取来源目录。点击「刷新来源目录」从 OpenList 顶层读取。</p>
          )}

          <div className="settings-route-list">
            {draft.map((route) => {
              const localPath = localPathFor(route.remote_prefix);
              const isExpanded = Boolean(expanded[route.remote_prefix]);
              const isDirty = isItemDirty(route);
              const isNewItem = route.route_id === '';
              return (
                <div key={route.remote_prefix} className="sources-route-card">
                  <div className="sources-route-card-main">
                    <Checkbox className="sources-route-card-name" title="不作为媒体来源时取消勾选（仍可浏览）" checked={route.enabled} disabled={isBusy}
                      onChange={(_, data) => handleUpdate(route.remote_prefix, { enabled: data.checked === true })}
                      label={<span className="sources-route-card-copy"><strong>{route.label || route.remote_prefix}</strong><small>{route.remote_prefix}</small></span>} />
                    <Dropdown aria-label={`${route.label || route.remote_prefix}的网盘类型`} value={ROUTE_PROVIDER_OPTIONS.find(option => option.value === route.provider_id)?.label || route.provider_id}
                      selectedOptions={[route.provider_id]} disabled={isBusy} style={{ minWidth: 0 }}
                      onOptionSelect={(_, data) => { if (data.optionValue) handleUpdate(route.remote_prefix, { provider_id: data.optionValue as ProviderId }); }}>
                      {ROUTE_PROVIDER_OPTIONS.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
                    </Dropdown>
                    <Button appearance="subtle" size="small" aria-expanded={isExpanded} onClick={() => toggleEdit(route.remote_prefix)}>
                      {isExpanded ? '收起' : '编辑'}
                    </Button>
                  </div>
                  <div className="settings-config-row settings-openlist-derived">
                    <span>本地播放位置</span>
                    <output>{localPath || '尚未绑定'}</output>
                  </div>
                  {isDirty && (
                    <span className="sources-dirty-hint">
                      {isNewItem ? '新发现的目录，确认网盘类型后保存生效' : '未保存'}
                    </span>
                  )}
                  {isExpanded && (
                    <div className="sources-route-card-edit">
                      <SettingsField label="对应的本地文件夹" description={`选择挂载后与 ${route.remote_prefix} 对应的文件夹。留空沿用连接映射。`} className="settings-config-row">
                        <FolderPathInput label={`${route.label || route.remote_prefix}对应的本地文件夹`} value={route.local_root || ''} disabled={isBusy} onChange={local_root => handleUpdate(route.remote_prefix, { local_root })} />
                      </SettingsField>
                      <SettingsField label="显示名称" className="settings-config-row">
                        <Input type="text" value={route.label} disabled={isBusy} onChange={(_, data) => handleUpdate(route.remote_prefix, { label: data.value })} />
                      </SettingsField>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
