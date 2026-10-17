/**
 * 设置：应用 / 外观 / 媒体来源 / WebDAV 设置 / 元数据与图片 / 播放 / 账户与同步 / 关于。
 *
 * 分工（协作规范 §3 已批准表）：
 * - 后端配置项经 `updateSettings` 写入 `PATCH /api/config`，保存失败保留草稿且不宣称已保存。
 * - 主题 / 材质 / 动效 / 导航偏好是本机 UI 偏好，不冒充后端配置。
 * - 浏览器没有原生目录选择、托盘、自启、打开配置文件夹的能力：这些行明确标注不可用，
 *   不放置看起来能成功的假开关。
 * - 凭据（TMDB / Bangumi / OpenList 密码）只提交给本机后端凭据层，空值表示不修改；
 *   前端不读取、不显示、不持久化任何已保存的凭据。
 */

import {
  Database,
  Info,
  KeyRound,
  Network,
  Palette,
  PlaySquare,
  Settings2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { BangumiAccountSession, RestorePreview, SettingsSection } from '../../shared/api/service';
import { demoQueryKeys, useMediaService, useSettings } from '../../shared/api/service-context';
import { ErrorSurface, LoadingSurface, StatusChip } from '../../shared/ui/Surface';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Slider } from '@/shared/ui/slider';
import { Switch } from '@/shared/ui/switch';
import { SegmentedControl } from '@/shared/ui/segmented';
import { THEME_LABELS } from '@/app/theme';
import { MaterialPreferences } from './MaterialPreferences';
import { useDemoState, updateDemoState } from '@/mock/demo-store';
import { useUiStore } from '@/app/ui-store';
import { pushDemoPreference } from '@/mock/preferences';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import styles from './SettingsPage.module.css';

type GroupKey = 'application' | 'appearance' | 'sources' | 'webdav' | 'scrape' | 'player' | 'account' | 'about';

const GROUPS: ReadonlyArray<{ key: GroupKey; label: string; icon: LucideIcon }> = [
  { key: 'application', label: '应用', icon: Settings2 },
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'sources', label: '媒体来源', icon: Database },
  { key: 'webdav', label: 'WebDAV 设置', icon: Network },
  { key: 'scrape', label: '元数据与图片', icon: KeyRound },
  { key: 'player', label: '播放', icon: PlaySquare },
  { key: 'account', label: '账户与同步', icon: UserRound },
  { key: 'about', label: '关于', icon: Info },
];

const INTERVAL_OPTIONS = [
  { value: '0', label: '关闭（仅手动）' },
  { value: '360', label: '每 6 小时' },
  { value: '720', label: '每 12 小时' },
  { value: '1440', label: '每天' },
] as const;

