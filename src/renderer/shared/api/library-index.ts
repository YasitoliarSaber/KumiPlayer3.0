/**
 * 轻量作品索引的规范化与增量合并（B 6.1 / 6.2）。
 *
 * 这里只有纯函数：单一游标、一次提交、失败不推进游标。
 * 不复制第二份媒体权威，也不做任何识别、合卡或编号推导。
 */

import type {
  LibraryChange,
  LibraryChanges,
  LibrarySnapshot,
  WorkCard,
} from '@shared/contracts/dto';

export interface LibraryIndex {
  readonly epoch: number;
  readonly cursor: number;
  readonly generationId: string;
  readonly digest: string;
  readonly updating: boolean;
  readonly backgroundActive: boolean;
  readonly works: Readonly<Record<string, WorkCard>>;
  readonly order: readonly string[];
}

export function emptyLibraryIndex(epoch: number): LibraryIndex {
  return {
    epoch,
    cursor: 0,
    generationId: '',
    digest: '',
    updating: false,
    backgroundActive: false,
    works: {},
    order: [],
  };
}

export function applySnapshot(previous: LibraryIndex, snapshot: LibrarySnapshot): LibraryIndex {
  const works: Record<string, WorkCard> = {};
  const order: string[] = [];
  for (const card of snapshot.works) {
    if (!works[card.work_id]) {
      order.push(card.work_id);
    }
    works[card.work_id] = card;
  }
  return {
    ...previous,
    cursor: snapshot.change_sequence,
    generationId: snapshot.generation_id,
    digest: snapshot.digest,
    updating: snapshot.updating,
    backgroundActive: snapshot.background_active,
    works,
    order,
  };
}

export interface ChangeApplication {
  readonly index: LibraryIndex;
  /** true 表示需要重新读取基线快照，而不是继续增量。 */
  readonly resyncRequired: boolean;
  /** 需要重新拉取卡片的 work_id。 */
  readonly affected: readonly string[];
}

/**
 * 应用一批变更。失败或 `reset_required` 时不推进游标，
 * 也不允许用失败结果覆盖有效卡片。
 */
export function applyChanges(
  previous: LibraryIndex,
  changes: LibraryChanges,
  cards: readonly WorkCard[],
): ChangeApplication {
  if (changes.reset_required) {
    return { index: previous, resyncRequired: true, affected: [] };
  }
  const works: Record<string, WorkCard> = { ...previous.works };
  const order = [...previous.order];
  const affected = new Set<string>();

  for (const change of changes.changes) {
    if (change.work_id.length === 0) {
      continue;
    }
    affected.add(change.work_id);
    if (change.kind === 'work_remove') {
      delete works[change.work_id];
    }
  }
  for (const card of cards) {
    works[card.work_id] = card;
    if (!order.includes(card.work_id)) {
      order.push(card.work_id);
    }
  }
  const finalOrder = order.filter((workId) => works[workId] !== undefined);

  if (changes.updating !== previous.updating) {
    // 只更新状态位，不改变任何作品对象引用。
  }

  return {
    index: {
      ...previous,
      cursor: changes.next_sequence,
      generationId: changes.generation_id || previous.generationId,
      updating: changes.updating,
      backgroundActive: changes.background_active,
      works,
      order: finalOrder,
    },
    resyncRequired: false,
    affected: [...affected],
  };
}

/** 变更泵节奏：可见且后台活跃约 1 秒，空闲 5 秒，隐藏 30 秒（承接现有实现）。 */
export function pumpIntervalMs(visible: boolean, backgroundActive: boolean): number {
  if (!visible) {
    return 30_000;
  }
  return backgroundActive ? 1_000 : 5_000;
}

/** 一次轮次内的批次上限；cards 每批最多 128（与后端上限一致）。 */
export const CHANGE_BATCH_LIMIT = 128;

export function batchIds(ids: readonly string[], size = CHANGE_BATCH_LIMIT): readonly (readonly string[])[] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    batches.push(ids.slice(index, index + size));
  }
  return batches;
}

export function changeTouchesWork(change: LibraryChange): boolean {
  return change.kind === 'work_upsert' || change.kind === 'work_remove';
}
