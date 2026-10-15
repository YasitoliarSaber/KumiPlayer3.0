/**
 * 演示版首次引导（N20）。
 *
 * 对应现有产品的四步：说明 → 播放器 → 媒体来源 → 可选元数据账号。
 * 全部写入本机演示设置：完成与"稍后设置"分开记录，取消/关闭不清空已有设置，
 * 也不冒充已完成。可从设置里的入口随时重新打开。
 */

import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, PlaySquare, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import { demoQueryKeys, useMediaService, useSettings } from '@/shared/api/service-context';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { NumberInput, Select, Tooltip } from '@/features/settings/demo-form';
import { cn } from '@/shared/lib/utils';

const STEPS = ['运行方式', '播放器', '媒体来源', '资料账号'] as const;

export interface FirstRunSetupProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly mode: 'first-run' | 'reconfigure';
}

export function FirstRunSetup({ open, onClose, mode }: FirstRunSetupProps) {
  const settings = useSettings();
  const service = useMediaService();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [playerMode, setPlayerMode] = useState<'internal' | 'external'>('internal');
  const [localRoot, setLocalRoot] = useState('');
  const [ongoingInterval, setOngoingInterval] = useState(0);
  const [tmdbToken, setTmdbToken] = useState('');
  const [message, setMessage] = useState('');

  // 每次打开都从第一步开始，但保留已有演示设置作为初始值。
  useEffect(() => {
    if (!open) {
      return;
    }
    setStep(0);
    setMessage('');
    const data = settings.data;
    if (data) {
      setPlayerMode(data.player.mode);
      setLocalRoot(data.sources.localRoots[0]?.path ?? '');
      setOngoingInterval(data.sources.ongoingIntervalMinutes);
    }
  }, [open, settings.data]);

  const save = async (patch: Record<string, unknown>, section: 'application' | 'player' | 'sources' | 'scrape') => {
    await service.updateSettings(section, patch);
    void queryClient.invalidateQueries({ queryKey: demoQueryKeys.settings });
  };

  const finish = async () => {
    await save({ setupCompleted: true, setupDeferred: false }, 'application');
    setMessage('演示设置已保存。');
    onClose();
  };

  const defer = async () => {
    // "稍后设置"只记录推迟，不算完成；已有设置保持不变。
    await save({ setupDeferred: true }, 'application');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-[min(620px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{mode === 'first-run' ? '欢迎使用 KumiPlayer（演示）' : '重新运行设置引导'}</DialogTitle>
          <DialogDescription>
            当前是演示模式：不会读取真实配置、凭据或媒体，所有选择只写在本机演示存储。
          </DialogDescription>
        </DialogHeader>

        <ol className="flex flex-wrap gap-2" aria-label="引导步骤">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12.5px]',
                index === step ? 'border-primary bg-accent text-accent-foreground' : 'border-border text-muted-foreground',
              )}
            >
              <span className="grid size-4 place-items-center rounded-full bg-card text-[11px]">{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        <div className="min-h-[168px] text-[13px]">
          {step === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 font-medium">
                <ShieldCheck className="size-4" />
                数据与运行方式
              </p>
              <ul className="ml-1 flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
                <li>演示模式使用本机模拟数据，不启动 Python 后端、不读写真实媒体库。</li>
                <li>真实实现中：媒体事实保存在 SQLite，来源媒体不会被移动或改名。</li>
                <li>凭据由系统凭据管理器保存；演示模式不读取也不保存任何凭据。</li>
              </ul>
              <p className="text-muted-foreground">
                引导可以随时跳过：未完成的配置不会被标记为已完成。
              </p>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="flex flex-col gap-3">
              <p className="flex items-center gap-2 font-medium">
                <PlaySquare className="size-4" />
                播放器
              </p>
              <div className="flex flex-col gap-1.5">
                <Label>播放方式</Label>
                <Select
                  data={[
                    { value: 'internal', label: '内置播放器（演示为模拟播放）' },
                    { value: 'external', label: '外部 MPV 整合包（演示不读取路径）' },
                  ]}
                  value={playerMode}
                  onChange={(value) => setPlayerMode(value as 'internal' | 'external')}
                  label="播放方式"
                />
              </div>
              <p className="text-muted-foreground">
                演示模式不会启动 mpv；播放按钮只展示模拟播放态与进度回写。
              </p>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-3">
              <p className="font-medium">媒体来源</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-root">本地目录（演示）</Label>
                <Input
                  id="setup-root"
                  value={localRoot}
                  placeholder="例如 D:\\Media\\Anime"
                  onChange={(event) => setLocalRoot(event.currentTarget.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>定时更新间隔（分钟，0 表示关闭）</Label>
                <NumberInput
                  value={ongoingInterval}
                  min={0}
                  max={10080}
                  step={15}
                  label="定时更新间隔"
                  onChange={(value) => setOngoingInterval(value ?? 0)}
                />
              </div>
              <p className="text-muted-foreground">网盘目录树、OpenList 与混合来源可在设置里的「媒体来源 / WebDAV 目录」继续配置。</p>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-3">
              <p className="font-medium">资料账号（可选）</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-tmdb">TMDB 读取访问令牌（演示占位）</Label>
                <Input
                  id="setup-tmdb"
                  type="password"
                  value={tmdbToken}
                  placeholder="演示模式不会保存此值"
                  onChange={(event) => setTmdbToken(event.currentTarget.value)}
                />
              </div>
              <p className="text-muted-foreground">
                真实实现中令牌由系统凭据管理器保存；演示只记住"已填写"这一状态，输入内容不会写入演示存储或日志。
              </p>
            </div>
          ) : null}
        </div>

        {message ? (
          <p className="text-[12px] text-muted-foreground" role="status">
            {message}
          </p>
        ) : null}

        <DialogFooter className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            <ChevronLeft className="size-3.5" />
            上一步
          </Button>
          {step < STEPS.length - 1 ? (
            <Button
              size="sm"
              onClick={() => {
                // 逐步落地选择，避免"最后一步取消"丢失已做的演示设置。
                if (step === 1) {
                  void save({ mode: playerMode }, 'player');
                }
                if (step === 2) {
                  void save(
                    {
                      ongoingIntervalMinutes: ongoingInterval,
                      ...(localRoot.trim().length > 0
                        ? {
                            localRoots: [
                              { id: 'setup-local', path: localRoot.trim(), name: '引导登记目录' },
                            ],
                          }
                        : {}),
                    },
                    'sources',
                  );
                }
                if (step === 3) {
                  void save({ tmdbConfigured: tmdbToken.trim().length > 0 }, 'scrape');
                }
                setStep((value) => Math.min(STEPS.length - 1, value + 1));
              }}
            >
              下一步
            </Button>
          ) : (
            <Button size="sm" onClick={() => void finish()}>
              <Check className="size-3.5" />
              完成设置
            </Button>
          )}
          <Tooltip label="记录为稍后设置；未完成不会被标记为已完成">
            <Button variant="ghost" size="sm" onClick={() => void defer()}>
              稍后设置
            </Button>
          </Tooltip>
          <DialogFooter>
            {/* 关闭对话框用「取消」：不保存本次改动，也不清空已有演示设置。 */}
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
          </DialogFooter>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
