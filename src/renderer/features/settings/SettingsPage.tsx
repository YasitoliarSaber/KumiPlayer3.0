/**
 * 设置：应用 / 外观 / 媒体来源 / WebDAV 目录 / 元数据与图片 / 播放 / 账户与同步。
 *
 * 分类与结构复刻当前设置页；所有写入只落在演示设置与演示存储，
 * 凭据区一律为禁用的演示输入，不读取也不保存任何真实凭据。
 */

import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Switch } from '@/shared/ui/switch';
import { NumberInput, Select, Tooltip } from './demo-form';
import { useQueryClient } from '@tanstack/react-query';
import {
  Database,
  KeyRound,
  Network,
  Palette,
  PlaySquare,
  Settings2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useState } from 'react';

import type { SettingsSection } from '../../shared/api/service';
import { demoQueryKeys, useMediaService, useSettings } from '../../shared/api/service-context';
import { ErrorSurface, LoadingSurface, StatusChip } from '../../shared/ui/Surface';
import styles from './SettingsPage.module.css';

const SECTIONS: ReadonlyArray<{ key: SettingsSection; label: string; icon: LucideIcon }> = [
  { key: 'application', label: '应用', icon: Settings2 },
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'sources', label: '媒体来源', icon: Database },
  { key: 'openlist', label: 'WebDAV 目录', icon: Network },
  { key: 'scrape', label: '元数据与图片', icon: KeyRound },
  { key: 'player', label: '播放', icon: PlaySquare },
  { key: 'bangumi', label: '账户与同步', icon: UserRound },
];

