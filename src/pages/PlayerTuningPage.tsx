// KumiPlayer 播放器调节页面：Anime4K 永久默认效果设置
//
// 与右键菜单的关系：
// - 本页面保存的是“之后开始播放的新视频”的永久默认值；
// - 右键菜单只临时改变当前视频，下一视频恢复本页面设置的永久默认。

import { useEffect, useId, useState } from 'react';
import { Button, Dropdown, Input, Option, Radio, RadioGroup, Spinner } from '@fluentui/react-components';
import { ArrowLeft, CheckCircle2, FolderOpen } from 'lucide-react';
import { configApi, type PublicConfig, type MpvValidationResult, type MpvRuntimeStatus } from '../api/config';
import { pickFile } from '../platform/folderPicker';
import { useUiStore } from '../stores/ui';
import { SettingsFeedback, SettingsField, SettingsSection } from '../components/ui/SettingsPrimitives';
import '../styles/player-tuning.css';

type Anime4kMode = 'off' | 'a' | 'b' | 'c' | 'a+a' | 'b+b' | 'c+a';
type Anime4kQuality = 'fast' | 'light' | 'balanced' | 'high';
type PlayerMode = 'internal' | 'external';

const PLAYER_MODE_OPTIONS: Array<{ value: PlayerMode; label: string }> = [
  { value: 'internal', label: 'KumiPlayer 内置播放器' },
  { value: 'external', label: '外部 MPV 整合包' },
];

const MODE_OPTIONS: Array<{ value: Anime4kMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'a', label: 'Anime4K Mode A' },
  { value: 'b', label: 'Anime4K Mode B' },
  { value: 'c', label: 'Anime4K Mode C' },
  { value: 'a+a', label: 'Anime4K Mode A+A' },
  { value: 'b+b', label: 'Anime4K Mode B+B' },
  { value: 'c+a', label: 'Anime4K Mode C+A' },
];

const QUALITY_OPTIONS: Array<{ value: Anime4kQuality; label: string }> = [
  { value: 'fast', label: '极速 · 单层（低配推荐）' },
  { value: 'light', label: '轻量' },
  { value: 'balanced', label: '均衡' },
  { value: 'high', label: '高质量' },
];

