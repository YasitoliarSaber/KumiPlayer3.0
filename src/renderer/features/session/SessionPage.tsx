/**
 * 会话页：本轮只承担"基础切片可启动、可复核"的职责——
 * 展示桌面/后端连接状态与恢复动作，并做一次已鉴权的读取探针。
 *
 * 这里刻意不设计产品首页、导航与视觉风格；页面结构待用户确认的
 * 截图/HTML 与后续设计 Skill 决定。
 */

import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  List,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import type { GatewayError } from '@shared/contracts/errors';
import type { HealthResponse, PublicConfig } from '@shared/contracts/dto';

import { useDesktopStatus, useDesktopEpoch } from '../../shared/hooks/use-desktop-epoch';
import { createBridgeFacade } from '../../shared/api/bridge';
import { queryKeys } from '../../app/queryClient';

const facade = createBridgeFacade();

export function SessionPage() {
  const status = useDesktopStatus();
  const epoch = useDesktopEpoch();

  const probe = useQuery<{ health: HealthResponse; config: PublicConfig }, GatewayError>({
    queryKey: [...queryKeys.desktop(epoch), 'probe'],
    enabled: Boolean(status?.authenticated),
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

  const runLocal = (operation: 'desktop.restartBackend' | 'desktop.openLogs') => {
    void facade.call(operation);
  };

  return (
    <Stack maw={720} mx="auto" mt="10vh" gap="md" p="lg">
      <Stack gap={4}>
        <Title order={2}>KumiPlayer 基础切片</Title>
        <Text size="sm" c="dimmed">
          当前只有桌面监管、契约与缓存基础；页面结构、导航与视觉待设计确认后接入。
        </Text>
      </Stack>

      <Card withBorder padding="md">
        <Stack gap="xs">
          <Group justify="space-between">
            <Text fw={600}>本地后端</Text>
            <Group gap="xs">
              <Badge variant="light">{status?.phase ?? '未知'}</Badge>
              <Badge variant="outline">代次 {status?.epoch ?? 0}</Badge>
            </Group>
          </Group>
          <Text size="sm">
            运行模式：<Code>{status?.runtimeKind ?? '-'}</Code>　端口：
            <Code>{status?.port ?? '-'}</Code>
          </Text>
          <Text size="sm">
            进程保护：
            <Code>{status?.protection ?? '-'}</Code>
            {status?.protection === 'heartbeat-only' ? '（非 Job Object 等价保护）' : ''}
          </Text>
          {status?.lastError ? (
            <Alert color="orange" title="最近一次失败">
              {status.lastError.message}
            </Alert>
          ) : null}
          <Group>
            <Button variant="default" onClick={() => runLocal('desktop.openLogs')}>
              打开日志目录
            </Button>
            <Button variant="default" onClick={() => runLocal('desktop.restartBackend')}>
              重启本地后端
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder padding="md">
        <Stack gap="xs">
          <Text fw={600}>已鉴权读取探针</Text>
          {!status?.authenticated ? (
            <Group gap="xs">
              <Loader size="sm" />
              <Text size="sm">等待后端就绪…</Text>
            </Group>
          ) : probe.isPending ? (
            <Group gap="xs">
              <Loader size="sm" />
              <Text size="sm">读取 /api/health 与 /api/config…</Text>
            </Group>
          ) : probe.data ? (
            <List size="sm">
              <List.Item>
                health.app = <Code>{probe.data.health.app}</Code>
              </List.Item>
              <List.Item>
                health.runtime_kind = <Code>{probe.data.health.runtime_kind}</Code>
              </List.Item>
              <List.Item>
                config 字段数 = <Code>{String(Object.keys(probe.data.config).length)}</Code>
              </List.Item>
            </List>
          ) : (
            <Alert color="red" title="读取失败">
              {probe.error?.message ?? '未知错误'}
            </Alert>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
