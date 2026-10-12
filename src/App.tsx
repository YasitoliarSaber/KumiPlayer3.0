import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useUiStore } from './stores/ui';
import { useLibraryStore } from './stores/library';
import { useBangumiStore, SESSION_VERIFY_TTL_MS } from './stores/bangumi';
import { useConnectionStore } from './stores/connection';
import { useMediaWorkflowStore } from './stores/mediaWorkflow';
import AppShell from './components/shell/AppShell';
import StartupSplash from './components/shell/StartupSplash';
import HomePage from './pages/HomePage';
import FavoritesPage from './pages/FavoritesPage';
import RecentPage from './pages/RecentPage';
import CategoryPage from './pages/CategoryPage';
import SearchPage from './pages/SearchPage';
import LoadingState from './components/ui/loading-state';
import { configApi, type PublicConfig } from './api/config';
import { recordScrollDiagnostic } from './utils/scrollDiagnostics';
import { FluentProvider } from '@fluentui/react-components';
import { getKumiFluentTheme } from './design/fluentTheme';
import { listenForTreeFileDrop } from './platform/fileDrop';

const WorkDetailPage = lazy(() => import('./pages/WorkDetailPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const PlayerTuningPage = lazy(() => import('./pages/PlayerTuningPage'));
const MediaManagementPage = lazy(() => import('./pages/MediaManagementPage'));
const FirstRunSetup = lazy(() => import('./pages/FirstRunSetup'));

export default function App() {
  const page = useUiStore((state) => state.page);
  const query = useUiStore((state) => state.query);
  const selectedWorkId = useUiStore((state) => state.selectedWorkId);
  const activeSource = useUiStore((state) => state.source);
  const styleMode = useUiStore((state) => state.styleMode);
  const motionMode = useUiStore((state) => state.motionMode);
  const appearanceMode = useUiStore((state) => state.appearanceMode);
  const setSeriesCardImageMode = useUiStore((state) => state.setSeriesCardImageMode);
  const setPosterSize = useUiStore((state) => state.setPosterSize);
  const goManageView = useUiStore((state) => state.goManageView);
  const loadLibrary = useLibraryStore((state) => state.loadLibrary);
  const syncChanges = useLibraryStore((state) => state.syncChanges);
  const restoreSession = useBangumiStore((state) => state.restoreSession);
  const verifySession = useBangumiStore((state) => state.verifySession);
  // App 只需要稳定动作；健康/账户状态由各自组件订阅，避免后台轮询重渲染整页。
  const startHeartbeat = useConnectionStore((state) => state.startHeartbeat);
  const stopHeartbeat = useConnectionStore((state) => state.stopHeartbeat);
  const startHealthPolling = useConnectionStore((state) => state.startHealthPolling);
  const stopHealthPolling = useConnectionStore((state) => state.stopHealthPolling);
  const queueDroppedTreePath = useMediaWorkflowStore((state) => state.queueDroppedTreePath);
  const fluentTheme = useMemo(() => getKumiFluentTheme(appearanceMode), [appearanceMode]);
  const [appConfig, setAppConfig] = useState<PublicConfig | null>(null);
  const [configReady, setConfigReady] = useState(false);
  const [setupOverride, setSetupOverride] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [setupSaveError, setSetupSaveError] = useState('');
  const showSetup = Boolean(appConfig && (setupOverride || (!appConfig.setup_completed && !appConfig.setup_deferred && !setupDismissed)));
  const mainAvailable = configReady && !showSetup;

  const dismissSetup = useCallback(() => {
    setSetupOverride(false);
    setSetupDismissed(true);
    setSetupSaveError('');
    if (!appConfig || appConfig.setup_completed || appConfig.setup_deferred) return;
    // 进入软件不等待保存成功；后台故障也不能把用户困在引导中。
    void configApi.deferSetup().then((config) => {
      setAppConfig((current) => current
        ? (current.setup_completed ? current : { ...current, setup_deferred: config.setup_deferred })
        : config);
    }).catch(() => {
      setSetupSaveError('已进入软件，但“稍后设置”未能保存，下次启动可能再次显示引导。你仍可在设置中继续配置。');
    });
  }, [appConfig]);

  useEffect(() => {
    if (!showSetup) return undefined;
    // 引导共用应用导航；点击其他页面或开始搜索也可直接进入软件。
    return useUiStore.subscribe((current, previous) => {
      if (current.page !== previous.page || current.query !== previous.query) dismissSetup();
    });
  }, [dismissSetup, showSetup]);

  useLayoutEffect(() => {
    if (!configReady) return;
    document.getElementById('kumi-boot-splash')?.remove();
  }, [configReady]);

  useEffect(() => {
    document.documentElement.setAttribute('data-style', styleMode);
    document.documentElement.setAttribute('data-motion', motionMode);
    document.documentElement.setAttribute('data-theme', appearanceMode);
  }, [styleMode, motionMode, appearanceMode]);

  useEffect(() => {
    if (!mainAvailable) return undefined;
    if (page === 'detail' || page === 'settings') return undefined;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForTreeFileDrop((event) => {
      if (event.type !== 'drop' || event.paths.length !== 1) return;
      queueDroppedTreePath(event.paths[0]);
      goManageView('import');
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [mainAvailable, goManageView, page, queueDroppedTreePath]);

  useEffect(() => {
    if (!mainAvailable) return undefined;
    let disposed = false;
    let timer = 0;
    let checking = false;
    const schedule = () => {
      window.clearTimeout(timer);
      if (disposed) return;
      const state = useLibraryStore.getState();
      const delay = document.visibilityState !== 'visible' ? 30000
        : state.backgroundActive || state.updating ? 1000 : 5000;
      timer = window.setTimeout(() => { void check() }, delay);
    };
    // 变化游标只合并相关卡片；图片发布不会强刷全库或清空全部详情。
    const check = async () => {
      if (disposed || checking) return;
      window.clearTimeout(timer);
      checking = true;
      const startedAt = performance.now();
      try {
        const changed = await syncChanges();
        recordScrollDiagnostic('library-check', {
          ms: Math.round(performance.now() - startedAt),
          changed,
        });
      } catch {
        recordScrollDiagnostic('library-check-error', { ms: Math.round(performance.now() - startedAt) });
        // 网络失败不推进游标，下一轮重试。
      }
      checking = false;
      schedule();
    };
    const onVisibilityChange = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible') void check();
      else if (!checking) schedule();
    };
    const unsubscribe = useLibraryStore.subscribe((state, previous) => {
      if (!checking && (state.backgroundActive !== previous.backgroundActive || state.updating !== previous.updating)) schedule();
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    timer = window.setTimeout(() => { void check() }, 0);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribe();
    };
  }, [mainAvailable, syncChanges]);

  useEffect(() => {
    if (!mainAvailable) return;
    loadLibrary();
  }, [mainAvailable, loadLibrary]);

  useEffect(() => {
    if (!configReady) return undefined;
    startHeartbeat();
    startHealthPolling();
    return () => {
      stopHealthPolling();
      stopHeartbeat();
    };
  }, [configReady, startHeartbeat, startHealthPolling, stopHeartbeat, stopHealthPolling]);

  useEffect(() => {
    if (!mainAvailable) return undefined;
    let disposed = false;
    // 启动只做本地会话恢复（GET /session，0 远程请求、不重试）；
    // 认证证据时间取 max(last_verified_at, last_success_at)：任何 authenticated
    // 业务请求成功（_observe_auth 更新 last_success_at）都计入 TTL，避免刚同步
    // 完又触发一次 /v0/me；仅超 TTL 时后台执行一次远程验证（失败不阻塞 UI）
    void restoreSession().then((session) => {
      if (disposed || !session || session.credential_state !== 'found') return;
      const lastVerified = session.last_verified_at ? new Date(session.last_verified_at).getTime() : 0;
      const lastSuccess = session.last_success_at ? new Date(session.last_success_at).getTime() : 0;
      const effective = Math.max(lastVerified, lastSuccess);
      const stale = !effective || Date.now() - effective > SESSION_VERIFY_TTL_MS;
      if (stale) {
        void verifySession().catch(() => {
          // 后台验证失败保留本地会话，账户卡不受影响
        });
      }
    });
    return () => {
      disposed = true;
    };
  }, [mainAvailable, restoreSession, verifySession]);

  useEffect(() => {
    configApi.getConfig()
      .then((config) => {
        setAppConfig(config);
        if (config.series_card_image_mode === 'poster' || config.series_card_image_mode === 'fanart') {
          setSeriesCardImageMode(config.series_card_image_mode);
        }
        if (typeof config.poster_size === 'number') {
          setPosterSize(config.poster_size);
        }
      })
      .catch(() => {
        // 本地存储的 UI 偏好仍可兜底，配置读取失败不阻断首页。
      })
      .finally(() => {
        setConfigReady(true);
      });
  }, [setSeriesCardImageMode, setPosterSize]);

  const renderPage = () => {
    switch (page) {
      case 'home':
        return <HomePage />;
      case 'favorites':
        return <FavoritesPage />;
      case 'recent':
        return <RecentPage />;
      case 'category':
        return <CategoryPage />;
      case 'detail':
        return <WorkDetailPage key={selectedWorkId || 'detail'} />;
      case 'manage':
        return <MediaManagementPage />;
      case 'settings':
        return <SettingsPage onOpenSetup={(config) => { setAppConfig(config); setSetupOverride(true); }} />;
      case 'player-tuning':
        return <PlayerTuningPage />;
      default:
        return <HomePage />;
    }
  };

  const visiblePage = query.trim() ? 'search' : page;
  return (
    <FluentProvider theme={fluentTheme}>
      {!configReady && <StartupSplash />}
      {configReady && (
        <AppShell>
          {showSetup && appConfig ? <Suspense fallback={<LoadingState label="正在准备初始设置" detail="正在载入本机配置" />}>
            <FirstRunSetup
              initialConfig={appConfig}
              mode={setupOverride ? "reconfigure" : "first-run"}
              onCancel={dismissSetup}
              onComplete={(config) => {
                setAppConfig(config);
                setSetupOverride(false);
              }}
            />
          </Suspense> : <>
            {setupSaveError && <div role="status" className="first-run-defer-notice">{setupSaveError}</div>}
            <div className="app-page-source-scope" data-source={activeSource}>
              <Suspense fallback={null}>
                <div
                  key={visiblePage}
                  className="app-page-transition"
                  data-page={visiblePage}
                >
                  {visiblePage === 'search' ? <SearchPage /> : renderPage()}
                </div>
              </Suspense>
            </div>
          </>}
        </AppShell>
      )}
    </FluentProvider>
  );
}
