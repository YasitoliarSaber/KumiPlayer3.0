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

  it('候选检索为空时返回空数组，确认失败候选不改写覆盖', async () => {
    const instance = service();
    const work = catalog.works[0]!;
    // 空关键词代表"没有可用候选"，用于演示需要人工介入的路径。
    expect(await instance.metadataCandidates(work.id, '   ')).toEqual([]);

    const candidates = await instance.metadataCandidates(work.id, work.title);
    expect(candidates.length).toBeGreaterThan(0);
    const failing = candidates.find((candidate) => candidate.failing);
    expect(failing).toBeDefined();

    await expect(instance.confirmCandidate(work.id, failing!.id)).rejects.toBeInstanceOf(DemoServiceError);
    // 失败必须保留原值：覆盖层不能出现候选记录。
    expect(getDemoState().overrides[work.id]?.metadataCandidateId).toBeUndefined();
  });

  it('确认可用候选写入手动来源标记', async () => {
    const instance = service();
    const work = catalog.works[0]!;
    const candidates = await instance.metadataCandidates(work.id, work.title);
    const ok = candidates.find((candidate) => !candidate.failing)!;
    const override = await instance.confirmCandidate(work.id, ok.id);
    expect(override.metadataProvenance).toBe('manual');
    expect(override.metadataCandidateId).toBe(ok.id);
  });

  it('手动标题与图片写入覆盖层，列表读取立即反映，恢复自动后清除', async () => {
    const instance = service();
    const work = catalog.works[1]!;
    await instance.setManualTitle(work.id, '人工标题（演示）');
    await instance.setManualArtwork(work.id, 'poster', {
      url: '/__mock/w01/poster.jpg',
      width: 256,
      height: 384,
    });

    const snapshot = await instance.listLibrary();
    const updated = snapshot.works.find((item) => item.id === work.id)!;
    expect(updated.title).toBe('人工标题（演示）');
    expect(updated.artwork.poster?.url).toBe('/__mock/w01/poster.jpg');

    await instance.resetManualTitle(work.id);
    await instance.resetManualArtwork(work.id);
    const restored = (await instance.listLibrary()).works.find((item) => item.id === work.id)!;
    expect(restored.title).toBe(work.title);
    expect(restored.artwork.poster?.url).toBe(work.artwork.poster?.url);
  });

  it('Bangumi 绑定后同步生成任务并累计已同步集数，失败条目保留失败状态', async () => {
    const instance = service();
    const work = catalog.works[2]!;

    const subjects = await instance.bangumiSearch(work.title);
    expect(subjects.length).toBeGreaterThan(0);
    const good = subjects.find((subject) => !subject.id.startsWith('bgm-3'))!;
    const bound = await instance.bangumiBind(work.id, good.id);
    expect(bound.bangumi?.status).toBe('matched');

    const task = await instance.bangumiSync(work.id);
    expect(task.type).toBe('bangumi_sync');
    expect(await instance.listTasks()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id })]),
    );

    // 解除绑定后同步必须失败，且不留下绑定。
    await instance.bangumiUnbind(work.id);
    await expect(instance.bangumiSync(work.id)).rejects.toBeInstanceOf(DemoServiceError);
    expect(getDemoState().overrides[work.id]?.bangumi).toBeUndefined();
  });

  it('压力库规模按 240 / 2000 / 5000 生成唯一 ID', async () => {
    // 该用例必须使用真实目录（不注入小夹具），才验证规模切换本身。
    const instance = createMockMediaService({ latencyMs: 0 });
    for (const size of [2000, 5000] as const) {
      updateDemoState(() => ({ librarySize: size }));
      const snapshot = await instance.listLibrary();
      expect(snapshot.works).toHaveLength(size);
      expect(new Set(snapshot.works.map((work) => work.id)).size).toBe(size);
    }
  });

  it('缺图 / 长标题 / 无版本场景给出稳定回退数据', async () => {
    const instance = service();
    const work = catalog.works[0]!;

    updateDemoState(() => ({ scenario: 'missing-artwork' }));
    const missing = await instance.listLibrary();
    expect(missing.works.every((item) => item.artwork.poster === null)).toBe(true);
    expect(missing.works.every((item) => item.artwork.episodeThumbs.length === 0)).toBe(true);

    updateDemoState(() => ({ scenario: 'long-titles' }));
    const longTitles = await instance.listLibrary();
    expect(longTitles.works[0]!.title.length).toBeGreaterThan(work.title.length);

    updateDemoState(() => ({ scenario: 'no-assets' }));
    const detail = await instance.getWorkDetail(work.id);
    expect(detail.assetCount).toBe(0);
    expect(detail.seasons[0]!.episodes.every((episode) => episode.assets.length === 0)).toBe(true);
  });

  it('任务失败场景让新任务以失败收尾并保留可重试状态', async () => {
    vi.useFakeTimers();
    const instance = service();
    updateDemoState(() => ({ scenario: 'task-failure' }));

    const pending = instance.startScan('src-local-anime');
    await vi.advanceTimersByTimeAsync(200);
    const task = await pending;
    await vi.advanceTimersByTimeAsync(4000);

    const finished = getDemoState().tasks.find((entry) => entry.id === task.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toContain('演示场景');
    expect(finished?.cancellable).toBe(false);
  });
});
