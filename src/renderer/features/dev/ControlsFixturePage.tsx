/**
 * 开发入口：演示场景切换 + 控件夹具。
 * 场景工具只影响本机演示数据；两者都收在开发路径，不进入产品导航。
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { updateDemoState, useDemoState, type DemoScenario } from '@/mock/demo-store';
import { useMediaService } from '@/shared/api/service-context';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Switch } from '@/shared/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs';

const SCENARIOS: ReadonlyArray<{ value: DemoScenario; label: string; hint: string }> = [
  { value: 'default', label: '默认', hint: '约 240 条演示作品的正常媒体库' },
  { value: 'empty', label: '空库', hint: '来源与作品都为空，用于检查空状态' },
  { value: 'loading', label: '长加载', hint: '读取保持等待，用于检查加载状态' },
  { value: 'error', label: '失败', hint: '读取返回错误，用于检查失败与重试' },
];

export function ControlsFixturePage() {
  const [text, setText] = useState('');
  const [switched, setSwitched] = useState(false);
  const service = useMediaService();
  const queryClient = useQueryClient();
  const demo = useDemoState();

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4" data-route="dev">
      <Card>
        <CardHeader>
          <CardTitle>演示场景</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">
            当前场景：{demo.scenario} · 切换只影响本机演示数据与查询缓存。
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {SCENARIOS.map((scenario) => (
            <Button
              key={scenario.value}
              size="sm"
              variant={demo.scenario === scenario.value ? 'default' : 'outline'}
              title={scenario.hint}
              onClick={() => {
                updateDemoState(() => ({ scenario: scenario.value }));
                void queryClient.invalidateQueries();
              }}
            >
              {scenario.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void service.resetDemoData().then(() => queryClient.invalidateQueries());
            }}
          >
            重置演示数据
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>开发路由</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link
            to="/dev/session"
            className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12.5px] hover:bg-accent"
          >
            桌面链路自检
          </Link>
          <Link
            to="/"
            className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12.5px] hover:bg-accent"
          >
            返回首页
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>控件夹具</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">
            仅用于技术核对：键盘与焦点、弹层与 portal、输入法与状态。
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button>主按钮</Button>
            <Button variant="outline">次按钮</Button>
            <Button variant="ghost" size="icon-sm" aria-label="图标按钮">
              ★
            </Button>
            <Badge variant="soft">标签</Badge>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fixture-text">文本输入（输入法）</Label>
            <Input
              id="fixture-text"
              value={text}
              placeholder="输入中文以验证 IME"
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </div>

          <div className="flex items-center gap-3">
            <Switch id="fixture-switch" checked={switched} onCheckedChange={setSwitched} aria-label="开关" />
            <Label htmlFor="fixture-switch">开关</Label>
          </div>

          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" className="self-start">
                打开对话框
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>对话框</DialogTitle>
                <DialogDescription>Esc 关闭并把焦点还给触发按钮。</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button>关闭</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Tabs defaultValue="first">
            <TabsList>
              <TabsTrigger value="first">标签一</TabsTrigger>
              <TabsTrigger value="second">标签二</TabsTrigger>
            </TabsList>
            <TabsContent value="first" className="pt-3 text-[13px]">
              面板一
            </TabsContent>
            <TabsContent value="second" className="pt-3 text-[13px]">
              面板二
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