export function SettingsPage() {
  const settings = useSettings();
  const service = useMediaService();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<GroupKey>('application');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({});
  const contentRef = useRef<HTMLDivElement>(null);

  const save = useCallback(
    (section: SettingsSection, patch: Record<string, unknown>, message: string) => {
      void service
        .updateSettings(section, patch)
        .then(() => {
          setNotice(message);
          setDraft({});
          void queryClient.invalidateQueries({ queryKey: demoQueryKeys.settings });
        })
        .catch((error: unknown) => {
          // 保存失败保留草稿：不清空输入框，也不显示成功。
          setNotice(`未保存：${error instanceof Error ? error.message : '后端拒绝了这次修改'}`);
        });
    },
    [queryClient, service],
  );

  if (settings.isPending) {
    return <LoadingSurface label="正在读取设置" detail="正在从本机后端读取配置" />;
  }
  if (settings.isError || !settings.data) {
    return (
      <ErrorSurface
        detail={settings.error?.message ?? '设置读取失败'}
        onRetry={() => void settings.refetch()}
      />
    );
  }

  const data = settings.data;
  const setDraftValue = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const draftValue = (key: string, fallback: string) => draft[key] ?? fallback;

  return (
    <section className={styles.page} data-route="settings">
      <header className={styles.head}>
        <h1 className={styles.title}>设置</h1>
      </header>

      <div className={styles.layout}>
        <nav className={styles.outline} aria-label="设置分类">
          {GROUPS.map((group) => {
            const Icon = group.icon;
            return (
              <button
                key={group.key}
                type="button"
                className={group.key === active ? styles.outlineActive : styles.outlineItem}
                onClick={() => {
                  setActive(group.key);
                  setNotice('');
                  contentRef.current?.scrollTo({ top: 0 });
                }}
                aria-current={group.key === active ? 'true' : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{group.label}</span>
              </button>
            );
          })}
        </nav>

        <div className={styles.content} ref={contentRef} data-testid="settings-content">
          {notice ? (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          ) : null}

          {active === 'application' ? <ApplicationGroup /> : null}
          {active === 'appearance' ? <AppearanceGroup save={save} posterSize={data.appearance.posterSize} /> : null}
          {active === 'sources' ? (
            <SourcesGroup data={data} draftValue={draftValue} setDraftValue={setDraftValue} save={save} />
          ) : null}
          {active === 'webdav' ? (
            <WebDavGroup data={data} draftValue={draftValue} setDraftValue={setDraftValue} save={save} setNotice={setNotice} />
          ) : null}
          {active === 'scrape' ? (
            <ScrapeGroup data={data} draftValue={draftValue} setDraftValue={setDraftValue} save={save} />
          ) : null}
          {active === 'player' ? (
            <PlayerGroup data={data} draftValue={draftValue} setDraftValue={setDraftValue} save={save} setNotice={setNotice} />
          ) : null}
          {active === 'account' ? <AccountGroup data={data} save={save} setNotice={setNotice} /> : null}
          {active === 'about' ? <AboutGroup /> : null}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 应用 */

function ApplicationGroup() {
  const application = useSettingsValues().application;
  const service = useMediaService();
  const queryClient = useQueryClient();
  const openSetup = useUiStore((state) => state.openSetup);
  const startPage = useUiStore((state) => state.startPage);
  const setStartPage = useUiStore((state) => state.setStartPage);
  const sidebarDefault = useUiStore((state) => state.sidebarDefault);
  const setSidebarDefault = useUiStore((state) => state.setSidebarDefault);
  const [cacheNotice, setCacheNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const cleanup = async (phase: 'preview' | 'confirm') => {
    if (!service.previewArtworkCache || !service.confirmArtworkCache) {
      setCacheNotice('当前服务没有受管缓存清理能力（演示模式不清理任何文件）。');
      return;
    }
    setBusy(true);
    try {
      const preview = await service.previewArtworkCache(30);
      if (phase === 'preview') {
        setCacheNotice(
          `预览：可清理 ${preview.removableFiles} 个派生文件（约 ${formatBytes(preview.freedBytes)}），早于 ${preview.retentionDays} 天的缓存。确认后才会执行。`,
        );
        return;
      }
      const result = await service.confirmArtworkCache(preview.previewId, preview.digest);
      setCacheNotice(`已清理 ${result.removedFiles} 个派生文件，释放约 ${formatBytes(result.freedBytes)}。`);
    } catch (error) {
      setCacheNotice(`清理未执行：${error instanceof Error ? error.message : '后端拒绝'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="启动与窗口">
        <Row label="开机时自动启动" hint="需要桌面壳提供系统能力；浏览器版本不提供该开关。">
          <StatusChip tone="neutral">需要桌面版</StatusChip>
        </Row>
        <Row label="关闭主窗口时最小化到托盘" hint="需要桌面壳提供窗口与托盘能力；浏览器版本不提供该开关。">
          <StatusChip tone="neutral">需要桌面版</StatusChip>
        </Row>
        <Row label="界面连接监测" hint="与后端心跳一致；关闭后不显示连接状态。">
          <Switch
            checked={application.connectionMonitor}
            onCheckedChange={(value) => {
              void service
                .updateSettings('application', { connectionMonitor: value })
                .then(() => queryClient.invalidateQueries({ queryKey: demoQueryKeys.settings }))
                .catch((error: unknown) =>
                  setCacheNotice(error instanceof Error ? error.message : '保存失败'),
                );
            }}
            aria-label="界面连接监测"
          />
        </Row>
      </Panel>

      <Panel title="导航栏">
        <Row label="默认显示界面" hint="启动后首先打开的页面。">
          <SegmentedControl
            ariaLabel="默认显示界面"
            value={startPage}
            onValueChange={(value) => {
              setStartPage(value);
              pushDemoPreference({ startPage: value });
            }}
            options={[
              { value: 'home', label: '首页' },
              { value: 'library', label: '媒体库' },
              { value: 'recent', label: '最近观看' },
              { value: 'favorites', label: '收藏' },
            ]}
          />
        </Row>
        <Row label="默认侧栏状态" hint="展开 / 图标栏 / 完全隐藏。">
          <SegmentedControl
            ariaLabel="默认侧栏状态"
            value={sidebarDefault}
            onValueChange={(value) => {
              setSidebarDefault(value);
              pushDemoPreference({ sidebarDefault: value });
            }}
            options={[
              { value: 'expanded', label: '展开' },
              { value: 'collapsed', label: '图标栏' },
              { value: 'hidden', label: '隐藏' },
            ]}
          />
        </Row>
      </Panel>

      <Panel title="语言与地区">
        <Row label="界面语言" hint="首版只提供简体中文。">
          <StatusChip tone="neutral">简体中文</StatusChip>
        </Row>
      </Panel>

      <Panel title="设置引导" hint="完成与「稍后设置」分开记录；未完成的配置不会被标记为已完成。">
        <Row label="首次设置引导">
          <div className={styles.rowControl}>
            <StatusChip
              tone={application.setupCompleted ? 'success' : application.setupDeferred ? 'warning' : 'neutral'}
            >
              {application.setupCompleted ? '已完成' : application.setupDeferred ? '稍后设置' : '未完成'}
            </StatusChip>
            <Button size="xs" variant="outline" onClick={openSetup}>
              {application.setupCompleted ? '重新运行引导' : '继续设置引导'}
            </Button>
          </div>
        </Row>
      </Panel>

      <Panel title="数据与缓存">
        <Row label="受管图片缓存" hint="只清理程序生成的派生图片；不改动原图、媒体与播放记录。">
          <div className={styles.rowControl}>
            <Button size="xs" variant="outline" loading={busy} onClick={() => void cleanup('preview')}>
              预览可清理内容
            </Button>
            <Button size="xs" variant="outline" loading={busy} onClick={() => void cleanup('confirm')}>
              确认清理
            </Button>
          </div>
        </Row>
        {cacheNotice ? <p className={styles.panelHint}>{cacheNotice}</p> : null}
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ 外观 */

function AppearanceGroup({ save, posterSize }: { readonly save: GroupProps['save']; readonly posterSize: number }) {
  const appearance = useDemoState().settings.appearance;
  // 设置显示持久默认值；分类页临时调整不能反向冒充已保存配置。
  const [posterColumns, setPosterColumns] = useState(() => Math.min(9, Math.max(6, Math.round(posterSize))));
  const setSessionPosterColumns = useUiStore((state) => state.setPosterColumns);

  const patchAppearance = (patch: Partial<typeof appearance>) => {
    updateDemoState((current) => ({ settings: { ...current.settings, appearance: { ...current.settings.appearance, ...patch } } }));
  };

  return (
    <>
      <Panel title="主题">
        <Row label="界面主题" hint="两个主题：纯白与深色。">
          <SegmentedControl
            ariaLabel="界面主题"
            value={appearance.theme === 'cinema' ? 'cinema' : 'mica'}
            onValueChange={(value) => patchAppearance({ theme: value })}
            options={THEME_LABELS.map((item) => ({ value: item.value as 'mica' | 'cinema', label: item.label }))}
          />
        </Row>
        <Row label="海报墙列数" hint="6–9 列；分类页内的滑块只改本次会话。">
          <div className={styles.rowControl}>
            <Slider
              className="w-40"
              min={6}
              max={9}
              step={1}
              value={[posterColumns]}
              onValueChange={(values) => {
                const columns = values[0] ?? posterColumns;
                setPosterColumns(columns);
                setSessionPosterColumns(columns);
              }}
              onValueCommit={(values) => save('appearance', { posterSize: values[0] ?? posterColumns }, '已保存海报墙列数')}
              aria-label="海报墙列数"
            />
            <span className="w-10 text-right text-[12px] tabular-nums text-muted-foreground">{posterColumns} 列</span>
          </div>
        </Row>
      </Panel>
      <MaterialPreferences />
      <Panel title="动效">
        <Row label="减少动态效果" hint="关闭过渡与轮播自动播放；系统减少动效同样生效。">
          <SegmentedControl
            ariaLabel="减少动态效果"
            value={appearance.motion}
            onValueChange={(value) => patchAppearance({ motion: value })}
            options={[
              { value: 'full', label: '标准' },
              { value: 'reduced', label: '减少' },
            ]}
          />
        </Row>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ 媒体来源 */

function SourcesGroup({
  data,
  draftValue,
  setDraftValue,
  save,
}: GroupProps) {
  const [path, setPath] = useState('');
  const roots = data.sources.localRoots;
  return (
    <>
      <Panel title="本地媒体库">
        <ul className={styles.list}>
          {roots.map((root) => (
            <li key={root.id} className={styles.listItem}>
              <div>
                <strong>{root.name}</strong>
                <p className={styles.listHint}>{root.path}</p>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  save(
                    'sources',
                    { localRoots: roots.filter((entry) => entry.id !== root.id).map(toLocalRootRecord) },
                    `已移除来源「${root.name}」`,
                  )
                }
              >
                移除
              </Button>
            </li>
          ))}
          {roots.length === 0 ? <li className={styles.listHint}>还没有登记本地目录。</li> : null}
        </ul>
      </Panel>

      <Panel
        title="添加本地目录"
        hint="浏览器不能弹出原生目录选择器：请粘贴本机绝对路径，由后端校验后登记。"
      >
        <Row label="目录路径" hint="例如 D:\\Media\\Anime">
          <div className={styles.rowControl}>
            <Input
              value={draftValue('newRoot', path)}
              onChange={(event) => {
                setPath(event.currentTarget.value);
                setDraftValue('newRoot', event.currentTarget.value);
              }}
              placeholder="D:\\Media\\Anime"
              aria-label="目录路径"
            />
            <Button
              size="xs"
              variant="outline"
              disabled={draftValue('newRoot', path).trim().length === 0}
              onClick={() =>
                save(
                  'sources',
                  {
                    localRoots: [
                      ...roots.map(toLocalRootRecord),
                      { path: draftValue('newRoot', path).trim() },
                    ],
                  },
                  '已添加本地目录',
                )
              }
            >
              添加
            </Button>
          </div>
        </Row>
      </Panel>

      <Panel title="新番更新" hint="默认关闭；扫描入库仍在「媒体管理」手动确认。">
        <Row label="启动时检查新番更新">
          <Switch
            checked={data.sources.ongoingOnStartup}
            onCheckedChange={(value) => save('sources', { ongoingOnStartup: value }, '已保存启动更新设置')}
            aria-label="启动时检查新番更新"
          />
        </Row>
        <Row label="新番更新间隔" hint="0 表示不自动更新。">
          <Select
            label="新番更新间隔"
            value={String(data.sources.ongoingIntervalMinutes)}
            options={INTERVAL_OPTIONS}
            onChange={(value) => save('sources', { ongoingIntervalMinutes: Number(value) }, '已保存更新间隔')}
          />
        </Row>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ WebDAV */

function WebDavGroup({ data, draftValue, setDraftValue, save, setNotice = () => {} }: GroupProps) {
  const service = useMediaService();
  const schedules = useQuery({
    queryKey: ['scan-schedules'],
    enabled: typeof service.listScanSchedules === 'function',
    queryFn: () => service.listScanSchedules!(),
  });
  const connections = data.openlist.connections;

  return (
    <>
      <Panel title="WebDAV / OpenList 连接" hint="连接可用性由「测试」给出；列表只反映配置，不代表已连接。">
        <ul className={styles.list}>
          {connections.map((connection) => (
            <li key={connection.id} className={styles.listItem}>
              <div>
                <strong>{connection.name}</strong>
                <p className={styles.listHint}>
                  {connection.serverUrl || '未填写服务器地址'}
                  {connection.remoteRoot ? ` · 远端根 ${connection.remoteRoot}` : ''}
                  {connection.mountRoot ? ` · 本地挂载 ${connection.mountRoot}` : ''}
                </p>
              </div>
              <div className={styles.rowControl}>
                <StatusChip tone={connection.configured ? 'neutral' : 'warning'}>
                  {connection.configured ? '已配置' : '信息不完整'}
                </StatusChip>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={typeof service.testOpenListConnection !== 'function'}
                  onClick={() => {
                    if (!service.testOpenListConnection) {
                      setNotice('当前服务没有连接测试能力。');
                      return;
                    }
                    void service
                      .testOpenListConnection({ connectionId: connection.id })
                      .then((result) => setNotice(`连接测试：${result.message}`))
                      .catch((error: unknown) =>
                        setNotice(`连接测试失败：${error instanceof Error ? error.message : '后端拒绝'}`),
                      );
                  }}
                >
                  测试
                </Button>
              </div>
            </li>
          ))}
          {connections.length === 0 ? <li className={styles.listHint}>还没有配置 OpenList 连接。</li> : null}
        </ul>
      </Panel>

      <Panel title="连接设置" hint="凭据只提交给本机后端凭据层；留空表示不修改已保存的凭据。">
        <Row label="服务器地址">
          <Input
            value={draftValue('davUrl', connections[0]?.serverUrl ?? '')}
            onChange={(event) => setDraftValue('davUrl', event.currentTarget.value)}
            placeholder="http://127.0.0.1:5244/dav"
            aria-label="服务器地址"
          />
        </Row>
        <Row label="远端根目录">
          <Input
            value={draftValue('davRemote', connections[0]?.remoteRoot ?? '')}
            onChange={(event) => setDraftValue('davRemote', event.currentTarget.value)}
            placeholder="/kumiplayer"
            aria-label="远端根目录"
          />
        </Row>
        <Row label="本地挂载名 / 路径">
          <Input
            value={draftValue('davMount', connections[0]?.mountRoot ?? '')}
            onChange={(event) => setDraftValue('davMount', event.currentTarget.value)}
            placeholder="Z:\\OpenList"
            aria-label="本地挂载路径"
          />
        </Row>
        <Row label="OpenList 账号">
          <Input
            value={draftValue('davUser', '')}
            onChange={(event) => setDraftValue('davUser', event.currentTarget.value)}
            autoComplete="off"
            aria-label="OpenList 账号"
          />
        </Row>
        <Row label="OpenList 密码" hint="不显示已保存的密码；填写即更新。">
          <div className={styles.rowControl}>
            <Input
              type="password"
              value={draftValue('davPassword', '')}
              onChange={(event) => setDraftValue('davPassword', event.currentTarget.value)}
              autoComplete="new-password"
              aria-label="OpenList 密码"
            />
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                const patch: Record<string, unknown> = {};
                const url = draftValue('davUrl', connections[0]?.serverUrl ?? '').trim();
                const remote = draftValue('davRemote', connections[0]?.remoteRoot ?? '').trim();
                const mount = draftValue('davMount', connections[0]?.mountRoot ?? '').trim();
                const user = draftValue('davUser', '').trim();
                const password = draftValue('davPassword', '');
                if (url) patch.serverUrl = url;
                if (remote) patch.remoteRoot = remote;
                if (mount) patch.mountRoot = mount;
                if (user) patch.username = user;
                if (password) patch.password = password;
                if (Object.keys(patch).length === 0) {
                  setNotice('没有需要保存的修改。');
                  return;
                }
                save('openlist', patch, '已保存 OpenList 连接设置');
              }}
            >
              保存连接设置
            </Button>
          </div>
        </Row>
      </Panel>

      <Panel title="内容路由">
        <ul className={styles.list}>
          {data.openlist.routes.map((route) => (
            <li key={route.id} className={styles.listItem}>
              <div>
                <strong>{route.remote || route.label}</strong>
                <p className={styles.listHint}>{route.local || '未绑定本地路径'}</p>
              </div>
            </li>
          ))}
          {data.openlist.routes.length === 0 ? <li className={styles.listHint}>还没有内容路由。</li> : null}
        </ul>
      </Panel>

      <Panel
        title="按来源定时扫描"
        hint="调度作用于已登记的稳定来源标识；新结果仍按各来源的内容作用域走确认或追更规则。"
      >
        {schedules.isPending ? <p className={styles.panelHint}>正在读取调度状态…</p> : null}
        {schedules.isError ? (
          <p className={styles.panelHint}>
            调度读取失败：{schedules.error instanceof Error ? schedules.error.message : '后端拒绝'}
          </p>
        ) : null}
        <ul className={styles.list}>
          {(schedules.data ?? []).map((source) => (
            <li key={source.rootId} className={styles.listItem}>
              <div>
                <strong>{source.displayName}</strong>
                <p className={styles.listHint}>
                  {source.provider} · {source.contentScope === 'ongoing' ? '新番' : '媒体库'}
                  {source.scan.status ? ` · 最近扫描 ${source.scan.status}` : ''}
                  {source.status === 'needs_new_txt' ? ' · 纯 TXT 来源需要重新导出清单' : ''}
                  {source.jobs.failed > 0 ? ` · 失败作业 ${source.jobs.failed}` : ''}
                </p>
              </div>
              <div className={styles.rowControl}>
                <Select
                  label={`${source.displayName} 扫描间隔`}
                  value={String(source.schedule.intervalMinutes || 0)}
                  options={INTERVAL_OPTIONS}
                  onChange={(value) => {
                    if (!service.setScanSchedule) {
                      setNotice('当前服务没有调度写入能力。');
                      return;
                    }
                    void service
                      .setScanSchedule(source.rootId, {
                        enabled: Number(value) > 0,
                        intervalMinutes: Number(value) || 360,
                      })
                      .then(() => {
                        setNotice(`已更新「${source.displayName}」的扫描调度`);
                        void schedules.refetch();
                      })
                      .catch((error: unknown) =>
                        setNotice(`调度未保存：${error instanceof Error ? error.message : '后端拒绝'}`),
                      );
                  }}
                />
              </div>
            </li>
          ))}
          {!schedules.isPending && (schedules.data ?? []).length === 0 ? (
            <li className={styles.listHint}>还没有可调度的来源。</li>
          ) : null}
        </ul>
        <p className={styles.panelHint}>
          本机对外 WebDAV 服务、KumiPlayer 云账号与设置云同步本轮不提供。
        </p>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ 元数据与图片 */

function ScrapeGroup({ data, draftValue, setDraftValue, save }: GroupProps) {
  return (
    <>
      <Panel
        title="元数据来源"
        hint="作品匹配固定使用 TMDB（内置）；Bangumi / AniList 只做别名检索辅助，不参与作品身份与编号。"
      >
        <Row label="匹配来源">
          <StatusChip tone="neutral">TMDB（内置）</StatusChip>
        </Row>
        <Row label="TMDB 读取令牌" hint="填写即更新；留空表示不修改已保存的令牌。">
          <Input
            type="password"
            value={draftValue('tmdbToken', '')}
            onChange={(event) => setDraftValue('tmdbToken', event.currentTarget.value)}
            placeholder={data.scrape.tmdbConfigured ? '已保存（留空不修改）' : '尚未配置'}
            autoComplete="new-password"
            onBlur={() => {
              const token = draftValue('tmdbToken', '').trim();
              if (token) {
                save('scrape', { tmdbToken: token }, '已保存 TMDB 读取令牌');
              }
            }}
            aria-label="TMDB 读取令牌"
          />
        </Row>
        <Row label="Bangumi 名称辅助" hint="只在 TMDB 无安全候选时用于别名检索。">
          <Switch
            checked={data.scrape.bangumiAliasEnabled}
            onCheckedChange={(value) => save('scrape', { bangumiAliasEnabled: value }, '已更新 Bangumi 名称辅助')}
            aria-label="Bangumi 名称辅助"
          />
        </Row>
        <Row label="AniList 名称辅助" hint="同上，只用于别名检索。">
          <Switch
            checked={data.scrape.anilistEnabled}
            onCheckedChange={(value) => save('scrape', { anilistEnabled: value }, '已更新 AniList 名称辅助')}
            aria-label="AniList 名称辅助"
          />
        </Row>
        <Row label="简介语言" hint="来自 TMDB 的本地化简介语言。">
          <Select
            label="简介语言"
            value={data.scrape.tmdbLanguage}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'zh-TW', label: '繁體中文' },
              { value: 'ja-JP', label: '日本語' },
            ]}
            onChange={(value) => save('scrape', { tmdbLanguage: value }, '已保存资料语言')}
          />
        </Row>
      </Panel>
      <Panel title="图片" hint="海报与剧集缩略图均取自 TMDB 并保存为本地派生；尺寸自动按展示位置选择。">
        <Row label="图片尺寸策略" hint="自动按展示位置选择已发布规格，不下载上游原图。">
          <StatusChip tone="neutral">自动（推荐）</StatusChip>
        </Row>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ 播放 */

function PlayerGroup({ data, draftValue, setDraftValue, save, setNotice }: GroupProps) {
  const player = data.player;
  void setNotice;
  return (
    <>
      <Panel
        title="播放器"
        hint="内置播放器自带调校预设；外置播放器直接使用你自己的 MPV。"
      >
        <Row label="播放器">
          <SegmentedControl
            ariaLabel="播放器"
            value={player.mode}
            onValueChange={(value) => save('player', { mode: value }, '已保存播放器模式')}
            options={[
              { value: 'internal', label: '内置播放器' },
              { value: 'external', label: '外置播放器' },
            ]}
          />
        </Row>
        {player.mode === 'internal' ? (
          <>
            <Row label="Anime4K 配置" hint="选择「关闭」即不接受任何 Anime4K 处理。">
              <Select
                label="Anime4K 配置"
                value={player.anime4kMode}
                options={[
                  { value: 'off', label: '关闭' },
                  { value: 'a', label: 'Anime4K Mode A' },
                  { value: 'b', label: 'Anime4K Mode B' },
                  { value: 'c', label: 'Anime4K Mode C' },
                  { value: 'a+a', label: 'Anime4K Mode A+A' },
                  { value: 'b+b', label: 'Anime4K Mode B+B' },
                  { value: 'c+a', label: 'Anime4K Mode C+A' },
                ]}
                onChange={(value) => save('player', { anime4kMode: value }, '已保存 Anime4K 配置')}
              />
            </Row>
            <Row label="默认效果" hint="仅在 Anime4K 未关闭时生效。">
              <Select
                label="默认效果"
                value={player.anime4kQuality}
                options={[
                  { value: 'fast', label: '极速 · 单层（低配推荐）' },
                  { value: 'light', label: '轻量' },
                  { value: 'balanced', label: '均衡' },
                  { value: 'high', label: '高质量' },
                ]}
                onChange={(value) => save('player', { anime4kQuality: value }, '已保存默认效果')}
              />
            </Row>
          </>
        ) : (
          <Row label="外置 MPV 路径" hint="后端按该路径启动外置 MPV；留空表示使用系统默认。">
            <Input
              value={draftValue('mpvPath', player.externalPath)}
              onChange={(event) => setDraftValue('mpvPath', event.currentTarget.value)}
              placeholder="D:\\mpv\\mpv.exe"
              onBlur={() => {
                const path = draftValue('mpvPath', player.externalPath).trim();
                if (path !== player.externalPath) {
                  save('player', { externalPath: path }, '已保存外置 MPV 路径');
                }
              }}
              aria-label="外置 MPV 路径"
            />
          </Row>
        )}
        <Row
          label="MPV 配置文件夹"
          hint="浏览器不能打开本机文件夹；桌面版由主进程打开配置目录。"
        >
          <StatusChip tone="neutral">需要桌面版</StatusChip>
        </Row>
      </Panel>

      <Panel title="进度与续播">
        <Row label="自动记录播放进度" hint="默认启用，由后端按采样与结算统一保存。">
          <StatusChip tone="success">已启用</StatusChip>
        </Row>
        <Row label="自动下一集">
          <Switch
            checked={player.autoPlayNext}
            onCheckedChange={(value) => save('player', { autoPlayNext: value }, '已保存连播设置')}
            aria-label="自动下一集"
          />
        </Row>
        <Row
          label="看完判定阈值"
          hint="播放达到该进度即由后端判定为已看完（50–100%）。"
        >
          <div className={styles.rowControl}>
            <Slider
              className="w-40"
              min={50}
              max={100}
              step={5}
              value={[player.completedThresholdPercent]}
              onValueCommit={(values) =>
                save('player', { completedThresholdPercent: values[0] ?? 90 }, '已保存看完判定阈值')
              }
              aria-label="看完判定阈值"
            />
            <span className="w-10 text-right text-[12px] tabular-nums text-muted-foreground">
              {player.completedThresholdPercent}%
            </span>
          </div>
        </Row>
      </Panel>
      <p className={styles.panelHint}>播放由本机后端驱动；浏览器不直接控制播放器进程。</p>
    </>
  );
}

/* ------------------------------------------------------------------ 账户与同步 */

function AccountGroup({
  data,
  save,
  setNotice,
}: {
  readonly data: NonNullable<ReturnType<typeof useSettings>['data']>;
  readonly save: (section: SettingsSection, patch: Record<string, unknown>, message: string) => void;
  readonly setNotice: (value: string) => void;
}) {
  const service = useMediaService();
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const backups = useQuery({
    queryKey: ['backups'],
    enabled: typeof service.listBackups === 'function',
    queryFn: () => service.listBackups!(),
  });

  // 账号名只来自后端会话（昵称优先，空则退用户名）；`GET /api/config` 从不返回账号名。
  const session = useQuery({
    queryKey: ['bangumi-session'],
    enabled: typeof service.bangumiSession === 'function',
    queryFn: () => service.bangumiSession!(),
  });

  const refreshSession = () => {
    void queryClient.invalidateQueries({ queryKey: ['bangumi-session'] });
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.settings });
  };

  const submitToken = async () => {
    if (typeof service.bangumiSignIn !== 'function') {
      setNotice('演示模式不提供真实 Bangumi 会话。');
      return;
    }
    const value = token.trim();
    if (value.length === 0) {
      setNotice('请填写 Bangumi 访问令牌；空值不会保存。');
      return;
    }
    setSessionBusy(true);
    try {
      const next = await service.bangumiSignIn(value);
      // 成功后清空输入且不回显令牌；失败路径保留输入。
      setToken('');
      const name = next.nickname || next.username;
      setNotice(`已保存 Bangumi 访问令牌${name ? `：${name}` : ''}`);
      refreshSession();
    } catch (error) {
      setNotice(`未保存：${error instanceof Error ? error.message : '后端拒绝了这次修改'}`);
    } finally {
      setSessionBusy(false);
    }
  };

  const verifySession = async () => {
    if (typeof service.bangumiVerify !== 'function') {
      setNotice('演示模式不提供真实 Bangumi 会话。');
      return;
    }
    setSessionBusy(true);
    try {
      const next = await service.bangumiVerify();
      setNotice(bangumiVerifyNotice(next));
      refreshSession();
    } catch (error) {
      setNotice(`会话验证失败：${error instanceof Error ? error.message : '后端拒绝'}`);
    } finally {
      setSessionBusy(false);
    }
  };

  const signOut = async () => {
    if (typeof service.bangumiSignOut !== 'function') {
      setSignOutOpen(false);
      setNotice('演示模式不提供真实 Bangumi 会话。');
      return;
    }
    setSessionBusy(true);
    try {
      await service.bangumiSignOut();
      setSignOutOpen(false);
      setNotice('已退出登录：本机凭据与账号快照已清除。');
      refreshSession();
    } catch (error) {
      setNotice(`退出登录失败：${error instanceof Error ? error.message : '后端拒绝'}`);
    } finally {
      setSessionBusy(false);
    }
  };

  const restorePreview = async (file: File) => {
    if (!service.previewRestore) {
      setNotice('当前服务没有备份恢复能力（演示模式不改动任何数据）。');
      return;
    }
    setBusy(true);
    try {
      const result = await service.previewRestore(file);
      setPreview(result);
    } catch (error) {
      setNotice(`备份文件未通过校验：${error instanceof Error ? error.message : '后端拒绝'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="Bangumi 账号" hint="只用于匹配后的收藏与看完同步；不参与本地作品身份与编号。">
        {typeof service.bangumiSession !== 'function' ? (
          <Row label="当前状态">
            <StatusChip tone="neutral">演示模式不提供真实 Bangumi 会话</StatusChip>
          </Row>
        ) : session.isPending ? (
          <Row label="当前状态">
            <StatusChip tone="neutral">正在读取会话…</StatusChip>
          </Row>
        ) : session.isError || !session.data ? (
          <Row label="当前状态">
            <StatusChip tone="danger">
              会话读取失败：{session.error instanceof Error ? session.error.message : '后端拒绝'}
            </StatusChip>
          </Row>
        ) : (
          <BangumiSessionView
            session={session.data}
            busy={sessionBusy}
            onVerify={() => void verifySession()}
            onSignOut={() => setSignOutOpen(true)}
          />
        )}
        <Row
          label="Bangumi 访问令牌"
          hint="提交给本机后端先验证再落本机凭据存储；失败保留输入，成功后清空且不回显。"
        >
          <div className={styles.rowControl}>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              autoComplete="new-password"
              placeholder={data.bangumi.configured ? '已保存（留空不修改）' : '尚未配置'}
              aria-label="Bangumi 访问令牌"
            />
            <Button
              size="xs"
              variant="outline"
              loading={sessionBusy}
              disabled={token.trim().length === 0}
              onClick={() => void submitToken()}
            >
              保存令牌
            </Button>
          </div>
        </Row>
        <p className={styles.panelHint}>
          同步语义：把本地收藏与「已看完」的集数同步到 Bangumi；不表示精确到秒的云端续播，
          也不建设 KumiPlayer 云账号或设置云同步。
        </p>
      </Panel>

      <Dialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>退出 Bangumi 登录</DialogTitle>
          </DialogHeader>
          <p className={styles.panelHint}>
            退出会清除本机凭据与账号快照；已同步到 Bangumi 的收藏与进度不受影响。
          </p>
          <DialogFooter>
            <Button variant="destructive" loading={sessionBusy} onClick={() => void signOut()}>
              确认退出
            </Button>
            <Button variant="outline" disabled={sessionBusy} onClick={() => setSignOutOpen(false)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Panel
        title="备份"
        hint="备份包含配置、来源配置与观看记录；不含凭据、媒体文件、图片原图与完整数据库。"
      >
        <Row label="立即备份" hint="生成一份手动备份（.kumibak），不参与自动备份轮换。">
          <div className={styles.rowControl}>
            <Button
              size="xs"
              variant="outline"
              loading={busy}
              disabled={typeof service.exportBackup !== 'function'}
              onClick={() => {
                if (!service.exportBackup) {
                  setNotice('当前服务没有备份能力（演示模式不生成备份）。');
                  return;
                }
                setBusy(true);
                void service
                  .exportBackup()
                  .then((file) => {
                    setNotice(`已生成备份：${file.fileName}（${formatBytes(file.sizeBytes)}）`);
                    void backups.refetch();
                  })
                  .catch((error: unknown) =>
                    setNotice(`备份失败：${error instanceof Error ? error.message : '后端拒绝'}`),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              备份配置
            </Button>
            <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()} loading={busy}>
              从文件恢复
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".kumibak,application/zip"
              className="hidden"
              aria-label="选择备份文件"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) {
                  void restorePreview(file);
                }
              }}
            />
          </div>
        </Row>
        <Row label="每日自动备份" hint="默认关闭；在后台运行到点执行，保留最近 7 份并轮换。">
          <div className={styles.rowControl}>
            <Switch
              checked={data.backup.autoDailyEnabled}
              onCheckedChange={(value) => save('backup', { autoDailyEnabled: value }, '已保存自动备份设置')}
              aria-label="每日自动备份"
            />
            <Input
              className="w-24"
              defaultValue={data.backup.autoDailyTime}
              placeholder="03:00"
              aria-label="自动备份时间"
              onBlur={(event) => {
                const time = event.currentTarget.value.trim();
                if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) && time !== data.backup.autoDailyTime) {
                  save('backup', { autoDailyTime: time }, '已保存自动备份时间');
                }
              }}
            />
          </div>
        </Row>
        <ul className={styles.list}>
          {(backups.data?.files ?? []).slice(0, 8).map((file) => (
            <li key={file.fileId} className={styles.listItem}>
              <div>
                <strong>{file.fileName}</strong>
                <p className={styles.listHint}>
                  {file.kind === 'auto' ? '自动' : '手动'} · {formatBytes(file.sizeBytes)}
                  {file.createdAt ? ` · ${file.createdAt.slice(0, 19).replace('T', ' ')}` : ''}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  if (!service.downloadBackup) {
                    setNotice('当前服务没有备份下载能力。');
                    return;
                  }
                  void service
                    .downloadBackup(file.fileId)
                    .then(({ blob, filename }) => {
                      const url = URL.createObjectURL(blob);
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download = filename;
                      anchor.click();
                      URL.revokeObjectURL(url);
                    })
                    .catch((error: unknown) =>
                      setNotice(`下载失败：${error instanceof Error ? error.message : '后端拒绝'}`),
                    );
                }}
              >
                下载
              </Button>
            </li>
          ))}
          {backups.data && backups.data.files.length === 0 ? (
            <li className={styles.listHint}>还没有备份文件。</li>
          ) : null}
          {backups.isError ? (
            <li className={styles.listHint}>
              备份列表读取失败：{backups.error instanceof Error ? backups.error.message : '后端拒绝'}
            </li>
          ) : null}
        </ul>
      </Panel>

      <Dialog open={preview !== null} onOpenChange={(open) => (open ? undefined : setPreview(null))}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>恢复预览</DialogTitle>
          </DialogHeader>
          {preview ? (
            <div className="flex flex-col gap-2 text-[13px]">
              <p>
                备份时间 {preview.backup.createdAt.slice(0, 19).replace('T', ' ')} ·
                程序版本 {preview.backup.appVersion} · 格式版本 {preview.backup.formatVersion}
              </p>
              <p>
                配置将改动 {preview.config.changedFields.length} 项
                {preview.config.changedFields.length > 0 ? `（${preview.config.changedFields.join('、')}）` : ''}；
                来源配置改动 {preview.config.sourceChanges.length} 项。
              </p>
              {preview.config.ignoredFields.length > 0 ? (
                // 备份里存在但当前版本不恢复的字段：如实列出，不假装已经恢复。
                <p className="text-muted-foreground">
                  以下字段本次不会恢复（备份里存在，当前版本已忽略）：
                  {preview.config.ignoredFields.join('、')}
                </p>
              ) : null}
              <p>
                观看记录：进度 {preview.watchRecords.progress} 条、历史 {preview.watchRecords.history} 条、
                观看状态 {preview.watchRecords.watchStatus} 条、集级人工选择 {preview.watchRecords.overrides} 条；
                可匹配 {preview.watchRecords.matched} 条，孤立 {preview.watchRecords.orphans} 条。
              </p>
              {preview.orphans.length > 0 ? (
                <p className="text-muted-foreground">
                  孤立身份（不会猜测合并）：{preview.orphans.slice(0, 5).map((item) => `${item.kind}:${item.workId}`).join('、')}
                  {preview.orphans.length > 5 ? ' …' : ''}
                </p>
              ) : null}
              <p className="text-muted-foreground">{preview.credentials.note}</p>
              <p className="text-muted-foreground">
                预览有效期至 {preview.expiresAt.slice(0, 19).replace('T', ' ')}；确认后按服务端保存的预览身份执行。
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => {
                if (!preview || !service.confirmRestore) {
                  return;
                }
                setBusy(true);
                void service
                  .confirmRestore(preview.previewId, preview.digest)
                  .then((applied) => {
                    setNotice(applied.message || '备份已恢复。');
                    setPreview(null);
                    void backups.refetch();
                  })
                  .catch((error: unknown) =>
                    setNotice(`恢复未执行：${error instanceof Error ? error.message : '后端拒绝'}`),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              确认恢复
            </Button>
            <Button variant="outline" onClick={() => setPreview(null)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Bangumi 会话摘要：只展示用户能自己判断的结论（是否登录、上次验证是否通过、要不要处理），
 * 不把 `found / valid / online` 这类后端枚举搬到界面上；原始值仍由接口提供，需要时可在日志里查。
 */
function BangumiSessionView({
  session,
  busy,
  onVerify,
  onSignOut,
}: {
  readonly session: BangumiAccountSession;
  readonly busy: boolean;
  readonly onVerify: () => void;
  readonly onSignOut: () => void;
}) {
  const chip = bangumiStatusChip(session);
  const name = session.nickname || session.username;
  const problem = bangumiProblemHint(session);
  return (
    <>
      <Row label="当前状态">
        <div className={styles.rowControl}>
          <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
          {/* 账号显示名优先昵称、空则退用户名；两者都空时不补占位文案，状态标签已经说明结果。 */}
          {name ? <span className={styles.listHint}>{name}</span> : null}
        </div>
      </Row>
      <Row label="上次验证">
        <span className={styles.listHint}>{bangumiVerifiedLine(session)}</span>
      </Row>
      {problem ? <p className={styles.panelHint}>{problem}</p> : null}
      <Row label="账号操作">
        <div className={styles.rowControl}>
          <Button size="xs" variant="outline" loading={busy} onClick={onVerify}>
            验证账号
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={onSignOut}>
            退出登录
          </Button>
        </div>
      </Row>
      <p className={styles.panelHint}>退出登录会清除本机凭据与账号快照。</p>
    </>
  );
}

function bangumiStatusChip(session: BangumiAccountSession): {
  readonly label: string;
  readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
} {
  if (session.credentialState === 'not_found' || session.status === 'signed_out') {
    return { label: '未登录', tone: 'neutral' };
  }
  if (session.credentialState === 'unavailable') {
    return { label: '凭据暂不可读', tone: 'warning' };
  }
  if (session.authStatus === 'reauth_required') {
    return { label: '需要重新登录', tone: 'warning' };
  }
  // 标签只说「登录」这件事，不说「在线」：连通性只属于某一次验证，不冒充实时网络状态。
  if (session.status === 'connected') {
    return { label: '已登录', tone: 'success' };
  }
  return { label: '待验证', tone: 'info' };
}

/** 上次验证的时间与结论。连通性只是「上一次验证那一刻」的结果，不冒充实时在线状态。 */
function bangumiVerifiedLine(session: BangumiAccountSession): string {
  if (!session.lastVerifiedAt) {
    return '还没有验证过';
  }
  const at = session.lastVerifiedAt.slice(0, 19).replace('T', ' ');
  if (session.lastErrorCode || session.lastErrorMessage) {
    return `${at} · 未通过`;
  }
  return session.authStatus === 'valid' ? `${at} · 验证通过` : `${at} · 已验证`;
}

/** 只在需要用户动手时给一条提示；返回 null 表示当前会话没有需要处理的问题。 */
function bangumiProblemHint(session: BangumiAccountSession): string | null {
  if (session.authStatus === 'reauth_required') {
    return '访问令牌已失效，请重新保存令牌后再验证。';
  }
  if (session.credentialState === 'unavailable') {
    return '本机凭据存储暂时读不到，可稍后重新验证；凭据与账号快照没有被删除。';
  }
  switch (session.connectivity) {
    case 'offline':
      return session.lastErrorMessage
        ? `上次验证没连上 Bangumi：${session.lastErrorMessage}。网络或代理恢复后重新验证即可。`
        : '上次验证没连上 Bangumi。网络或代理恢复后重新验证即可。';
    case 'rate_limited':
      return 'Bangumi 暂时限制了请求频率，请稍后重新验证。';
    case 'forbidden':
      return 'Bangumi 拒绝了这次请求，请确认账号状态后重新验证。';
    case 'server_error':
      return 'Bangumi 服务暂时异常，请稍后重新验证。';
    default:
      return session.lastErrorMessage ? `上次验证未通过：${session.lastErrorMessage}` : null;
  }
}

function bangumiVerifyNotice(session: BangumiAccountSession): string {
  if (session.authStatus === 'valid') {
    const name = session.nickname || session.username;
    return `验证成功${name ? `：${name}` : ''}，本机凭据可用。`;
  }
  if (session.authStatus === 'reauth_required') {
    return '验证未通过：访问令牌已失效，请重新保存令牌。';
  }
  return session.lastErrorMessage
    ? `验证未通过：${session.lastErrorMessage}（本机凭据已保留）。`
    : '验证未通过：暂时没连上 Bangumi（本机凭据已保留）。';
}

/* ------------------------------------------------------------------ 关于 */

function AboutGroup() {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '未知';
  return (
    <>
      <Panel title="KumiPlayer" hint="本地优先的动漫媒体库与播放器；数据保存在本机，联网仅用于资料匹配与来源访问。">
        <Row label="版本">
          <StatusChip tone="neutral">v{version}</StatusChip>
        </Row>
        <Row
          label="源代码与支持"
          hint="本机开发副本没有配置公开仓库地址，因此这里不提供链接，也不伪造支持入口。"
        >
          <StatusChip tone="warning">未配置公开地址</StatusChip>
        </Row>
        <Row label="许可协议" hint="应用本体基于 MIT 许可；第三方组件许可见下。">
          <StatusChip tone="neutral">MIT</StatusChip>
        </Row>
      </Panel>
      <Panel title="第三方组件许可">
        <ul className={styles.list}>
          {[
            ['React / React DOM', 'MIT'],
            ['Radix UI', 'MIT'],
            ['Tailwind CSS', 'MIT'],
            ['Lucide', 'ISC'],
            ['TanStack Query / Virtual', 'MIT'],
            ['Vite', 'MIT'],
          ].map(([name, license]) => (
            <li key={name} className={styles.listItem}>
              <div>
                <strong>{name}</strong>
                <p className={styles.listHint}>{license}</p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ 复用小件 */

interface SettingsData {
  readonly sources: { readonly localRoots: readonly { readonly id: string; readonly path: string; readonly name: string }[]; readonly ongoingOnStartup: boolean; readonly ongoingIntervalMinutes: number };
  readonly openlist: { readonly connections: readonly { readonly id: string; readonly name: string; readonly serverUrl: string; readonly remoteRoot: string; readonly mountRoot: string; readonly configured: boolean }[]; readonly routes: readonly { readonly id: string; readonly label: string; readonly remote: string; readonly local: string }[] };
  readonly scrape: { readonly tmdbLanguage: string; readonly tmdbConfigured: boolean; readonly bangumiAliasEnabled: boolean; readonly anilistEnabled: boolean };
  readonly player: { readonly mode: 'internal' | 'external'; readonly externalPath: string; readonly autoPlayNext: boolean; readonly anime4kMode: string; readonly anime4kQuality: string; readonly completedThresholdPercent: number };
  /** 账号名不在这里：`GET /api/config` 从不返回昵称/用户名，账号显示名只来自 `bangumiSession()`。 */
  readonly bangumi: { readonly configured: boolean; readonly syncEnabled: boolean };
  readonly backup: { readonly autoDailyEnabled: boolean; readonly autoDailyTime: string };
}

interface GroupProps {
  readonly data: SettingsData;
  readonly draftValue: (key: string, fallback: string) => string;
  readonly setDraftValue: (key: string, value: string) => void;
  readonly save: (section: SettingsSection, patch: Record<string, unknown>, message: string) => void;
  readonly setNotice?: (value: string) => void;
}

function useSettingsValues(): {
  readonly application: {
    readonly connectionMonitor: boolean;
    readonly setupCompleted: boolean;
    readonly setupDeferred: boolean;
  };
} {
  const settings = useSettings();
  return {
    application:
      settings.data?.application ?? {
        connectionMonitor: false,
        setupCompleted: false,
        setupDeferred: false,
      },
  };
}

function toLocalRootRecord(root: { readonly path: string; readonly name?: string }): Record<string, string> {
  return root.name ? { path: root.path, name: root.name } : { path: root.path };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function Panel({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>{title}</h2>
      {hint ? <p className={styles.panelHint}>{hint}</p> : null}
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {hint ? <span className={styles.rowHint}>{hint}</span> : null}
      </div>
      <div className={styles.rowValue}>{children}</div>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">{label}</span>
      <select
        className="h-8 min-w-[10rem] rounded-md border border-input bg-card px-2 text-[13px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
