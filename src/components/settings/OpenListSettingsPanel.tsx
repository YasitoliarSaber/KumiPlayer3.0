import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input } from '@fluentui/react-components';
import { Eye, EyeOff } from 'lucide-react';
import { openlistApi, type OpenListConfigPayload, type OpenListTestConnectionPayload, type OpenListTestResult, type OpenListTelemetrySummary } from '../../api/openlist';
import type { PublicConfig } from '../../api/config';
import FolderPathInput from './FolderPathInput';
import { SettingsField } from '../ui/SettingsPrimitives';
import ActionToast from '../ui/ActionToast';

/**
 * OpenList 连接设置面板（OL-4：Settings IA）。
 *
 * 职责：
 * - 状态卡：登录信息已保存 / 连接正常 / 需要处理（准确文案，不暗示未验证为已连接）；
 * - 连接编辑区（默认折叠）：地址 / 远端根 / 挂载根 / 凭据 / WebDAV 辅助信息 / 高级设置；
 * - 按钮语义：未修改 → [检查连接]；remote-affecting 修改 → [验证并保存]；
 *   local-only 修改 → [保存设置]。
 */
export type OpenListConnectionState =
  | 'unconfigured'
  | 'saved_unverified'
  | 'checking'
  | 'connected'
  | 'credential_rejected'
  | 'root_permission_denied'
  | 'root_not_found'
  | 'network_unavailable'
  | 'rate_limited'
  | 'risk_control'
  | 'cooling_down';

export function stateLabel(state: OpenListConnectionState): string {
  switch (state) {
    case 'unconfigured':
      return '尚未配置';
    case 'saved_unverified':
      return '登录信息已保存，尚未检查当前连接';
    case 'checking':
      return '正在检查连接…';
    case 'connected':
      return 'OpenList 连接正常';
    case 'credential_rejected':
      return 'OpenList 拒绝了当前登录信息，请更新账号或密码';
    case 'root_permission_denied':
      return '已成功登录 OpenList，但当前远端根目录没有读取权限';
    case 'root_not_found':
      return '远端根目录不存在或已被移动';
    case 'network_unavailable':
      return '暂时无法访问 OpenList 服务，已保存的登录信息不会被删除';
    case 'rate_limited':
      return 'OpenList 请求过于频繁，请稍后再试';
    case 'risk_control':
    case 'cooling_down':
      return 'OpenList 请求已暂停，以避免继续触发访问保护';
    default:
      return '需要处理';
  }
}

export function buildOpenListWebdavAddress(serverUrl: string): string {
  const base = serverUrl.trim().replace(/\/+$/, '');
  if (!base) return '';
  const apiBase = base.toLowerCase().endsWith('/dav') ? base.slice(0, -4) : base;
  return `${apiBase}/dav/`;
}

// 非回环 http 才需要明文风险确认；localhost / 127.x / ::1 直接放行
export function isNonLoopbackHttp(url: string): boolean {
  if (!url.trim().toLowerCase().startsWith('http://')) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '[::1]') return false;
    if (/^127\./.test(host)) return false;
    return true;
  } catch {
    return true;
  }
}

interface OpenListSettingsPanelProps {
  active?: boolean;
  config: PublicConfig;
  draft: OpenListDraft;
  onChangeDraft: (key: keyof OpenListDraft, value: string) => void;
  /** 保存连接：resolve 表示成功；reject 会被面板收口为可见错误。skipVerification=true 时跳过 Fresh Probe 直接持久化凭据。 */
  onSaveConnection: (
    payload: OpenListConfigPayload,
    skipVerification?: boolean,
  ) => Promise<{ verified: boolean } | void>;
  /** 测试连接：接收 TestConnection 专用 payload，返回后端 machine status code（不 throw 分类错误；网络异常才 reject） */
  onTestConnection: (payload: OpenListTestConnectionPayload) => Promise<OpenListTestResult>;
  notice: string;
  noticeKind: 'success' | 'error' | 'info';
  /** 面板内部操作触发的提示（错误收口用）；外部 busy 锁 */
  onNotice?: (message: string, kind: 'success' | 'error' | 'info') => void;
  externalBusy?: string | null;
}

/** 后端 machine status code → 面板状态映射（REWORK：不得全部折叠为 network_unavailable） */
export function mapProbeCode(code: string): OpenListConnectionState {
  switch (code) {
    case 'connected':
      return 'connected';
    case 'credential_rejected':
      return 'credential_rejected';
    case 'root_permission_denied':
      return 'root_permission_denied';
    case 'root_not_found':
      return 'root_not_found';
    case 'rate_limited':
      return 'rate_limited';
    case 'risk_control':
    case 'cooling_down':
      return 'risk_control';
    case 'timeout':
    case 'network_unavailable':
    case 'server_unavailable':
      return 'network_unavailable';
    case 'invalid_configuration':
    case 'not_configured':
    case 'credential_store_unavailable':
      return 'unconfigured';
    case 'redirect_rejected':
    case 'unexpected_error':
    default:
      return 'network_unavailable';
  }
}

