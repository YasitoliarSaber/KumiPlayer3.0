import { useEffect, useMemo, useRef, useState } from 'react';
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, Radio, RadioGroup } from '@fluentui/react-components';
import { CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, FolderOpen, KeyRound, Play, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { configApi, type MpvRuntimeStatus, type PublicConfig, type SetupCompletePayload } from '../api/config';
import { BANGUMI_ACCESS_TOKEN_URL, getTmdbCredentialError, TMDB_API_SETTINGS_URL } from '../config/credentials';
import { pickFile, pickFolder } from '../platform/folderPicker';
import '../styles/first-run-refinement.css';

interface FirstRunSetupProps {
  initialConfig: PublicConfig;
  onComplete: (config: PublicConfig) => void;
  mode?: 'first-run' | 'reconfigure';
  onCancel?: () => void;
}

const steps = ['欢迎', '播放器', '媒体来源', '完成设置'];
const sourceOptions = [
  { key: 'local_root', name: '本地文件夹', label: '本地媒体根目录', placeholder: '选择你的影视文件夹' },
  { key: 'pan115_root', name: '115 网盘', label: '115 网盘挂载根目录', placeholder: '选择已挂载到电脑的 115 文件夹' },
  { key: 'baidu_root', name: '百度网盘', label: '百度网盘挂载位置', placeholder: '选择已挂载到电脑的百度网盘文件夹' },
] as const;
type SourceKey = typeof sourceOptions[number]['key'];

export default function FirstRunSetup({ initialConfig, onComplete, mode = 'first-run', onCancel }: FirstRunSetupProps) {
  const isReconfigure = mode === 'reconfigure';
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<SetupCompletePayload>({
    player_mode: initialConfig.player_mode === 'external' ? 'external' : 'internal',
    external_mpv_path: initialConfig.external_mpv_path || (initialConfig.player_mode === 'external' ? initialConfig.mpv_path : '') || '',
    pan115_root: initialConfig.pan115_root || '',
    baidu_root: initialConfig.baidu_root || '',
    local_root: initialConfig.local_root || '',
    directory_tree_dir: initialConfig.directory_tree_dir || '',
    tmdb_bearer_token: '',
    bangumi_access_token: '',
  });
  const externalPlayer = form.player_mode === 'external';
  const playerLabel = externalPlayer ? '外部播放器' : '内置播放器';
  const checkRevision = useRef(0);
  const [mpvStatus, setMpvStatus] = useState<MpvRuntimeStatus | null>(null);
  const [externalStatus, setExternalStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [activeSource, setActiveSource] = useState<SourceKey>(sourceOptions.find((source) => initialConfig[source.key]?.trim())?.key || 'local_root');
  const selectedSource = sourceOptions.find((source) => source.key === activeSource)!;
  const [checkingMpv, setCheckingMpv] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');

  const sourceCount = useMemo(
    () => [form.pan115_root, form.baidu_root, form.local_root].filter((value) => value?.trim()).length,
    [form.pan115_root, form.baidu_root, form.local_root],
  );

  const checkMpv = async () => {
    const revision = ++checkRevision.current;
    setCheckingMpv(true);
    setError('');
    try {
      if (externalPlayer) {
        const status = await configApi.testMpv(form.external_mpv_path?.trim() || '', 'external');
        if (revision === checkRevision.current) setExternalStatus(status);
      } else {
        const status = await configApi.getMpvRuntime();
        if (revision === checkRevision.current) setMpvStatus(status);
      }
    } catch (reason) {
      if (revision !== checkRevision.current) return;
      setMpvStatus(null);
      setExternalStatus(null);
      setError(reason instanceof Error ? reason.message : `${playerLabel}检测失败`);
    } finally {
      if (revision === checkRevision.current) setCheckingMpv(false);
    }
  };

  // A new selection must be checked independently of the previous player's result.
  useEffect(() => {
    if (step === 1 && !mpvStatus && !externalStatus && (!externalPlayer || form.external_mpv_path?.trim())) {
      void checkMpv();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, form.player_mode]);

  useEffect(() => () => { checkRevision.current += 1; }, []);

  const resetPlayerCheck = () => {
    checkRevision.current += 1;
    setCheckingMpv(false);
    setMpvStatus(null);
    setExternalStatus(null);
    setError('');
  };

  const closeWindow = async () => {
    try {
      if (isTauri()) await getCurrentWindow().close();
      else window.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法关闭窗口');
    }
  };

  const update = (key: keyof SetupCompletePayload, value: string) => {
    if (key === 'external_mpv_path') resetPlayerCheck();
    setForm((current) => ({ ...current, [key]: value }));
    setError('');
  };

  const choosePlayer = async () => {
    try {
      const selected = await pickFile(form.external_mpv_path, '选择 MPV 可执行文件');
      if (selected) update('external_mpv_path', selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法打开文件选择器，请手动输入路径');
    }
  };

  const chooseDirectory = async (key: keyof SetupCompletePayload, title: string) => {
    try {
      const selected = await pickFolder(String(form[key] || ''), title);
      if (selected) update(key, selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法打开文件夹选择器，请手动输入路径');
    }
  };

  const mpvReady = !checkingMpv && (externalPlayer ? Boolean(externalStatus?.ok) : Boolean(
    mpvStatus?.available
    && mpvStatus.manifest_valid
    && mpvStatus.files_valid
    && mpvStatus.configuration_available,
  ));

  const goNext = () => {
    if (step === 1 && !mpvReady) {
      setError(`请先确认${playerLabel}可用`);
      return;
    }
    if (step === 2) {
      if (sourceCount === 0) {
        setError('请至少配置一个媒体来源');
        return;
      }
    }
    setError('');
    setStep((current) => Math.min(steps.length - 1, current + 1));
  };

  const finish = async () => {
    const tmdbCredentialError = getTmdbCredentialError(form.tmdb_bearer_token || '');
    if (tmdbCredentialError) {
      setError(tmdbCredentialError);
      return;
    }
    setFinishing(true);
    setError('');
    try {
      // 空输入表示保留已有凭据，不发送清空值。
      const { tmdb_bearer_token, bangumi_access_token, ...paths } = form;
      onComplete(await configApi.completeSetup({
        ...paths,
        ...(tmdb_bearer_token?.trim() ? { tmdb_bearer_token: tmdb_bearer_token.trim() } : {}),
        ...(bangumi_access_token?.trim() ? { bangumi_access_token: bangumi_access_token.trim() } : {}),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '初始化失败，请检查配置');
    } finally {
      setFinishing(false);
    }
  };

  return (
    <main className="first-run-shell first-run-refined">
      <section className="first-run-window" aria-label={isReconfigure ? 'KumiPlayer 初始设置引导' : 'KumiPlayer 首次启动引导'}>
        <header className="first-run-header">
          <div className="first-run-brand"><img src="/brand/kumiplayer-app-icon.svg" alt="" /><strong>KumiPlayer</strong></div>
          <div className="first-run-header-actions">
            <span>{isReconfigure ? '重新配置初始设置' : '首次启动设置'}</span>
            {onCancel && <button type="button" onClick={onCancel}>退出引导</button>}
            <button type="button" className="first-run-close" onClick={() => void closeWindow()} aria-label="关闭应用" title="关闭应用"><X size={16} />关闭</button>
          </div>
        </header>

        <div className="first-run-layout">
          <nav className="first-run-steps" aria-label="设置步骤">
            {steps.map((label, index) => (
              <div key={label} aria-current={index === step ? 'step' : undefined} className={`first-run-step ${index === step ? 'active' : ''} ${index < step ? 'done' : ''}`}>
                <span>{index < step ? <CheckCircle2 size={16} /> : index + 1}</span>
                <div><strong>{label}</strong><small>{index === step ? '正在设置' : index < step ? '已完成' : '稍后设置'}</small></div>
              </div>
            ))}
          </nav>

          <div className="first-run-content">
            {step === 0 && (
              <div className="first-run-panel first-run-welcome">
                <p className="first-run-eyebrow">{isReconfigure ? '重新检查 KumiPlayer 配置' : '欢迎使用 KumiPlayer'}</p>
                <h1>{isReconfigure ? '检查你的媒体库设置' : '从你的媒体开始'}</h1>
                <p>确认播放器，选择媒体文件夹，就可以开始整理和观看。KumiPlayer 不会移动或改名你的原始文件。</p>
                <div className="first-run-principles">
                  <article><Play size={20} /><div><strong>选择适合你的播放器</strong><span>使用内置 MPV，或选择你已有的 MPV 整合包。</span></div></article>
                  <article><ShieldCheck size={20} /><div><strong>配置可以随时修改</strong><span>更多来源、海报和观看同步都可以稍后在设置中添加。</span></div></article>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="first-run-panel">
                <p className="first-run-eyebrow">播放器</p>
                <h1>选择播放器</h1>
                <RadioGroup className="first-run-source-options" aria-label="播放器类型" layout="horizontal" value={form.player_mode} disabled={finishing}
                  onChange={(_, data) => { resetPlayerCheck(); setForm((current) => ({ ...current, player_mode: data.value as PublicConfig['player_mode'] })); }}>
                  <Radio value="internal" label="内置播放器" />
                  <Radio value="external" label="外部播放器" />
                </RadioGroup>
                <p>{externalPlayer ? '选择已有的 MPV 可执行文件或整合包目录，保留它的画质、快捷键和插件设置。' : '使用随应用提供的 MPV。播放器配置独立保存，不影响你电脑上的其他 MPV。'}</p>
                {externalPlayer && <SetupPathField label="外部 MPV 路径" value={form.external_mpv_path || ''} placeholder="选择 mpv.exe，或粘贴整合包目录" onChange={(value) => update('external_mpv_path', value)} onPick={() => void choosePlayer()} actionLabel="选择文件" />}
                {checkingMpv && (
                  <div className="first-run-result" role="status">
                    <strong>正在检测{playerLabel}…</strong>
                  </div>
                )}
                {!checkingMpv && (mpvStatus || externalStatus) && (
                  <div className={`first-run-result ${mpvReady ? 'success' : 'error'}`}>
                    <strong>{mpvReady ? `${playerLabel}已就绪` : '播放器暂不可用'}</strong>
                    <span>{mpvReady ? '可以继续下一步。' : (externalPlayer ? externalStatus?.message : mpvStatus?.message)}</span>
                  </div>
                )}
                <button className="first-run-secondary" onClick={checkMpv} disabled={checkingMpv || (externalPlayer && !form.external_mpv_path?.trim())}>{checkingMpv ? '正在检测…' : <><RefreshCw size={14} />重新检测</>}</button>
                {!mpvReady && !checkingMpv && <p className="first-run-help-link">{externalPlayer ? '选择播放器后点击「重新检测」，检测成功即可继续。' : '请检查应用安装目录中的播放器文件；也可以切换到外部播放器，选择已有的 MPV。'}</p>}
              </div>
            )}

            {step === 2 && (
              <div className="first-run-panel">
                <p className="first-run-eyebrow">媒体来源</p>
                <h1>你的媒体放在哪里</h1>
                <p>先选择一个本地或已挂载的媒体目录。需要多个来源时，切换类型继续填写，已填路径会保留。</p>
                <RadioGroup className="first-run-source-options" aria-label="媒体来源类型" layout="horizontal" value={activeSource} onChange={(_, data) => setActiveSource(data.value as SourceKey)}>
                  {sourceOptions.map((source) => <Radio key={source.key} value={source.key} label={`${source.name}${form[source.key]?.trim() ? ' · 已配置' : ''}`} />)}
                </RadioGroup>
                <SetupPathField label={selectedSource.label} value={form[activeSource] || ''} placeholder={selectedSource.placeholder} onChange={(value) => update(activeSource, value)} onPick={() => chooseDirectory(activeSource, `选择${selectedSource.label}`)} />
                <p>网盘媒体通过本地挂载播放；目录树和 OpenList 只提供目录信息。作品资料与图片缓存由应用独立保存。</p>
                <Accordion className="first-run-options" collapsible defaultOpenItems={form.directory_tree_dir ? ['tree'] : []}>
                  <AccordionItem value="tree">
                    <AccordionHeader>导入目录树（可选）{form.directory_tree_dir?.trim() ? ' · 已配置' : ''}</AccordionHeader>
                    <AccordionPanel>
                      <SetupPathField label="目录树文件目录（可选）" value={form.directory_tree_dir || ''} placeholder="保存网盘目录树 TXT 的文件夹" onChange={(value) => update('directory_tree_dir', value)} onPick={() => chooseDirectory('directory_tree_dir', '选择目录树文件目录')} />
                    </AccordionPanel>
                  </AccordionItem>
                </Accordion>
                <div className="first-run-path-example">
                  <strong>OpenList 可在完成后添加</strong>
                  <span>完成后打开「设置 → OpenList」连接网盘。首次设置仍需一个本地或已挂载的媒体目录。</span>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="first-run-panel">
                <p className="first-run-eyebrow">最后检查</p>
                <h1>准备开始使用</h1>
                <p>完成前会检查播放器和目录是否可用。海报与观看同步可以稍后设置。</p>
                <div className="first-run-summary">
                  <SummaryRow label={playerLabel} value={mpvReady ? '已就绪' : '未就绪'} ok={mpvReady} />
                  <SummaryRow label="媒体来源" value={`已配置 ${sourceCount} 个来源`} ok={sourceCount > 0} />
                </div>
                <Accordion className="first-run-options" collapsible>
                  <AccordionItem value="credentials">
                    <AccordionHeader>海报与观看同步（可选）</AccordionHeader>
                    <AccordionPanel>
                <div className="first-run-credential-grid">
                  <article className="first-run-credential-card">
                    <div className="first-run-credential-title"><KeyRound size={18} /><div><strong>TMDB API 读取访问令牌</strong><small>可选 · 用于刮削元数据与图片</small></div></div>
                    <p>复制页面上方较长的“API 读取访问令牌”，不是下方的 API 密钥。</p>
                    <a href={TMDB_API_SETTINGS_URL} target="_blank" rel="noreferrer">前往 TMDB API 设置 <ExternalLink size={14} /></a>
                    <input aria-label="TMDB API 读取访问令牌" type="password" value={form.tmdb_bearer_token || ''} onChange={(event) => update('tmdb_bearer_token', event.target.value)} placeholder="粘贴 API 读取访问令牌" autoComplete="off" />
                  </article>
                  <article className="first-run-credential-card">
                    <div className="first-run-credential-title"><KeyRound size={18} /><div><strong>Bangumi 个人访问令牌</strong><small>可选 · 用于同步收藏与已看集数</small></div></div>
                    <p>在 Bangumi 官方页面创建 Access Token，再复制到这里。</p>
                    <a href={BANGUMI_ACCESS_TOKEN_URL} target="_blank" rel="noreferrer">前往 Bangumi 令牌页面 <ExternalLink size={14} /></a>
                    <input aria-label="Bangumi 个人访问令牌" type="password" value={form.bangumi_access_token || ''} onChange={(event) => update('bangumi_access_token', event.target.value)} placeholder="粘贴个人 Access Token" autoComplete="off" />
                  </article>
                </div>
                <p className="first-run-credential-security">留空会保留已保存的凭据。新凭据验证后保存在 Windows 凭据管理器中。</p>
                    </AccordionPanel>
                  </AccordionItem>
                </Accordion>
              </div>
            )}

            {error && <div className="first-run-error" role="alert">{error}</div>}
            <footer className="first-run-footer">
              <button className="first-run-back" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || finishing}><ChevronLeft size={17} />返回</button>
              {step < steps.length - 1 ? (
                <button
                  className="first-run-primary"
                  onClick={goNext}
                  disabled={(step === 1 && !mpvReady) || (step === 2 && sourceCount === 0)}
                >继续<ChevronRight size={17} /></button>
              ) : (
                <button className="first-run-primary" onClick={finish} disabled={finishing}>{finishing ? '正在验证…' : '验证并完成'}<CheckCircle2 size={17} /></button>
              )}
            </footer>
          </div>
        </div>
      </section>
    </main>
  );
}

function SetupPathField({ label, value, placeholder, onChange, onPick, actionLabel = '选择文件夹', compact = false }: { label: string; value: string; placeholder: string; onChange: (value: string) => void; onPick: () => void; actionLabel?: string; compact?: boolean }) {
  return (
    <label className={`first-run-path-field ${compact ? 'compact' : ''}`}>
      <span>{label}</span>
      <div><input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /><button type="button" aria-label={`选择${label}`} onClick={onPick}><FolderOpen size={16} />{actionLabel}</button></div>
    </label>
  );
}

function SummaryRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div><span className={ok ? 'ok' : ''}>{ok ? <CheckCircle2 size={17} /> : '—'}</span><strong>{label}</strong><p>{value || '未配置'}</p></div>;
}
