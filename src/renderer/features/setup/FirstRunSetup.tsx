/**
 * 演示版首次引导（N20）。
 *
 * 对应现有产品的四步：说明 → 播放器 → 媒体来源 → 可选元数据账号。
 * 全部写入本机演示设置：完成与"稍后设置"分开记录，取消/关闭不清空已有设置，
 * 也不冒充已完成。可从设置里的入口随时重新打开。
 */

import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, PlaySquare, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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
  // 演示实现只写本机演示存储；真实实现调用后端的引导端点并如实报错。
  const demoMode = service.serviceMode === 'demo';
  const [step, setStep] = useState(0);
  const [playerMode, setPlayerMode] = useState<'internal' | 'external'>('internal');
  const [localRoot, setLocalRoot] = useState('');
  const [ongoingInterval, setOngoingInterval] = useState(0);
  const [tmdbToken, setTmdbToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'finish' | 'defer'>('');

  // 打开引导时回到第一步并清掉上一条提示。
  useEffect(() => {
    if (open) {
      setStep(0);
      setMessage('');
      setError('');
    }
  }, [open]);

  // 初值只在打开后第一次拿到设置时填充：之后的后台重新读取不能重置步骤或覆盖用户输入。
  const initialisedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      initialisedRef.current = false;
      return;
    }
    const data = settings.data;
    if (!initialisedRef.current && data) {
      initialisedRef.current = true;
      setPlayerMode(data.player.mode);
      setLocalRoot(data.sources.localRoots[0]?.path ?? '');
      setOngoingInterval(data.sources.ongoingIntervalMinutes);
    }
  }, [open, settings.data]);

  // 外部 MPV 路径来自已保存配置；本对话框不新增路径输入，未配置时由后端在完成时拒绝。
  const externalPath = settings.data?.player.externalPath ?? '';

  /**
   * 完成设置：真实模式由后端校验播放器与至少一个可访问来源后才标记完成，
   * 演示模式写本机演示存储。失败保留输入、显示真实原因，不关闭成"已完成"。
   */
  const finish = async () => {
    setMessage('');
    setError('');
    setBusy('finish');
    try {
      if (ongoingInterval !== 0 && ongoingInterval < 15) {
        throw new Error('定时更新间隔需为 0（关闭）或至少 15 分钟。');
      }
      const completeSetup = service.completeSetup;
      if (!completeSetup) {
        throw new Error('当前服务没有完成首次引导的通道，设置未保存。');
      }
      const token = tmdbToken.trim();
      if (token.length > 0) {
        // 令牌必须经验证端点写入；这里不使用任何伪造的"已配置"字段。
        const saveTmdbCredential = service.saveTmdbCredential;
        if (!saveTmdbCredential) {
          throw new Error('当前服务没有保存 TMDB 令牌的通道，设置未保存。');
        }
        await saveTmdbCredential(token);
      }
      await completeSetup({
        playerMode,
        ...(playerMode === 'external' && externalPath.trim().length > 0
          ? { externalMpvPath: externalPath.trim() }
          : {}),
        ...(localRoot.trim().length > 0 ? { localRoot: localRoot.trim() } : {}),
      });
      if (ongoingInterval !== (settings.data?.sources.ongoingIntervalMinutes ?? 0)) {
        // 更新间隔不属于引导完成端点，按后端字段单独保存；失败会中断并如实报错。
        await service.updateSettings('sources', { ongoingIntervalMinutes: ongoingInterval });
      }
      await queryClient.invalidateQueries({ queryKey: demoQueryKeys.settings });
      if (demoMode) {
        setMessage('演示设置已保存。');
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置未完成，请检查后重试。');
    } finally {
      setBusy('');
    }
  };

  const defer = async () => {
    setMessage('');
    setError('');
    setBusy('defer');
    try {
      // "稍后设置"只记录推迟，不算完成；已有设置保持不变。
      const deferSetup = service.deferSetup;
      if (!deferSetup) {
        throw new Error('当前服务没有记录"稍后设置"的通道，未写入任何内容。');
      }
      await deferSetup();
      await queryClient.invalidateQueries({ queryKey: demoQueryKeys.settings });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '未能记录"稍后设置"，请重试。');
    } finally {
      setBusy('');
    }
  };

  const title = mode === 'reconfigure'
    ? '重新运行设置引导'
    : demoMode
      ? '欢迎使用 KumiPlayer（演示）'
      : '欢迎使用 KumiPlayer';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="w-[min(620px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {demoMode
              ? '当前是演示模式：不会读取真实配置、凭据或媒体，所有选择只写在本机演示存储。'
              : '完成设置时会校验播放器与至少一个可访问的媒体来源；未完成的内容不会被标记为已完成。'}
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
                {demoMode ? (
                  <>
                    <li>演示模式使用本机模拟数据，不启动 Python 后端、不读写真实媒体库。</li>
                    <li>真实实现中：媒体事实保存在 SQLite，来源媒体不会被移动或改名。</li>
                    <li>凭据由系统凭据管理器保存；演示模式不读取也不保存任何凭据。</li>
                  </>
                ) : (
                  <>
                    <li>媒体事实保存在本机 SQLite，来源媒体不会被移动或改名。</li>
                    <li>播放由本机 mpv 完成；内置播放器运行时未就绪时无法完成设置。</li>
                    <li>凭据由系统凭据管理器保存，不写入配置文件、日志或界面存储。</li>
                  </>
                )}
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
                  data={demoMode
                    ? [
                        { value: 'internal', label: '内置播放器（演示为模拟播放）' },
                        { value: 'external', label: '外部 MPV 整合包（演示不读取路径）' },
                      ]
                    : [
                        { value: 'internal', label: 'KumiPlayer 内置播放器' },
                        { value: 'external', label: '外部 MPV（使用「设置 → 播放」保存的路径）' },
                      ]}
                  value={playerMode}
                  onChange={(value) => setPlayerMode(value as 'internal' | 'external')}
                  label="播放方式"
                />
              </div>
              <p className="text-muted-foreground">
                {demoMode
                  ? '演示模式不会启动 mpv；播放按钮只展示模拟播放态与进度回写。'
                  : '外部 MPV 的路径在「设置 → 播放」中配置；路径不可用或内置运行时未就绪时，完成设置会被后端拒绝并给出原因。'}
              </p>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-3">
              <p className="font-medium">媒体来源</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-root">{demoMode ? '本地目录（演示）' : '本地目录'}</Label>
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
              <p className="text-muted-foreground">
                {demoMode
                  ? '网盘目录树、OpenList 与混合来源可在设置里的「媒体来源 / WebDAV 设置」继续配置。'
                  : '完成设置至少需要一个可访问的媒体来源；目录树、OpenList 与混合来源可在设置里的「媒体来源 / WebDAV 设置」继续配置。'}
              </p>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-3">
              <p className="font-medium">资料账号（可选）</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-tmdb">
                  {demoMode ? 'TMDB 读取访问令牌（演示占位）' : 'TMDB 读取访问令牌'}
                </Label>
                <Input
                  id="setup-tmdb"
                  type="password"
                  value={tmdbToken}
                  placeholder={demoMode ? '演示模式不会保存此值' : '粘贴 TMDB API 读取访问令牌'}
                  onChange={(event) => setTmdbToken(event.currentTarget.value)}
                />
              </div>
              <p className="text-muted-foreground">
                {demoMode
                  ? '真实实现中令牌由系统凭据管理器保存；演示只记住"已填写"这一状态，输入内容不会写入演示存储或日志。'
                  : '令牌交给本机后端验证，通过后由系统凭据管理器保存；验证失败会显示原因，输入会保留以便修改。留空表示稍后在设置中配置。'}
              </p>
            </div>
          ) : null}
        </div>

        {message ? (
          <p className="text-[12px] text-muted-foreground" role="status">
            {message}
          </p>
        ) : null}

        {error ? (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
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
              // 只有最后一屏的「完成设置」才写入：真实模式避免留下未验证的半套配置，
              // 演示模式同样只在完成/推迟时落盘，"取消"不会清空已有设置。
              onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}
            >
              下一步
            </Button>
          ) : (
            <Button size="sm" loading={busy === 'finish'} onClick={() => void finish()}>
              <Check className="size-3.5" />
              完成设置
            </Button>
          )}
          <Tooltip label="记录为稍后设置；未完成不会被标记为已完成">
            <Button variant="ghost" size="sm" loading={busy === 'defer'} onClick={() => void defer()}>
              稍后设置
            </Button>
          </Tooltip>
          <DialogFooter>
            {/* 关闭对话框用「取消」：不保存本次改动，也不清空已有设置。 */}
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
          </DialogFooter>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