export function SettingsPage() {
  const settings = useSettings();
  const service = useMediaService();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<SettingsSection>('application');
  const [notice, setNotice] = useState('');

  const save = useCallback(
    (section: SettingsSection, patch: Record<string, unknown>, message: string) => {
      void service.updateSettings(section, patch).then(() => {
        setNotice(message);
        void queryClient.invalidateQueries({ queryKey: demoQueryKeys.settings });
      });
    },
    [queryClient, service],
  );

  if (settings.isPending) {
    return <LoadingSurface label="正在读取设置" detail="正在读取演示设置" />;
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

  return (
    <section className={styles.page} data-route="settings">
      <header className={styles.head}>
        <h1 className={styles.title}>设置</h1>
        <p className={styles.subtitle}>
          演示模式只保存本机演示设置；凭据、真实配置与播放器参数都不会被读取或写入。
        </p>
      </header>

      <div className={styles.layout}>
        <nav className={styles.outline} aria-label="设置分类">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.key}
                type="button"
                className={section.key === active ? styles.outlineActive : styles.outlineItem}
                onClick={() => {
                  setActive(section.key);
                  setNotice('');
                }}
                aria-current={section.key === active ? 'true' : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{section.label}</span>
              </button>
            );
          })}
        </nav>

        <div className={styles.content}>
          {notice ? (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          ) : null}

          {active === 'application' ? (
            <Panel title="应用">
              <ToggleRow
                label="最小化到托盘"
                hint="最小化时隐藏窗口并保留后台任务。"
                value={data.application.minimizeToTray}
                onChange={(value) => save('application', { minimizeToTray: value }, '已更新窗口偏好（演示）')}
              />
              <ToggleRow
                label="关闭窗口时收到托盘"
                hint="关闭窗口不退出应用，播放与任务继续。"
                value={data.application.closeToTray}
                onChange={(value) => save('application', { closeToTray: value }, '已更新窗口偏好（演示）')}
              />
              <ToggleRow
                label="界面连接监测"
                hint="显示本地后端连接状态；演示模式不连接任何后端。"
                value={data.application.connectionMonitor}
                onChange={(value) => save('application', { connectionMonitor: value }, '已更新连接监测（演示）')}
              />
              <Row label="设置引导" hint="首次使用引导的完成状态。">
                <div className={styles.rowControl}>
                  <StatusChip tone="success">{data.application.setupState}</StatusChip>
                  <Button size="xs" variant="outline" onClick={() => setNotice('演示：已模拟重新运行设置引导')}>
                    重新运行引导
                  </Button>
                </div>
              </Row>
            </Panel>
          ) : null}

          {active === 'appearance' ? (
            <Panel title="外观">
              <Row label="主题" hint="与当前应用一致的三套主题。">
                <Select
                  data={[
                    { value: 'fluent', label: 'Fluent（浅色）' },
                    { value: 'cinema', label: 'Cinema（深色）' },
                    { value: 'mica', label: 'Mica（纯白）' },
                  ]}
                  value={data.appearance.theme}
                  onChange={(value) =>
                    value && save('appearance', { theme: value }, '已切换主题（演示）')
                  }
                />
              </Row>
              <Row label="动效" hint="减弱动效时停用自动轮播与交互动画。">
                <Select
                  data={[
                    { value: 'standard', label: '标准' },
                    { value: 'expressive', label: '丰富' },
                    { value: 'reduced', label: '减弱' },
                  ]}
                  value={data.appearance.motion}
                  onChange={(value) => value && save('appearance', { motion: value }, '已更新动效偏好（演示）')}
                />
              </Row>
              <Row label="海报墙列数" hint="分类页与媒体库使用的目标列数。">
                <NumberInput
                  min={2}
                  max={10}
                  value={data.appearance.posterSize}
                  onChange={(value) =>
                    typeof value === 'number' && save('appearance', { posterSize: value }, '已更新海报墙密度（演示）')
                  }
                />
              </Row>
              <Row label="卡片图片" hint="系列卡片使用海报或背景图。">
                <Select
                  data={[
                    { value: 'poster', label: '海报' },
                    { value: 'fanart', label: '背景图' },
                  ]}
                  value={data.appearance.cardImageMode}
                  onChange={(value) => value && save('appearance', { cardImageMode: value }, '已更新卡片图片偏好（演示）')}
                />
              </Row>
            </Panel>
          ) : null}

          {active === 'sources' ? (
            <Panel title="媒体来源">
              <ul className={styles.list}>
                {data.sources.localRoots.map((root) => (
                  <li key={root.id} className={styles.listItem}>
                    <div>
                      <strong>{root.name}</strong>
                      <p className={styles.listHint}>{root.path}</p>
                    </div>
                    <Button size="xs" variant="outline" onClick={() => setNotice(`演示：移除来源「${root.name}」需要服务端预览`)}>
                      移除
                    </Button>
                  </li>
                ))}
              </ul>
              <Row label="添加本地目录" hint="真实实现使用原生目录选择器。">
                <Button size="xs" variant="outline" onClick={() => setNotice('演示：已模拟打开目录选择器')}>
                  选择目录
                </Button>
              </Row>
              <ToggleRow
                label="启动时检查更新"
                hint="仅对新番来源生效，默认关闭。"
                value={data.sources.ongoingOnStartup}
                onChange={(value) => save('sources', { ongoingOnStartup: value }, '已更新启动更新设置（演示）')}
              />
              <Row label="定时更新间隔（分钟）" hint="关闭为 0；允许 15 到 10080 分钟。">
                <NumberInput
                  min={0}
                  max={10080}
                  step={15}
                  value={data.sources.ongoingIntervalMinutes}
                  onChange={(value) =>
                    typeof value === 'number' &&
                    save('sources', { ongoingIntervalMinutes: value }, '已更新定时更新间隔（演示）')
                  }
                />
              </Row>
            </Panel>
          ) : null}

          {active === 'openlist' ? (
            <Panel title="WebDAV 目录">
              <p className={styles.panelHint}>
                OpenList 是设置内的一个分类，不是第二套配置；演示模式不会发起任何连接。
              </p>
              <ul className={styles.list}>
                {data.openlist.connections.map((connection) => (
                  <li key={connection.id} className={styles.listItem}>
                    <div>
                      <strong>{connection.name}</strong>
                      <p className={styles.listHint}>
                        {connection.serverUrl || '未填写服务器'} · 远端根 {connection.remoteRoot || '-'} · 挂载{' '}
                        {connection.mountRoot || '-'}
                      </p>
                    </div>
                    <StatusChip tone={connection.configured ? 'success' : 'neutral'}>
                      {connection.configured ? '已配置' : '未配置'}
                    </StatusChip>
                  </li>
                ))}
              </ul>
              <Row label="内容路由" hint="远端目录与本地挂载位置的对应关系。">
                <ul className={styles.list}>
                  {data.openlist.routes.map((route) => (
                    <li key={route.id} className={styles.listHint}>
                      {route.label}：{route.remote} → {route.local}
                    </li>
                  ))}
                </ul>
              </Row>
              <Row label="连接测试" hint="真实实现会验证凭据与目录可达性。">
                <Button size="xs" variant="outline" onClick={() => setNotice('演示：已模拟连接测试（未发起任何网络请求）')}>
                  测试连接
                </Button>
              </Row>
            </Panel>
          ) : null}

          {active === 'scrape' ? (
            <Panel title="元数据与图片">
              <Row label="资料语言" hint="TMDB 查询使用的语言。">
                <Select
                  data={[
                    { value: 'zh-CN', label: '简体中文' },
                    { value: 'zh-TW', label: '繁体中文' },
                    { value: 'ja-JP', label: '日语' },
                    { value: 'en-US', label: '英语' },
                  ]}
                  value={data.scrape.tmdbLanguage}
                  onChange={(value) => value && save('scrape', { tmdbLanguage: value }, '已更新资料语言（演示）')}
                />
              </Row>
              <Row label="TMDB 读取令牌" hint="凭据由系统凭据管理器保存，演示模式不读取真实值。">
                <div className={styles.rowControl}>
                  <Input type="password" value="demo-token-not-real" disabled aria-label="TMDB 令牌（演示）" />
                  <StatusChip tone={data.scrape.tmdbConfigured ? 'success' : 'neutral'}>
                    {data.scrape.tmdbConfigured ? '已配置（演示）' : '未配置'}
                  </StatusChip>
                </div>
              </Row>
              <ToggleRow
                label="启用 AniList 别名恢复"
                hint="只用于别名补充，不参与本地编号。"
                value={data.scrape.anilistEnabled}
                onChange={(value) => save('scrape', { anilistEnabled: value }, '已更新别名恢复设置（演示）')}
              />
              <Row label="图片存储模式" hint="独立本地图片库的存储策略。">
                <Select
                  data={[
                    { value: 'auto', label: '自动' },
                    { value: 'managed', label: '受管目录' },
                  ]}
                  value={data.scrape.imageStorageMode}
                  onChange={(value) => value && save('scrape', { imageStorageMode: value }, '已更新图片存储模式（演示）')}
                />
              </Row>
              <Row label="图片连接检测" hint="真实实现会实测图片域名连通性，并给出受控修复。">
                <Button size="xs" variant="outline" onClick={() => setNotice('演示：已模拟图片连接检测（未发起网络请求）')}>
                  检测图片连接
                </Button>
              </Row>
            </Panel>
          ) : null}

          {active === 'player' ? (
            <Panel title="播放">
              <Row label="播放器模式" hint="内置 MPV 或外部 MPV 整合包。">
                <Select
                  data={[
                    { value: 'internal', label: '内置播放器' },
                    { value: 'external', label: '外部 MPV' },
                  ]}
                  value={data.player.mode}
                  onChange={(value) => value && save('player', { mode: value }, '已更新播放器模式（演示）')}
                />
              </Row>
              <Row label="外部 MPV 路径" hint="演示模式不读取也不写入真实路径。">
                <Input value="演示：未配置外部播放器" disabled aria-label="外部 MPV 路径（演示）" />
              </Row>
              <ToggleRow
                label="自动连播下一集"
                hint="按受控队列顺序播放当前与下一集。"
                value={data.player.autoPlayNext}
                onChange={(value) => save('player', { autoPlayNext: value }, '已更新连播设置（演示）')}
              />
              <Row label="Anime4K 模式" hint="内置播放器的着色器档位。">
                <Select
                  data={[
                    { value: 'off', label: '关闭' },
                    { value: 'a', label: '模式 A' },
                    { value: 'b', label: '模式 B' },
                    { value: 'c', label: '模式 C' },
                  ]}
                  value={data.player.anime4kMode}
                  onChange={(value) => value && save('player', { anime4kMode: value }, '已更新 Anime4K 设置（演示）')}
                />
              </Row>
              <Row label="Anime4K 质量" hint="与模式组合使用。">
                <Select
                  data={[
                    { value: 'fast', label: '快速' },
                    { value: 'light', label: '轻量' },
                    { value: 'balanced', label: '均衡' },
                    { value: 'high', label: '高质量' },
                  ]}
                  value={data.player.anime4kQuality}
                  onChange={(value) => value && save('player', { anime4kQuality: value }, '已更新 Anime4K 质量（演示）')}
                />
              </Row>
            </Panel>
          ) : null}

          {active === 'bangumi' ? (
            <Panel title="账户与同步">
              <Row label="账号状态" hint="Bangumi 只做同步，不参与本地作品身份。">
                <StatusChip tone={data.bangumi.configured ? 'success' : 'neutral'}>
                  {data.bangumi.configured ? '已登录（演示）' : '未登录'}
                </StatusChip>
              </Row>
              <Row label="账号" hint="演示模式不读取真实令牌。">
                <div className={styles.rowControl}>
                  <Input value={data.bangumi.username || 'demo-user'} disabled aria-label="Bangumi 账号（演示）" />
                  <Input
                    type="password"
                    value="demo-access-token"
                    disabled
                    aria-label="Bangumi 令牌（演示）"
                  />
                  <Tooltip label="演示模式不会登录或保存凭据">
                    <Button size="xs" variant="outline" onClick={() => setNotice('演示：已模拟登录流程（不访问网络）')}>
                      登录
                    </Button>
                  </Tooltip>
                </div>
              </Row>
              <ToggleRow
                label="观看进度同步"
                hint="播放完成后同步到 Bangumi。"
                value={data.bangumi.syncEnabled}
                onChange={(value) => save('bangumi', { syncEnabled: value }, '已更新同步设置（演示）')}
              />
            </Panel>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Panel({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>{title}</h2>
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

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={value} onCheckedChange={onChange} aria-label={label} />
    </Row>
  );
}
