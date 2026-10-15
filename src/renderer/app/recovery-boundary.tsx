/**
 * 恢复边界：React 未捕获异常不留下空白窗口，直接进入可操作的恢复界面。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';

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

  override render(): ReactNode {
    if (this.state.message.length === 0) {
      return this.props.children;
    }
    return (
      <div className="mx-auto mt-[10vh] w-[min(560px,calc(100vw-2rem))]">
        <Card>
          <CardHeader>
            <CardTitle>界面需要恢复</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-[13.5px] text-foreground">{this.state.message}</p>
            <p className="text-[12.5px] text-muted-foreground">
              媒体库与后台任务不受影响；重新加载界面不会重启任何服务。
            </p>
            <div>
              <Button onClick={() => window.location.reload()}>重新加载界面</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