export interface OpenListDraft {
  name?: string;
  server_url: string;
  remote_root: string;
  mount_root: string;
  username: string;
  password: string;
  cache_ttl: string;
  prefetch_limit: string;
}

/** remote-affecting 字段：变化时按钮语义为「验证并保存」 */
const REMOTE_AFFECTING_KEYS: Array<keyof OpenListDraft> = ['server_url', 'remote_root', 'username', 'password'];

export default function OpenListSettingsPanel({
  config,
  draft,
  onChangeDraft,
  onSaveConnection,
  onTestConnection,
  notice,
  noticeKind,
  onNotice,
  externalBusy,
  active = false,
}: OpenListSettingsPanelProps) {
  const clearNotice = () => onNotice?.('', 'info');
  // 用户修改凭据/地址时自动清除旧错误提示，避免滞留
  const handleDraftChange = (key: keyof OpenListDraft, value: string) => {
    onChangeDraft(key, value);
    if (noticeKind === 'error') clearNotice();
  };
  const [editorOpen, setEditorOpen] = useState(!config.openlist_configured);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [allowOpenlistHttp, setAllowOpenlistHttp] = useState(false);
  const [actionLock, setActionLock] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<OpenListTelemetrySummary | null>(null);
  // 切换连接会重建面板，旧连接迟到的响应不得更新父级提示。
  const mounted = useRef(false);
  const operationGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // 登录失败后是否展示「仍然保存（不验证）」兑底入口
  const [skipVerificationOffered, setSkipVerificationOffered] = useState(false);
  useEffect(() => {
    let alive = true;
    openlistApi
      .getTelemetryToday(config.openlist_connection_id)
      .then((data) => { if (alive) setTelemetry(data); })
      .catch(() => { /* 遥测展示尽力而为 */ });
    return () => { alive = false; };
  }, []);
  // saved credential 初始状态必须是 saved_unverified，而不是 unconfigured（REWORK）
  const [probeState, setProbeState] = useState<OpenListConnectionState>(() =>
    config.openlist_configured ? 'saved_unverified' : 'unconfigured'
  );

  const saved = config.openlist_configured;
  const webdav = buildOpenListWebdavAddress(draft.server_url);

  // 当前 draft 相对「已保存配置」的修改状态（用于按钮语义）
  const dirtyKeys = useMemo(() => {
    const changed: Array<keyof OpenListDraft> = [];
    if (draft.name !== undefined && draft.name.trim() !== (config.openlist_connection_name || '默认连接')) changed.push('name');
    if (draft.server_url.trim() !== (config.openlist_server_url || '')) changed.push('server_url');
    if (draft.remote_root.trim() !== (config.openlist_remote_root || '/')) changed.push('remote_root');
    if (draft.mount_root.trim() !== (config.openlist_mount_root || '')) changed.push('mount_root');
    if (draft.username.trim() !== '') changed.push('username');
    if (draft.password !== '') changed.push('password');
    if (draft.cache_ttl !== String(config.openlist_cache_ttl_minutes ?? 1440)) changed.push('cache_ttl');
    if (draft.prefetch_limit !== String(config.openlist_prefetch_limit ?? 12)) changed.push('prefetch_limit');
    return changed;
  }, [draft, config]);

  const remoteAffectingDirty = dirtyKeys.some((key) => REMOTE_AFFECTING_KEYS.includes(key));
  const hasDirty = dirtyKeys.length > 0;

  const busy = actionLock !== null || Boolean(externalBusy);

  const buildPayload = (): OpenListConfigPayload => ({
    ...(draft.name !== undefined ? { name: draft.name } : {}),
    ...(config.openlist_connection_id ? { connection_id: config.openlist_connection_id } : {}),
    server_url: draft.server_url,
    remote_root: draft.remote_root,
    mount_root: draft.mount_root,
    username: draft.username,
    password: draft.password,
    // 非回环 HTTP 未确认时不得悄悄放行（REWORK P0：allow_insecure_http 必须来自风险确认）
    allow_insecure_http: allowOpenlistHttp || isNonLoopbackHttp(draft.server_url) === false,
    cache_ttl_minutes: Math.max(1, Number(draft.cache_ttl) || 1440),
    prefetch_limit: draft.prefetch_limit.trim() === '' ? 12 : Math.max(0, Math.min(50, Number(draft.prefetch_limit))),
  });

  // Test Connection 专用 payload：后端 TestConnectionRequest 为 extra="forbid"，
  // 只发送其接受的字段（server_url/remote_root/username/password/allow_insecure_http）
  const buildTestPayload = () => {
    const full = buildPayload();
    return {
      ...(full.connection_id ? { connection_id: full.connection_id } : {}),
      server_url: full.server_url,
      remote_root: full.remote_root,
      username: full.username,
      password: full.password,
      allow_insecure_http: full.allow_insecure_http,
    };
  };

  const runSave = async (skipVerification: boolean) => {
    if (actionLock) return; // 单操作锁：双击不产生并发
    const generation = ++operationGeneration.current;
    const current = () => mounted.current && operationGeneration.current === generation;
    setActionLock(skipVerification ? 'save-skip' : 'save');
    // 清除旧提示，避免旧错误在重新保存时滞留
    onNotice?.('', 'info');
    setSkipVerificationOffered(false);
    try {
      const outcome = await onSaveConnection(buildPayload(), skipVerification);
      if (!current()) return;
      // **只有后端真的探测成功才允许显示"连接正常"**：后端按规范化后的值判断
      // 是否变更、前端按原始字符串判断，两者不等价时（例如把地址写成等价的
      // 带尾斜杠形式）后端会跳过探测——此时若仍按 remoteAffectingDirty 显示
      // connected，就会出现"服务其实宕机却显示连接正常"。
      const verified = Boolean(outcome && outcome.verified);
      if (skipVerification) {
        // 仅保存不验证：凭据已持久化，但连接尚未验证
        setProbeState('saved_unverified');
      } else {
        setProbeState(verified ? 'connected' : 'saved_unverified');
      }
    } catch (error) {
      if (!current()) return;
      // 候选保存失败：后端保持旧提交状态。已有保存配置 → saved_unverified
      // （不得显示 unconfigured 让用户误以为旧连接丢失）；首次配置失败 → unconfigured
      setProbeState(saved ? 'saved_unverified' : 'unconfigured');
      const message = (error as Error)?.message || 'OpenList 配置保存失败';
      onNotice?.(message, 'error');
      if (!skipVerification) setSkipVerificationOffered(true);
    } finally {
      if (current()) setActionLock(null);
    }
  };

  const handleSave = () => runSave(false);
  const handleSaveSkipVerification = () => runSave(true);

  const handleTest = async () => {
    if (actionLock) return;
    const generation = ++operationGeneration.current;
    const current = () => mounted.current && operationGeneration.current === generation;
    setActionLock('test');
    setProbeState('checking');
    // 清除旧提示，避免旧错误在重新测试时滞留
    onNotice?.('', 'info');
    try {
      const result = await onTestConnection(buildTestPayload());
      if (!current()) return;
      // 真实 machine status code 映射，不得全部折叠为 network_unavailable
      const nextState = result.ok ? 'connected' : mapProbeCode(result.code);
      setProbeState(nextState);
      // 反馈在当前操作的生命周期内统一发送，父回调只返回结果。
      if (result.message) {
        onNotice?.(result.message, result.ok ? 'success' : 'error');
      }
    } catch {
      if (!current()) return;
      setProbeState('network_unavailable');
      onNotice?.('无法连接 OpenList 服务，请检查服务地址是否可达', 'error');
    } finally {
      if (current()) setActionLock(null);
    }
  };

  // 按钮语义：
  // - 无修改 → [检查连接]
  // - remote-affecting 修改 → [验证并保存]（后端 probe → save）
  // - 仅 local-only 修改 → [保存设置]（无需联网）
  const primaryLabel = !hasDirty
    ? '检查连接'
    : remoteAffectingDirty
      ? '验证并保存'
      : '保存设置';
  const primaryAction = !hasDirty ? handleTest : handleSave;
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!active) { autoChecked.current = false; return; }
    if (!saved || hasDirty || busy || autoChecked.current) return;
    autoChecked.current = true;
    void handleTest();
  }, [active, saved, hasDirty, busy]);

  return (
    <div className="sources-openlist-card sources-connection">
      <div className="sources-openlist-card-head">
        <strong>{config.openlist_server_url || '添加 OpenList 连接'}</strong>
        <span className={`sources-openlist-status ${probeState === 'connected' ? 'is-ok' : ['unconfigured', 'saved_unverified', 'checking'].includes(probeState) ? '' : 'is-error'}`}>
          {stateLabel(probeState)}
        </span>
      </div>

      <div className="sources-openlist-meta is-stacked">
        <div>
          <span>账号密码</span>
          <code>{saved ? '已保存（只存在这台电脑上）' : '未保存'}</code>
        </div>
      </div>

      <div className="sources-openlist-actions">
        <Button appearance="secondary" size="small" aria-expanded={editorOpen} onClick={() => setEditorOpen((v) => !v)} disabled={busy}>
          {editorOpen ? '收起连接设置' : '管理连接'}
        </Button>
        <Button appearance="primary" size="small" onClick={primaryAction} disabled={Boolean(busy)}>
          {busy ? '处理中…' : primaryLabel}
        </Button>
      </div>

      {editorOpen && (
        <fieldset className="sources-openlist-editor" disabled={busy} aria-label="连接设置">
          {draft.name !== undefined && <SettingsField label="连接名称" className="settings-config-row">
            <Input value={draft.name} maxLength={80} disabled={busy} onChange={(_, data) => handleDraftChange('name', data.value)} autoComplete="off" />
          </SettingsField>}
          <SettingsField label="OpenList 地址" className="settings-config-row">
            <Input type="url" value={draft.server_url} disabled={busy} onChange={(_, data) => handleDraftChange('server_url', data.value)} placeholder="http://localhost:5244" autoComplete="url" />
          </SettingsField>
          <div className="sources-credentials-block">
            {saved ? (
              <div className="sources-credentials-status">
                保持留空即可沿用已保存的账号密码。
              </div>
            ) : (
              <div className="sources-credentials-status">尚未保存登录信息</div>
            )}
            <div className="settings-field-list">
              <SettingsField label="用户名" className="settings-config-row">
                <Input type="text" value={draft.username} disabled={busy} onChange={(_, data) => handleDraftChange('username', data.value)} placeholder={saved ? (config.openlist_username_masked || '已保存用户名') : 'OpenList 用户名'} autoComplete="username" />
              </SettingsField>
              <SettingsField label="密码" className="settings-config-row">
                <Input type={showNewPassword ? 'text' : 'password'} value={draft.password} disabled={busy} onChange={(_, data) => handleDraftChange('password', data.value)} placeholder={saved ? '••••••••（已保存，输入后更新）' : 'OpenList 密码'} autoComplete="current-password"
                  contentAfter={<Button type="button" appearance="subtle" size="small" disabled={busy} aria-label={showNewPassword ? '隐藏本次输入密码' : '显示本次输入密码'} title={showNewPassword ? '隐藏本次输入密码' : '显示本次输入密码'} onClick={() => setShowNewPassword((value) => !value)} icon={showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />} />}
                />
              </SettingsField>
              <div className="sources-credentials-status">已保存的密码不会回传到界面；更换账号需同时填写用户名和密码。</div>
            </div>
            {skipVerificationOffered && (
              <div className="sources-openlist-actions">
                <Button appearance="secondary" size="small" onClick={handleSaveSkipVerification} disabled={Boolean(busy)}>
                  仍然保存（不验证）
                </Button>
                <span className="sources-route-hint">登录验证失败时仍可先把账号密码保存下来，稍后再点「检查连接」确认。</span>
              </div>
            )}
          </div>

          <SettingsField label="远端根目录" className="settings-config-row">
            <Input type="text" value={draft.remote_root} disabled={busy} onChange={(_, data) => handleDraftChange('remote_root', data.value)} placeholder="/" />
          </SettingsField>
          <SettingsField label="本地挂载位置" className="settings-config-row">
            <FolderPathInput label="本地挂载位置" value={draft.mount_root} disabled={busy} onChange={value => handleDraftChange('mount_root', value)} placeholder="例如 K:\\" />
          </SettingsField>
          <p className="sources-route-hint">与当前连接的远端根目录对应。</p>

          <details className="sources-advanced">
            <summary>高级设置</summary>
            <div className="sources-advanced-body">
              <div className="sources-webdav-hint"><span>WebDAV 挂载地址：</span><code>{webdav || '填写服务地址后自动生成'}</code></div>
              <SettingsField label="目录浏览缓存（分钟）" className="settings-config-row">
                <Input type="number" min={1} max={43200} value={draft.cache_ttl} disabled={busy} onChange={(_, data) => handleDraftChange('cache_ttl', data.value)} placeholder="1440" />
              </SettingsField>
              <SettingsField label="提前加载子目录（上限 50）" className="settings-config-row">
                <Input type="number" min={0} max={50} value={draft.prefetch_limit} disabled={busy} onChange={(_, data) => handleDraftChange('prefetch_limit', data.value)} placeholder="12" />
              </SettingsField>
              {telemetry && <p className="sources-route-hint">今天的请求：共 {telemetry.total} 次（读取目录 {telemetry.fs_list} 次、登录 {telemetry.login} 次）。仅统计 KumiPlayer 向 OpenList 发出的请求。</p>}
            </div>
          </details>

          {isNonLoopbackHttp(draft.server_url) && (
            <Checkbox className="settings-risk-confirm" checked={allowOpenlistHttp} disabled={busy} onChange={(_, data) => setAllowOpenlistHttp(data.checked === true)}
              label="该地址是本地/局域网 HTTP，密码将以明文传输；勾选表示已知晓风险" />
          )}

        </fieldset>
      )}
      <ActionToast message={notice} intent={noticeKind} onDismiss={() => onNotice?.('', 'info')} />
    </div>
  );
}
