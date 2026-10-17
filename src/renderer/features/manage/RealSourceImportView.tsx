import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSettings } from '@/shared/api/service-context';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { SegmentedControl } from '@/shared/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import { ProgressBar, StatusChip } from '@/shared/ui/Surface';
import { useImportSession, type ImportMode } from './useImportSession';
import styles from './MediaManagementPage.module.css';

const MODES: readonly { value: ImportMode; label: string }[] = [
  { value: 'local', label: '本地目录' }, { value: 'tree', label: '目录树 TXT' },
  { value: 'openlist', label: 'OpenList' }, { value: 'hybrid', label: 'TXT + OpenList' },
];

/** 真实导入子视图沿用统一框架，不重复渲染卡片和任务表。 */
export function RealSourceImportView({ view, rootId, onOpenTasks }: {
  readonly view: 'overview' | 'import' | 'maintenance'; readonly rootId: string; readonly onOpenTasks: () => void;
}) {
  const session = useImportSession(rootId, view === 'import');
  const settings = useSettings();
  const navigate = useNavigate();
  // 多解候选必须由用户显式选中后才提交，不预选第一项。
  const [mappingChoice, setMappingChoice] = useState('');
  if (view === 'overview') return null;
  if (view === 'maintenance') return <section className={styles.panel}>
    <h2 className={styles.panelTitle}>媒体记录维护</h2>
    <p className={styles.panelHint}>作品的匹配、标题与图片修改，以及移除操作，位于作品详情的「资料与管理」。任务失败可在任务中心查看并重试。</p>
    <div className={styles.panelActions}>
      <Button variant="outline" onClick={onOpenTasks}>打开任务中心</Button>
      <Button variant="outline" onClick={() => navigate('/settings')}>打开设置</Button>
    </div>
  </section>;
  const { scan, preview, busy } = session;
  const mapping = session.mapping;
  const mappingOptions = mapping?.choices ?? [];
  // 候选刷新后旧选择可能已经失效：不再匹配就不允许提交。
  const selectedMappingChoice = mappingOptions.some((choice) => choice.id === mappingChoice) ? mappingChoice : '';
  const scanned = !!scan && (scan.status === 'completed' || scan.status === 'validated');
  const active = !!scan && ['queued', 'running', 'cancelling'].includes(scan.status);
  const step = preview ? 2 : scan ? 1 : 0;
  const network = session.mode === 'openlist' || session.mode === 'hybrid';

  return <div className={styles.importFlow}>
    <ol className={styles.steps} aria-label="导入步骤">
      {['选择目录或清单', '扫描与识别', '核对并确认'].map((label, index) => <li key={label}
        className={index === step ? styles.stepActive : index < step ? styles.stepDone : styles.step}
        aria-current={index === step ? 'step' : undefined}><span className={styles.stepIndex}>{index + 1}</span>{label}</li>)}
    </ol>
    {session.message ? <p className={styles.notice} role={session.error ? 'alert' : 'status'}>{session.message}</p> : null}
    {session.restoreError ? <p className={styles.notice} role="alert">无法恢复导入状态：{session.restoreError.message}</p> : null}

    <section className={`${styles.panel} ${styles.importPanel}`} aria-label="导入配置">
      <header>
        <h2 className={styles.panelTitle}>{rootId ? session.card?.name ?? '更新已有导入' : '创建导入'}</h2>
        {rootId ? <p className={styles.panelHint}>{session.card?.location} · 更新会保留同一张导入卡片。</p> : null}
      </header>
      <fieldset disabled={busy || active} className={styles.importFields}>
        <SegmentedControl ariaLabel="导入方式" value={session.mode} onValueChange={session.setMode}
          options={MODES.map((option) => ({ ...option, disabled: !!rootId && option.value !== session.mode }))} />
        {!rootId ? <label className={styles.field}>导入名称（可选）
          <Input value={session.name} onChange={(event) => session.setName(event.currentTarget.value)} placeholder="例如：动画目录树" />
        </label> : null}
        <div className={styles.fieldRow}>
          <label className={styles.field}>内容范围
            <Select value={session.scope} onValueChange={(value) => session.setScope(value === 'ongoing' ? 'ongoing' : 'library')}>
              <SelectTrigger aria-label="内容范围"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="library">媒体库</SelectItem><SelectItem value="ongoing">新番追更</SelectItem></SelectContent>
            </Select>
          </label>
          {session.mode === 'tree' ? <label className={styles.field}>目录树格式
            <Select value={session.provider} onValueChange={(value) => session.setProvider(value as 'pan115' | 'baidu' | 'quark')}>
              <SelectTrigger aria-label="目录树格式"><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="pan115">115</SelectItem><SelectItem value="baidu">百度网盘</SelectItem><SelectItem value="quark">夸克</SelectItem>
              </SelectContent>
            </Select>
          </label> : null}
        </div>
        {network ? <label className={styles.field}>OpenList 连接
          <Select value={session.connectionId || 'default'} onValueChange={(value) => session.setConnectionId(value === 'default' ? '' : value)}>
            <SelectTrigger aria-label="OpenList 连接"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="default">使用默认连接</SelectItem>
              {settings.data?.openlist.connections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </label> : null}
        {session.mode !== 'tree' ? <label className={styles.field}>{network ? '远端目录（留空使用已保存目录）' : '本地目录路径'}
          <Input aria-label={network ? '远端目录' : '本地目录路径'} value={session.rootPath}
            onChange={(event) => session.setRootPath(event.currentTarget.value)} placeholder={network ? '/anime' : '填写媒体所在目录'} />
        </label> : null}
        {session.mode === 'tree' || session.mode === 'hybrid' ? <label className={styles.field}>目录树 TXT 路径
          <Input aria-label="目录树 TXT 路径" value={session.treePath} onChange={(event) => session.setTreePath(event.currentTarget.value)} placeholder="填写新导出的 TXT 文件路径" />
          <span className={styles.fieldHint}>填写这台电脑上的文件路径；更新目录树需要提供新的 TXT 文件。</span>
        </label> : null}
      </fieldset>
      <div className={styles.panelActions}>
        <Button loading={busy} disabled={active} onClick={() => void session.start()}>开始扫描</Button>
        {scan?.resumable ? <Button variant="outline" loading={busy} onClick={() => void session.start(true)}>继续扫描</Button> : null}
        {scan?.canCancel ? <Button variant="ghost" loading={busy} onClick={() => void session.cancel()}>取消扫描</Button> : null}
      </div>
    </section>

    {mapping ? <section className={`${styles.panel} ${styles.importPanel}`} aria-label="目录映射选择">
      <header className={styles.sectionHead}>
        <h2 className={styles.panelTitle}>需要选择目录映射</h2>
        <StatusChip tone="warning">待选择</StatusChip>
      </header>
      <p className={styles.panelHint}>
        这份 TXT / 来源目录在本地有多个可能的挂载位置。这是 TXT / 来源目录到本地挂载位置的映射选择，选择前不会开始扫描。
      </p>
      {mapping.reason ? <p className={styles.fieldHint}>后端说明：{mapping.reason}</p> : null}
      <div className={styles.sourceChoices} role="radiogroup" aria-label="目录映射候选">
        {mappingOptions.map((choice) => <div key={choice.id} className={styles.issue}>
          <label className={styles.issueHead}>
            <input type="radio" name="import-tree-mapping" value={choice.id}
              checked={selectedMappingChoice === choice.id}
              disabled={busy}
              onChange={() => setMappingChoice(choice.id)} />
            <strong>{choice.root || choice.id}</strong>
          </label>
          <p className={styles.sourceMeta}>
            <span>映射范围：{choice.mappingScope || '未标注'}</span>
            <span>进入扫描 {choice.selectedCount} 项</span>
            <span>跳过 {choice.skippedCount} 项</span>
          </p>
          {choice.pathSamples.slice(0, 3).map((sample) => <p key={sample}
            className={styles.sourceLocation} title={sample}>{sample}</p>)}
        </div>)}
      </div>
      <div className={styles.panelActions}>
        <Button loading={busy} disabled={!selectedMappingChoice}
          onClick={() => void session.chooseMapping(selectedMappingChoice)}>使用这个映射继续扫描</Button>
        <Button variant="outline" disabled={busy} onClick={session.cancelMapping}>取消</Button>
      </div>
    </section> : null}

    {scan ? <section className={`${styles.panel} ${styles.importPanel}`} aria-label="扫描进度">
      <h2 className={styles.panelTitle}>{scanned ? '扫描完成' : scan.status === 'failed' ? '扫描失败' : scan.status === 'cancelled' ? '扫描已取消' : '正在扫描'}</h2>
      <p className={styles.panelHint}>{scan.error || scan.stageLabel || '正在读取目录'}
        {scan.totalCount > 0 ? ` · 已处理 ${scan.processedCount} / ${scan.totalCount}` : ''}</p>
      {active ? <ProgressBar value={scan.progress} label="扫描进度" /> : null}
      {scan.currentDirectory ? <p className={styles.sourceLocation} title={scan.currentDirectory}>{scan.currentDirectory}</p> : null}
      <div className={styles.panelActions}>
        <Button variant="outline" loading={busy} disabled={!scanned} onClick={() => void session.review()}>生成识别预览</Button>
      </div>
    </section> : null}

    {preview ? <section className={`${styles.panel} ${styles.importPanel}`} aria-label="审核识别结果">
      <header className={styles.sectionHead}><h2 className={styles.panelTitle}>审核识别结果</h2>
        <StatusChip tone={preview.blockingIssueCount ? 'warning' : 'success'}>{preview.blockingIssueCount ? `${preview.blockingIssueCount} 个阻断问题` : '无阻断问题'}</StatusChip></header>
      <p className={styles.panelHint}>作品 {preview.workCount} · 剧集 {preview.episodeCount}</p>
      <ul className={styles.issueList}>{preview.issues.map((issue) => <li key={issue.id} className={styles.issue}>
        <strong>{issue.title}</strong><p className={styles.issueDetail}>{issue.detail}</p>
      </li>)}</ul>
      <div className={styles.panelActions}>
        <Button loading={busy} disabled={preview.blockingIssueCount > 0} onClick={() => void session.confirm()}>确认并执行</Button>
        <Button variant="outline" onClick={onOpenTasks}>打开任务中心</Button>
      </div>
    </section> : null}
  </div>;
}
