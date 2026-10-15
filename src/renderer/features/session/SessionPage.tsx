/**
 * 桌面链路自检页（开发入口，/dev/session）。
 *
 * 只有 Electron 壳内运行才有桥接：普通浏览器打开时明确说明该页需要桌面壳，
 * 不用它承载任何产品流程。
 */

import { useQuery } from '@tanstack/react-query';

import type { HealthResponse, PublicConfig } from '@shared/contracts/dto';
import type { GatewayError } from '@shared/contracts/errors';
import { queryKeys } from '@/app/queryClient';
import { createBridgeFacade } from '@/shared/api/bridge';
import { useDesktopEpoch, useDesktopStatus } from '@/shared/hooks/use-desktop-epoch';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { LoadingSurface } from '@/shared/ui/Surface';

const facade = createBridgeFacade();

export function SessionPage() {
  const status = useDesktopStatus();
  const epoch = useDesktopEpoch();
  const hasBridge = typeof window !== 'undefined' && Boolean(window.kumiplayer);

  const probe = useQuery<{ health: HealthResponse; config: PublicConfig }, GatewayError>({
    queryKey: [...queryKeys.desktop(epoch), 'probe'],
    enabled: hasBridge && Boolean(status?.authenticated),
    queryFn: async ({ signal }) => {
      const health = await facade.call<HealthResponse>('health.get', { signal });
      if (!health.ok) {
        throw health.error;
      }
      const config = await facade.call<PublicConfig>('config.get', { signal });
      if (!config.ok) {
        throw config.error;
      }
      return { health: health.data, config: config.data };
    },
  });

  if (!hasBridge) {
    return (
      <Card className="mx-auto mt-[10vh] max-w-[620px]">
        <CardHeader>
          <CardTitle>该页面需要桌面壳</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-[13px] text-muted-foreground">
          <p>
            当前在普通浏览器中运行，没有桌面桥接，因此无法探测本地后端身份。
            产品页面与演示数据不依赖本页。
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={() => window.location.assign('#/')}>
              返回首页
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4" data-route="session">
      <Card>
        <CardHeader>
          <CardTitle>本地后端</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-[13px]">
          <div className="flex items-center gap-2">
            <Badge variant="soft">{status?.phase ?? '未知'}</Badge>
            <Badge variant="outline">代次 {status?.epoch ?? 0}</Badge>
            <Badge variant="outline">{status?.protection ?? '-'}</Badge>
          </div>
          <p className="text-muted-foreground">
            运行模式 {status?.runtimeKind ?? '-'} · 端口 {status?.port ?? '-'}
          </p>
          {status?.lastError ? <p className="text-destructive">{status.lastError.message}</p> : null}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void facade.call('desktop.openLogs')}>
              打开日志目录
            </Button>
            <Button variant="outline" size="sm" onClick={() => void facade.call('desktop.restartBackend')}>
              重启本地后端
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>已鉴权读取探针</CardTitle>
        </CardHeader>
        <CardContent className="text-[13px]">
          {!status?.authenticated ? (
            <p className="text-muted-foreground">等待后端就绪…</p>
          ) : probe.isPending ? (
            <LoadingSurface label="读取 /api/health 与 /api/config…" />
          ) : probe.data ? (
            <ul className="flex flex-col gap-1">
              <li>
                health.app = <code>{probe.data.health.app}</code>
              </li>
              <li>
                health.runtime_kind = <code>{probe.data.health.runtime_kind}</code>
              </li>
              <li>
                config 字段数 = <code>{Object.keys(probe.data.config).length}</code>
              </li>
            </ul>
          ) : (
            <p className="text-destructive">{probe.error?.message ?? '未知错误'}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
