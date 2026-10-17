import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Input,
  Spinner,
} from '@fluentui/react-components';
import { CheckmarkCircleRegular, DismissRegular, TagAddRegular } from '@fluentui/react-icons';
import { workCustomizationApi, type ExtraVideoOverview, type WorkDetailTag } from '../../api/workCustomization';
import { useUiStore, type DetailTagPreset } from '../../stores/ui';
import './work-customization-tags.css';

interface WorkCustomizationTagsProps {
  workId: string;
  sources: string[];
  metadataStatus: ReactNode;
  typeTags: string[];
}

const DEFAULT_TAG_COLOR = '#7c9cff';

function makeTagId(): string {
  return globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `tag_${Date.now().toString(36)}`;
}

function dedupeTags(tags: WorkDetailTag[]): WorkDetailTag[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.label.trim().toLocaleLowerCase();
    if (!tag.label.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

function isValidTagList(value: unknown): value is WorkDetailTag[] {
  return Array.isArray(value) && value.length <= 16 && value.every((tag) => (
    !!tag
    && typeof tag.id === 'string'
    && typeof tag.label === 'string'
    && typeof tag.color === 'string'
    && /^#[0-9a-f]{6}$/i.test(tag.color)
  ));
}

export default function WorkCustomizationTags({ workId, sources, metadataStatus, typeTags }: WorkCustomizationTagsProps) {
  const presets = useUiStore((state) => state.detailTagPresets);
  const savePreset = useUiStore((state) => state.saveDetailTagPreset);
  const removePreset = useUiStore((state) => state.removeDetailTagPreset);
  const remindersEnabled = useUiStore((state) => state.extraVideoRemindersEnabled);
  const includeAuxiliary = useUiStore((state) => state.includeAuxiliaryVideoReminders);
  const [tags, setTags] = useState<WorkDetailTag[]>([]);
  const [overview, setOverview] = useState<ExtraVideoOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [customizationLoaded, setCustomizationLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const requestGeneration = useRef(0);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(DEFAULT_TAG_COLOR);
  const [saveError, setSaveError] = useState('');

  useLayoutEffect(() => {
    let cancelled = false;
    const generation = ++requestGeneration.current;
    setTags([]);
    setOverview(null);
    setSaveError('');
    setLoadError('');
    setCustomizationLoaded(false);
    setLoading(true);
    setSaving(false);
    setDialogOpen(false);
    setEditingTagId(null);
    void Promise.allSettled([
      workCustomizationApi.get(workId),
      workCustomizationApi.getExtraVideos(workId),
    ]).then(([customizationResult, overviewResult]) => {
      if (cancelled || generation !== requestGeneration.current) return;
      const errors: string[] = [];
      if (customizationResult.status === 'fulfilled'
        && customizationResult.value.work_id === workId
        && isValidTagList(customizationResult.value.tags)) {
        setTags(dedupeTags(customizationResult.value.tags || []));
        setCustomizationLoaded(true);
      } else {
        errors.push('作品标签读取失败，重试成功后才能编辑或保存标签。');
      }
      if (overviewResult.status === 'fulfilled' && overviewResult.value.work_id === workId) setOverview(overviewResult.value);
      else errors.push('额外视频摘要读取失败，可重试。');
      setLoadError(errors.join(' '));
      setLoading(false);
    });
    return () => {
      cancelled = true;
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [workId, loadAttempt]);

  const filteredTypeTags = useMemo(() => typeTags.filter((tag) => {
    const normalized = tag.trim().toLocaleLowerCase();
    return normalized && !['动画', '动漫', 'アニメ', 'アニメーション', 'anime', 'animation'].includes(normalized);
  }), [typeTags]);

  const persistTags = async (next: WorkDetailTag[]): Promise<boolean> => {
    if (!customizationLoaded) {
      setSaveError('作品标签尚未成功读取，请先重试读取。');
      return false;
    }
    const generation = requestGeneration.current;
    const requestWorkId = workId;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await workCustomizationApi.saveTags(requestWorkId, dedupeTags(next));
      if (generation !== requestGeneration.current) return false;
      if (saved.work_id !== requestWorkId || !isValidTagList(saved.tags)) {
        throw new Error('标签保存响应无效，请重试。');
      }
      setTags(saved.tags || []);
      return true;
    } catch (error) {
      if (generation === requestGeneration.current) setSaveError((error as Error).message || '标签保存失败');
      return false;
    } finally {
      if (generation === requestGeneration.current) setSaving(false);
    }
  };

  const assignPreset = async (preset: DetailTagPreset) => {
    if (!customizationLoaded || saving || tags.some((tag) => tag.label.toLocaleLowerCase() === preset.label.toLocaleLowerCase())) return;
    const next = dedupeTags([...tags, preset]);
    await persistTags(next);
  };

  const openNewTagDialog = () => {
    setEditingTagId(null);
    setLabel('');
    setColor(DEFAULT_TAG_COLOR);
    setSaveError('');
    setDialogOpen(true);
  };

  const editTag = (tag: WorkDetailTag) => {
    setEditingTagId(tag.id);
    setLabel(tag.label);
    setColor(tag.color);
    setSaveError('');
    setDialogOpen(true);
  };

  const saveTag = async () => {
    const cleanLabel = label.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 24);
    if (!cleanLabel || saving || !customizationLoaded) return;
    const editingTag = editingTagId ? tags.find((tag) => tag.id === editingTagId) : undefined;
    if (tags.some((tag) => tag.id !== editingTag?.id && tag.label.toLocaleLowerCase() === cleanLabel.toLocaleLowerCase())) {
      setSaveError('已有同名标签，请使用不同名称。');
      return;
    }
    const nextTag = { id: editingTag?.id || makeTagId(), label: cleanLabel, color };
    const next = editingTag
      ? dedupeTags(tags.map((tag) => tag.id === editingTag.id ? nextTag : tag))
      : dedupeTags([...tags, nextTag]);
    if (!editingTag && next.length === tags.length) return;
    if (!await persistTags(next)) return;
    savePreset(nextTag);
    setLabel('');
    setColor(DEFAULT_TAG_COLOR);
    setEditingTagId(null);
    setDialogOpen(false);
  };

  const removeTag = async (tagId: string) => {
    if (saving || !customizationLoaded) return;
    const next = tags.filter((tag) => tag.id !== tagId);
    await persistTags(next);
  };

  const visibleAuxiliaryCount = includeAuxiliary ? overview?.auxiliary_count || 0 : 0;
  const substantiveCount = overview?.substantive_special_count || 0;
  const unmatchedCount = (overview?.unmatched_count || 0) + (overview?.uncertain_count || 0);
  const hasReminder = remindersEnabled && (substantiveCount > 0 || unmatchedCount > 0 || visibleAuxiliaryCount > 0);

  return (
    <div className="detail-customization-groups" aria-busy={loading || saving}>
      {(sources.length > 0 || metadataStatus) && (
        <div className="detail-customization-context">
          {sources.length > 0 && (
            <section className="detail-customization-group" aria-label="来源">
              <span className="detail-customization-label">来源</span>
              <div className="detail-customization-values">
                {sources.map((source) => <span className="detail-customization-chip source" key={source}>{source}</span>)}
              </div>
            </section>
          )}
          {metadataStatus && (
            <section className="detail-customization-group" aria-label="资料同步状态">
              <span className="detail-customization-label">资料</span>
              <div className="detail-customization-values">{metadataStatus}</div>
            </section>
          )}
        </div>
      )}

      <section className="detail-customization-group" aria-label="类型与自定义标签">
        <span className="detail-customization-label">类型与标签</span>
        <div className="detail-customization-values">
          {filteredTypeTags.map((tag) => <span className="detail-customization-chip type" key={tag}>{tag}</span>)}
          {tags.map((tag) => (
            <span className="detail-customization-chip user" key={tag.id} style={{ '--work-tag-color': tag.color } as React.CSSProperties}>
              <button type="button" className="edit" onClick={() => editTag(tag)} aria-label={`编辑标签 ${tag.label}`} disabled={saving}>
                {tag.label}
              </button>
              <button type="button" className="remove" onClick={() => removeTag(tag.id)} aria-label={`移除标签 ${tag.label}`} disabled={saving}>×</button>
            </span>
          ))}
          {loading && <Spinner size="tiny" aria-label="正在读取标签" />}
          <Dialog open={dialogOpen} onOpenChange={(_, data) => setDialogOpen(data.open)}>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="subtle" size="small" icon={<TagAddRegular />} aria-label="管理自定义标签" disabled={!customizationLoaded || saving} onClick={openNewTagDialog} />
            </DialogTrigger>
            <DialogSurface className="work-tag-dialog">
              <DialogBody>
                <DialogTitle>{editingTagId ? '编辑作品标签' : '自定义作品标签'}</DialogTitle>
                <DialogContent>
                  <div className="work-tag-dialog-content">
                    {!editingTagId && <div className="work-tag-quick-list" aria-label="快捷标签">
                      {presets.map((preset) => (
                        <div className="work-tag-preset" key={preset.id}>
                          <Button appearance="secondary" size="small" onClick={() => assignPreset(preset)} disabled={!customizationLoaded || saving || tags.length >= 16}>
                            <span className="work-tag-color-dot" style={{ background: preset.color }} />{preset.label}
                          </Button>
                          <Button appearance="subtle" size="small" icon={<DismissRegular />} aria-label={`删除快捷标签 ${preset.label}`} onClick={() => removePreset(preset.id)} />
                        </div>
                      ))}
                      {presets.length === 0 && <p className="work-tag-empty">新增标签后会保存在快捷列表中，供其他作品复用。</p>}
                    </div>}
                    <label className="work-tag-editor-field">
                      <span>标签名称</span>
                      <Input
                        value={label}
                        maxLength={24}
                        onChange={(_, data) => setLabel(data.value)}
                        placeholder={editingTagId ? undefined : '例如：收藏待看'}
                      />
                    </label>
                    <label className="work-tag-editor-field color">
                      <span>标签颜色</span>
                      <input type="color" value={color} onChange={(event) => setColor(event.currentTarget.value)} aria-label="选择标签颜色" />
                    </label>
                    {saveError && <div className="work-tag-error" role="alert">{saveError}</div>}
                    <div className="work-tag-dialog-actions">
                      <DialogTrigger disableButtonEnhancement>
                        <Button appearance="secondary">完成</Button>
                      </DialogTrigger>
                      <Button appearance="primary" onClick={saveTag} disabled={!label.trim() || saving || !customizationLoaded || (!editingTagId && tags.length >= 16)}>
                        {saving ? '保存中…' : editingTagId ? '保存修改' : '添加到作品'}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      </section>

      {loadError && (
        <div className="detail-customization-error" role="alert">
          <span>{loadError}</span>
          <Button appearance="subtle" size="small" onClick={() => setLoadAttempt((attempt) => attempt + 1)} disabled={loading}>
            {loading ? '正在重试…' : '重试'}
          </Button>
        </div>
      )}

      {hasReminder && overview && (
        <div className="detail-extra-video-hint" role="note">
          <CheckmarkCircleRegular aria-hidden="true" />
          <span>
            {substantiveCount > 0 && `已保存特别篇线索 ${substantiveCount} 项`}
            {substantiveCount > 0 && unmatchedCount > 0 && ' · '}
            {unmatchedCount > 0 && `可能未匹配视频 ${unmatchedCount} 项，需核对`}
            {(substantiveCount > 0 || unmatchedCount > 0) && visibleAuxiliaryCount > 0 && ' · '}
            {visibleAuxiliaryCount > 0 && `辅助视频 ${visibleAuxiliaryCount} 项`}
            {overview.categories?.flatMap((item) => item.reasons).slice(0, 2).join('；') && (
              <small>{overview.categories.flatMap((item) => item.reasons).slice(0, 2).join('；')}</small>
            )}
            {overview.reasons.length > 0 && <small>{overview.reasons[0]}</small>}
          </span>
        </div>
      )}
    </div>
  );
}