export default function PlayerTuningPage({ embedded = false, initialConfig, runtimeStatus, externalBusy = false, onConfigSaved, onPlayerTested }: {
  embedded?: boolean;
  initialConfig?: PublicConfig;
  runtimeStatus?: MpvRuntimeStatus | null;
  externalBusy?: boolean;
  onConfigSaved?: (config: PublicConfig) => void;
  onPlayerTested?: () => Promise<void>;
} = {}) {
  const goBack = useUiStore((state) => state.goBack);
  const playerModeId = useId();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [mode, setMode] = useState<Anime4kMode>('off');
  const [quality, setQuality] = useState<Anime4kQuality>('balanced');
  const [playerMode, setPlayerMode] = useState<PlayerMode>('internal');
  const [externalPath, setExternalPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openingConfigDir, setOpeningConfigDir] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [configFolderOpened, setConfigFolderOpened] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [testing, setTesting] = useState(false);
  const [validation, setValidation] = useState<MpvValidationResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const applyConfig = (data: PublicConfig) => {
      setConfig(data);
      setMode(data.mpv_anime4k_mode || 'off');
      setQuality(data.mpv_anime4k_quality || 'balanced');
      setPlayerMode(data.player_mode === 'external' ? 'external' : 'internal');
      setExternalPath(data.external_mpv_path || (data.player_mode === 'external' ? data.mpv_path : '') || '');
    };
    if (initialConfig) {
      applyConfig(initialConfig);
      setLoading(false);
      return () => { cancelled = true; };
    }
    configApi.getConfig()
      .then((data) => {
        if (cancelled) return;
        applyConfig(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`读取配置失败：${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // 连续播放等无关设置保存时保留播放器草稿；仅同步播放器字段的外部变更。
  }, [loadAttempt, initialConfig?.player_mode, initialConfig?.external_mpv_path, initialConfig?.mpv_path, initialConfig?.mpv_anime4k_mode, initialConfig?.mpv_anime4k_quality]);

  const busy = loading || saving || testing || openingConfigDir || externalBusy;
  const selectionChanged = !!config && (
    playerMode !== (config.player_mode === 'external' ? 'external' : 'internal')
    || (playerMode === 'external' && externalPath.trim() !== (config.external_mpv_path || config.mpv_path || ''))
  );
  const clearFeedback = () => {
    setSaved(false);
    setConfigFolderOpened(false);
    setValidation(null);
    setError('');
  };

  const save = async () => {
    if (!config || busy || (playerMode === 'external' && !externalPath.trim())) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const patch: Partial<PublicConfig> = {
        player_mode: playerMode,
        external_mpv_path: externalPath.trim(),
        ...(playerMode === 'internal' ? { mpv_anime4k_mode: mode, mpv_anime4k_quality: quality } : {}),
      };
      const updated = await configApi.patchConfig(patch);
      const nextConfig = { ...config, ...patch, ...updated };
      setConfig(nextConfig);
      onConfigSaved?.(nextConfig);
      setSaved(true);
    } catch (err) {
      setError(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const openConfigDir = async () => {
    if (!config || busy || selectionChanged) return;
    setOpeningConfigDir(true);
    setError('');
    setConfigFolderOpened(false);
    try {
      await configApi.openMpvConfigDir(playerMode);
      setConfigFolderOpened(true);
    } catch (err) {
      setError(`打开 MPV 配置文件夹失败：${(err as Error).message}`);
    } finally {
      setOpeningConfigDir(false);
    }
  };

  const chooseExternalPlayer = async () => {
    setError('');
    try {
      const picked = await pickFile(externalPath || undefined, '选择 MPV 可执行文件');
      if (picked) {
        clearFeedback();
        setExternalPath(picked);
      }
    } catch (err) {
      setError(`选择 MPV 可执行文件失败：${(err as Error).message}`);
    }
  };

  const testPlayer = async () => {
    if (!config || busy || (playerMode === 'external' && !externalPath.trim())) return;
    setTesting(true);
    clearFeedback();
    try {
      const result = playerMode === 'external'
        ? await configApi.testMpv(externalPath.trim(), 'external')
        : await configApi.testMpv();
      const checked = playerMode === 'internal' && (result.plugin_available === false || result.integration_available === false)
        ? { ...result, ok: false, message: '内置播放脚本不完整，请检查 Anime4K、截图、快捷键和菜单联动脚本，或修复应用安装。' }
        : result;
      setValidation(checked);
      if (playerMode === 'internal') await onPlayerTested?.();
      if (result.ok && result.executable_path && playerMode === 'external') setExternalPath(result.executable_path);
    } catch (err) {
      setError(`检测失败：${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={`player-tuning-page player-tuning-page--compact${embedded ? ' player-tuning-page--embedded' : ''}`}>
      {!embedded && <div className="player-tuning-header">
        <Button appearance="subtle" icon={<ArrowLeft size={16} />} onClick={() => goBack()}>返回</Button>
        <div>
          <span className="player-tuning-kicker">播放设置</span>
          <h2>播放器调节</h2>
        </div>
      </div>}

      {loading && <SettingsFeedback busy>正在读取配置…</SettingsFeedback>}
      {!loading && !config && <Button onClick={() => setLoadAttempt((value) => value + 1)}>重新读取</Button>}
      {config && !loading && <>
      <SettingsSection title="选择播放器" headingId={playerModeId}>
        <RadioGroup aria-labelledby={playerModeId} value={playerMode} disabled={busy}
          onChange={(_, data) => { clearFeedback(); setPlayerMode(data.value as PlayerMode); }}>
          {PLAYER_MODE_OPTIONS.map((item) => <Radio key={item.value} value={item.value} label={item.label}
            title={item.value === 'external' ? '使用整合包原有配置、画质和快捷键' : undefined} />)}
        </RadioGroup>
          {playerMode === 'external' && (
            <SettingsField label="整合包 MPV 可执行文件"
              action={<Button appearance="secondary" disabled={busy} icon={<FolderOpen size={16} />} onClick={() => void chooseExternalPlayer()}>选择</Button>}>
                <Input
                  value={externalPath}
                  disabled={busy}
                  placeholder="粘贴 mpv.exe 路径或整合包目录"
                  onChange={(_, data) => { clearFeedback(); setExternalPath(data.value); }}
                />
            </SettingsField>
          )}
        <div className="player-tuning-tools">
          <Button title={playerMode === 'internal' ? '检测启动、版本与内置脚本' : '检测 MPV 启动与版本'} disabled={busy || (playerMode === 'external' && !externalPath.trim())} icon={testing ? <Spinner size="tiny" /> : undefined} onClick={() => void testPlayer()}>{testing ? '正在检测…' : '检测播放器'}</Button>
          <Button appearance="subtle" icon={<FolderOpen size={16} />} title={selectionChanged ? '请先保存播放器设置' : undefined} disabled={busy || selectionChanged} onClick={() => void openConfigDir()}>
            {openingConfigDir ? '正在打开…' : '打开 MPV 配置文件夹'}
          </Button>
        </div>
        {playerMode === 'internal' && runtimeStatus && !validation && <p className="player-tuning-note" role="status">{runtimeStatus.available && runtimeStatus.manifest_valid && runtimeStatus.files_valid && runtimeStatus.configuration_available && runtimeStatus.scripts_available
          ? '内置播放器已就绪'
          : '内置播放器文件或脚本需要检查，请点击「检测播放器」查看结果。'}</p>}
        {validation && <SettingsFeedback intent={validation.ok ? 'success' : 'error'}>
          <span>{validation.message}{validation.version && !validation.message.includes(validation.version) ? ` · ${validation.version}` : ''}</span>
        </SettingsFeedback>}
      </SettingsSection>

      {playerMode === 'internal' ? (
      <SettingsSection title="Anime4K 默认效果">
          <div className="player-tuning-fields">
            <SettingsField label="模式">
              <Dropdown value={MODE_OPTIONS.find(item => item.value === mode)?.label || ''} selectedOptions={[mode]} disabled={busy}
                onOptionSelect={(_, data) => { if (data.optionValue) { clearFeedback(); setMode(data.optionValue as Anime4kMode); } }}>
                {MODE_OPTIONS.map((item) => <Option key={item.value} value={item.value}>{item.label}</Option>)}
              </Dropdown>
            </SettingsField>
            <SettingsField label="质量">
              <Dropdown value={QUALITY_OPTIONS.find(item => item.value === quality)?.label || ''} selectedOptions={[quality]} disabled={busy || mode === 'off'}
                onOptionSelect={(_, data) => { if (data.optionValue) { clearFeedback(); setQuality(data.optionValue as Anime4kQuality); } }}>
                {QUALITY_OPTIONS.map((item) => <Option key={item.value} value={item.value}>{item.label}</Option>)}
              </Dropdown>
            </SettingsField>
          </div>
        <details className="player-tuning-help-details">
        <summary>如何选择效果与质量</summary>
        <ul className="player-tuning-help">
          <li>“模式”选择的是<strong>算法族</strong>（Restore / Upscale_Denoise / 二次增强），不是性能档位。Mode C 使用 Upscale_Denoise 链，并不是最轻量的选项。</li>
          <li>“极速”只运行一个较小的着色器，适合低配电脑；轻量及以上才使用完整多层链。极速下增强模式会简化为对应的基础算法。</li>
          <li>“质量”是<strong>成本档位</strong>：轻量及以上决定完整链中 CNN 模型的大小（轻量 M/S、均衡 L/M、高质量 VL/M）。降低质量能减轻 GPU 负担，但 4K 源片仍可能超出帧预算。</li>
          <li>当前默认是“关闭”，需要时再手动开启；播放中右键菜单可临时切换，只影响当前视频，不改这里的默认值。</li>
          <li>低配电脑先试 Mode A + 极速；如果仍不流畅，就关闭 Anime4K。性能足够时再比较其他模式与质量。</li>
          <li>轻量及以上的增强模式（A+A / B+B / C+A）链更长、渲染开销更高，建议在显示放大至少 2× 时使用，否则可能过锐或劣化。</li>
          <li>播放 4K 视频出现掉帧时，先关闭 Anime4K 确认是否恢复流畅；仅降到“轻量”也可能不足。较低分辨率视频可再试轻量档或更短模式。“已应用”只代表着色器链已下发并被 MPV 接受，不代表当前 GPU 帧预算已经足够。</li>
        </ul>
        </details>
      </SettingsSection>
      ) : null}
      </>}

      {error && <SettingsFeedback intent="error">{error}</SettingsFeedback>}
      {saved && <SettingsFeedback intent="success">已保存，之后播放的新视频将使用新默认值</SettingsFeedback>}
      {configFolderOpened && <SettingsFeedback intent="success">已打开 MPV 配置文件夹</SettingsFeedback>}

      <div className="player-tuning-actions">
        <Button appearance="primary" icon={saving ? <Spinner size="tiny" /> : <CheckCircle2 size={15} />} disabled={busy || !config || (playerMode === 'external' && !externalPath.trim())} onClick={() => void save()}>
          保存默认设置
        </Button>
      </div>
    </div>
  );
}
