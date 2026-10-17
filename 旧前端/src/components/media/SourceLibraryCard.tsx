import { Button, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, ProgressBar } from '@fluentui/react-components'
import type { ButtonProps } from '@fluentui/react-components'
import { ArrowSync24Regular, ChevronDown20Regular, ChevronUp20Regular, Delete24Regular, Dismiss24Regular, DocumentText24Regular, Edit24Regular, MoreHorizontal24Regular } from '@fluentui/react-icons'
import type { V4SourceLibraryCard } from '../../api/mediaV4'
import { MediaProviderIcon, providerVisualFor } from './MediaProviderIcon'

interface SourceLibraryCardProps {
  card: V4SourceLibraryCard
  providerLabel: string
  methodLabel: string
  stateLabel: string
  progressLabel: string
  scale: { works: string; files: string }
  expanded: boolean
  primary: { label: string; icon: ButtonProps['icon']; appearance: 'primary' | 'secondary'; disabled: boolean; onClick: () => void }
  canUpdate: boolean
  updateDisabled: boolean
  canManage: boolean
  canCancel: boolean
  cancelling: boolean
  cleanupActive: boolean
  onToggleDetails: () => void
  onUpdate: () => void
  onCancel: () => void
  onRetryCleanup: () => void
  onExport: () => void
  onRename: () => void
  onRemove: () => void
}

/** 常用操作始终在同一行；展开只增加信息，维护操作通过 Fluent 菜单进入。 */
export default function SourceLibraryCard({ card, providerLabel, methodLabel, stateLabel, progressLabel, scale, expanded, primary, canUpdate, updateDisabled, canManage, canCancel, cancelling, cleanupActive, onToggleDetails, onUpdate, onCancel, onRetryCleanup, onExport, onRename, onRemove }: SourceLibraryCardProps) {
  const detailsId = `source-details-${card.root_id}`
  const total = card.artwork_total_count ?? 0
  const ready = card.artwork_ready_count ?? 0
  return <article className={`media-v4-library-source-card ${card.active_task ? 'active' : 'settled'} ${expanded ? 'expanded' : ''}`} aria-labelledby={`source-card-${card.root_id}`}>
    <div className="media-v4-source-card-main">
      <header className="media-v4-source-card-heading">
        <h3 id={`source-card-${card.root_id}`} title={card.display_name}>{card.display_name}</h3>
        <span className={`media-v4-source-card-state media-v4-source-card-state-${card.overall_status ?? 'completed'}`}>{stateLabel}</span>
        <Menu positioning="below-end">
          <MenuTrigger disableButtonEnhancement><Button appearance="subtle" size="small" icon={<MoreHorizontal24Regular />} aria-label={`${card.display_name}更多操作`} /></MenuTrigger>
          <MenuPopover><MenuList>
            <MenuItem icon={<DocumentText24Regular />} onClick={onExport}>导出问题分析</MenuItem>
            {canCancel && <MenuItem icon={<Dismiss24Regular />} disabled={cancelling} onClick={onCancel}>{cancelling ? '正在终止…' : '终止任务'}</MenuItem>}
            {card.pending_cleanup && <MenuItem icon={<Delete24Regular />} disabled={cleanupActive} onClick={onRetryCleanup}>{cleanupActive ? '清理中' : '重试清理'}</MenuItem>}
            {canManage && <><MenuDivider /><MenuItem icon={<Edit24Regular />} aria-label={`重命名来源卡：${card.display_name}`} onClick={onRename}>重命名</MenuItem>
              <MenuItem className="media-v4-source-menu-danger" icon={<Delete24Regular />} aria-label={`删除来源卡：${card.display_name}`} onClick={onRemove}>删除来源卡</MenuItem></>}
          </MenuList></MenuPopover>
        </Menu>
      </header>
      <div className="media-v4-source-card-identity">
        <span className="media-v4-source-provider-icon" aria-hidden="true"><MediaProviderIcon provider={providerVisualFor(card.provider)} size={20} /></span>
        <span>{providerLabel}</span><span className="media-v4-source-card-method-label">{methodLabel}</span>
      </div>
      <div className="media-v4-source-card-scale">
        <div className="media-v4-source-card-stats">{scale.works && <span>{scale.works}</span>}{scale.files && <span>{scale.files}</span>}</div>
        <div className="media-v4-source-card-summary">
          <span className="media-v4-source-card-progress" title={progressLabel}>{progressLabel}</span>
          {total > 0 && <div className="media-v4-source-card-artwork"><span>图片 {ready} / {total} 张</span><ProgressBar value={Math.min(ready, total) / total} aria-label={`${card.display_name}图片准备进度`} /></div>}
          {card.attention_count > 0 && <span className="media-v4-source-card-attention">{card.attention_count} 项待处理</span>}
        </div>
      </div>
      <footer className="media-v4-source-card-footer">
        <div className="media-v4-source-card-actions" role="group" aria-label="导入与更新">
          <Button size="small" className={`media-v4-source-card-action ${primary.appearance}`} appearance={primary.appearance} icon={primary.icon} disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</Button>
          {canUpdate && <Button size="small" appearance="secondary" icon={<ArrowSync24Regular />} disabled={updateDisabled} onClick={onUpdate}>检查更新</Button>}
        </div>
        <Button className="media-v4-source-card-expand" appearance="subtle" size="small" icon={expanded ? <ChevronUp20Regular /> : <ChevronDown20Regular />} aria-expanded={expanded} aria-controls={detailsId} aria-label={`${expanded ? '收起' : '展开'}${card.display_name}来源详情`} onClick={onToggleDetails}>{expanded ? '收起详情' : '详情'}</Button>
      </footer>
    </div>
    {expanded && <section id={detailsId} className="media-v4-source-card-details" aria-label={`${card.display_name}来源详情`}>
      {(card.tree_file_path || card.source_locator || card.display_path) && <div className="media-v4-source-card-detail-field"><span>来源位置</span><span className="media-v4-source-card-locator" title={card.tree_file_path || card.source_locator || card.display_path}>{card.tree_file_path || card.source_locator || card.display_path}</span></div>}
      {typeof card.metadata_ready_work_count === 'number' && (card.work_count ?? 0) > 0 && <div className="media-v4-source-card-detail-field"><span>在线资料</span><span>{card.metadata_ready_work_count} / {card.work_count} 部已就绪{(card.metadata_ready_retained_count ?? 0) > 0 ? `（${card.metadata_ready_retained_count} 部沿用上次资料）` : ''}</span></div>}
      {card.last_error && card.overall_status === 'needs_attention' && <p className="media-v4-source-card-error" role="alert">{card.last_error}</p>}
      {(card.relation_pending_count ?? 0) > 0 && <p>{card.relation_pending_count} 项关联信息待补全，不影响入库和播放</p>}
      {card.pending_cleanup && <p>{cleanupActive ? '正在清理上次生成文件' : '上次生成文件清理未完成'}</p>}
    </section>}
  </article>
}
