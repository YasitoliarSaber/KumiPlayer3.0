import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import {
  getDemoState,
  resetDemoState,
  updateDemoState,
} from '../../src/renderer/mock/demo-store';
import { createMockMediaService, DemoServiceError } from '../../src/renderer/mock/service';

const catalog = buildMockCatalog();

function service() {
  return createMockMediaService({ latencyMs: 0, catalog });
}

describe('演示业务服务', () => {
  beforeEach(() => {
    resetDemoState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDemoState();
  });

  it('返回与目录一致的媒体库快照与来源卡', async () => {
    const snapshot = await service().listLibrary();
    expect(snapshot.works).toHaveLength(catalog.works.length);
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.sources.some((card) => card.status === 'needs_attention')).toBe(true);
  });

  it('空场景返回空媒体库，但不伪装成连接失败', async () => {
    updateDemoState(() => ({ scenario: 'empty' }));
    const snapshot = await service().listLibrary();
    expect(snapshot.works).toHaveLength(0);
    expect(snapshot.sources.every((card) => card.workCount === 0)).toBe(true);
  });

  it('失败场景抛出可展示错误，长加载场景保持等待直到取消', async () => {
    updateDemoState(() => ({ scenario: 'error' }));
    await expect(service().listLibrary()).rejects.toBeInstanceOf(DemoServiceError);

    updateDemoState(() => ({ scenario: 'loading' }));
    const controller = new AbortController();
    const pending = service().listLibrary(controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DemoServiceError);
  });

  it('收藏与观看状态写入演示存储并反映到后续读取', async () => {
    const target = catalog.works[0]!;
    const instance = service();
    await instance.setFavorite(target.id, true);
    await instance.setWatchStatus(target.id, 'watching');
    const snapshot = await instance.listLibrary();
    const updated = snapshot.works.find((work) => work.id === target.id);
    expect(updated?.watch.favorite).toBe(true);
    expect(updated?.watch.status).toBe('watching');
    expect(getDemoState().favorite[target.id]).toBe(true);
  });

  it('任务经历 等待 → 进行 → 成功，并可通过任务中心读取', async () => {
    vi.useFakeTimers();
    const instance = service();
    const pending = instance.startScan('src-local-anime');
    await vi.advanceTimersByTimeAsync(120);
    const task = await pending;
    expect(task.status).toBe('queued');

    await vi.advanceTimersByTimeAsync(400);
    expect(getDemoState().tasks.find((entry) => entry.id === task.id)?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(3000);
    const finished = getDemoState().tasks.find((entry) => entry.id === task.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.progress).toBe(1);
    expect(finished?.cancellable).toBe(false);
  });

  it('取消任务进入 cancelling 再到 cancelled，并说明作用域', async () => {
    vi.useFakeTimers();
    const instance = service();
    const pending = instance.startScan('src-baidu');
    await vi.advanceTimersByTimeAsync(120);
    const task = await pending;
    const cancelling = instance.cancelTask(task.id);
    await vi.advanceTimersByTimeAsync(80);
    await cancelling;
    expect(getDemoState().tasks.find((entry) => entry.id === task.id)?.status).toBe('cancelling');
    await vi.advanceTimersByTimeAsync(1000);
    const cancelled = getDemoState().tasks.find((entry) => entry.id === task.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.message).toContain('修订');
  });

  it('只有失败或已取消任务可以重试', async () => {
    vi.useFakeTimers();
    const instance = service();
    const pending = instance.startScan('src-openlist');
    await vi.advanceTimersByTimeAsync(120);
    const task = await pending;
    const attempt = instance.retryTask(task.id);
    const assertion = expect(attempt).rejects.toBeInstanceOf(DemoServiceError);
    await vi.advanceTimersByTimeAsync(120);
    await assertion;
  });

  it('播放返回与详情一致的剧集身份，停止时写回模拟进度', async () => {
    const instance = service();
    const work = catalog.works.find((entry) => entry.showType === 'anime_series')!;
    const detail = await instance.getWorkDetail(work.id);
    const episode = detail.seasons[0]!.episodes[0]!;

    const session = await instance.play(work.id, episode.id, episode.assets[0]!.id);
    expect(session.workId).toBe(work.id);
    expect(session.episodeId).toBe(episode.id);
    expect(getDemoState().playback?.episodeId).toBe(episode.id);

    await instance.saveProgress(work.id, episode.id, 600, episode.durationSec);
    const stored = getDemoState().progress[work.id];
    expect(stored?.position).toBe(600);
    expect(stored?.duration).toBe(episode.durationSec);

    await instance.stopPlayback();
    expect(getDemoState().playback).toBeNull();
  });

  it('演示设置按分类写入且可读回', async () => {
    const instance = service();
    const updated = await instance.updateSettings('appearance', { theme: 'cinema' });
    expect(updated.appearance.theme).toBe('cinema');
    const reread = await instance.getSettings();
    expect(reread.appearance.theme).toBe('cinema');
    // 其它分类保持默认，不会互相覆盖。
    expect(reread.player.mode).toBe('internal');
  });
});
