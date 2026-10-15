/**
 * 恢复边界：React 未捕获异常不留下空白窗口，直接进入可操作的恢复界面。
 */

import { Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly message: string;
}

export class RecoveryBoundary extends Component<Props, State> {
  override state: State = { message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : '界面发生未知错误' };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只记录消息与组件栈，不记录 Token、凭据或媒体路径。
    console.error('[renderer] 组件异常', error.message, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.message.length === 0) {
      return this.props.children;
    }
    return (
      <Card maw={560} mx="auto" mt="10vh" padding="lg" withBorder>
        <Stack gap="sm">
          <Title order={3}>界面需要恢复</Title>
          <Text size="sm">{this.state.message}</Text>
          <Text size="xs" c="dimmed">
            本地媒体库与后台任务不受影响；重新加载界面不会重启后端。
          </Text>
          <Group>
            <Button onClick={this.reload}>重新加载界面</Button>
          </Group>
        </Stack>
      </Card>
    );
  }
}
