import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Select } from '@fluentui/react-components';
import type { PublicConfig } from '../../api/config';
import { useUiStore, type SeriesCardImageMode } from '../../stores/ui';
import { normalizePosterColumns } from '../library/posterGridMetrics';
import { SettingsFeedback, SettingsField, SettingsSection } from '../ui/SettingsPrimitives';
import './PosterWallSettingsPanel.css';

type PosterWallConfig = Pick<PublicConfig, 'poster_size' | 'series_card_image_mode'>;

interface PosterWallLayoutDraft {
  columns: number;
  mode: SeriesCardImageMode;
}

/** 用户可选的目标列数预设；实际列数仍受窗口容量限制。 */
const SIZE_PRESETS: Array<{ value: number; label: string }> = [
  { value: 4, label: '大封面（目标 4 列）' },
  { value: 6, label: '标准（目标 6 列）' },
  { value: 8, label: '紧凑（目标 8 列）' },
];

const INVALID_RESPONSE_MESSAGE = '保存结果无法确认，请重新进入设置核对';

function normalizeLayout(config: PosterWallConfig): PosterWallLayoutDraft {
  return {
    columns: normalizePosterColumns(config.poster_size),
    mode: config.series_card_image_mode === 'fanart' ? 'fanart' : 'poster',
  };
}

/** 读取服务端返回的布局字段；缺失或非法时返回 null，调用方不得当作已保存。 */
function readLayout(config: PublicConfig | null | undefined): PosterWallLayoutDraft | null {
  if (!config) return null;
  const mode = config.series_card_image_mode;
  if (mode !== 'poster' && mode !== 'fanart') return null;
  if (!Number.isFinite(config.poster_size) || config.poster_size <= 0) return null;
  return { columns: normalizePosterColumns(config.poster_size), mode };
}

function sameLayout(left: PosterWallLayoutDraft, right: PosterWallLayoutDraft) {
  return left.columns === right.columns && left.mode === right.mode;
}

export default function PosterWallSettingsPanel({ config, externalBusy = false, onSave }: {
  config: PosterWallConfig;
  externalBusy?: boolean;
  onSave: (patch: PosterWallConfig) => Promise<PublicConfig>;
}) {
  // 只订阅本面板需要的 Store action，不订阅整个 UiStore。
  const setPosterWallLayout = useUiStore((state) => state.setPosterWallLayout);
  const initial = normalizeLayout(config);
  const [effective, setEffective] = useState<PosterWallLayoutDraft>(initial);
  const [draft, setDraft] = useState<PosterWallLayoutDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const serverRef = useRef<PosterWallLayoutDraft>(initial);

  const dirty = !sameLayout(draft, effective);
  dirtyRef.current = dirty;
  const busy = saving || externalBusy;

  const serverLayout = normalizeLayout(config);
  const serverColumns = serverLayout.columns;
  const serverMode = serverLayout.mode;

  useEffect(() => {
    const previous = serverRef.current;
    if (previous.columns === serverColumns && previous.mode === serverMode) return;
    serverRef.current = { columns: serverColumns, mode: serverMode };
    // 保存进行中以本次请求响应为准；保存其他配置换掉整个对象时不能吞掉未保存草稿。
    if (savingRef.current) return;
    setEffective({ columns: serverColumns, mode: serverMode });
    setDraft((current) => (dirtyRef.current ? current : { columns: serverColumns, mode: serverMode }));
  }, [serverColumns, serverMode]);

  const sizeOptions = useMemo(() => {
    const options = [...SIZE_PRESETS];
    if (!options.some((preset) => preset.value === effective.columns)) {
      options.push({ value: effective.columns, label: `当前设置（目标 ${effective.columns} 列）` });
      options.sort((left, right) => left.value - right.value);
    }
    return options;
  }, [effective.columns]);

  const changeDraft = (patch: Partial<PosterWallLayoutDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    // 选择新值后不再展示上一次的成功信息，避免误读为已生效。
    setNotice('');
    setFailed(false);
  };

  const handleReset = () => {
    if (busy) return;
    setDraft({ ...effective });
    setNotice('');
    setFailed(false);
  };

  const handleApply = async () => {
    if (savingRef.current || externalBusy || !dirty) return;
    const target = { ...draft };
    savingRef.current = true;
    setSaving(true);
    setNotice('');
    setFailed(false);
    try {
      const updated = await onSave({
        poster_size: target.columns,
        series_card_image_mode: target.mode,
      });
      const result = readLayout(updated);
      if (!result) {
        setFailed(true);
        setNotice(INVALID_RESPONSE_MESSAGE);
        return;
      }
      setPosterWallLayout({ posterSize: result.columns, seriesCardImageMode: result.mode });
      serverRef.current = result;
      setEffective(result);
      setDraft(result);
      setFailed(false);
      setNotice('作品墙设置已保存，返回作品列表即可查看');
    } catch (cause) {
      setFailed(true);
      setNotice(cause instanceof Error && cause.message === INVALID_RESPONSE_MESSAGE
        ? INVALID_RESPONSE_MESSAGE
        : '作品墙设置未能保存，请重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="作品墙布局"
      description="调整分类、收藏与搜索的作品墙；封面比例也用于首页分类预览。窗口较窄时会自动减少列数。点击应用后，返回作品列表即可看到新布局。"
    >
      <div className="kp-settings-form">
        <SettingsField label="封面比例" description="竖版封面按 2:3 显示；横向海报按 16:9 显示。">
          <Select
            value={draft.mode}
            disabled={busy}
            onChange={(_, data) => changeDraft({ mode: data.value as SeriesCardImageMode })}
          >
            <option value="poster">竖版封面</option>
            <option value="fanart">横向海报</option>
          </Select>
        </SettingsField>
        <SettingsField label="封面大小" description={`目标每行 ${draft.columns} 列；窗口较窄时会自动减少，重新拉宽后恢复该目标。`}>
          <Select
            value={String(draft.columns)}
            disabled={busy}
            onChange={(_, data) => changeDraft({ columns: Number(data.value) })}
          >
            {sizeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </SettingsField>
        <div className="kp-poster-wall-actions">
          <Button appearance="primary" disabled={busy || !dirty} onClick={() => void handleApply()}>
            {saving ? '正在保存…' : '应用作品墙设置'}
          </Button>
          <Button appearance="secondary" disabled={busy || !dirty} onClick={handleReset}>
            还原选择
          </Button>
        </div>
        {saving && <SettingsFeedback busy>正在保存作品墙设置…</SettingsFeedback>}
        {notice && <SettingsFeedback intent={failed ? 'error' : 'success'}>{notice}</SettingsFeedback>}
      </div>
    </SettingsSection>
  );
}
