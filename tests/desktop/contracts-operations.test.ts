import { describe, expect, it } from 'vitest';

import {
  OPERATION_IDS,
  OPERATION_SPECS,
  resolveHttpTarget,
} from '@shared/contracts/operations';

describe('具名操作白名单', () => {
  it('只登记本轮实际消费的端点，且都带有显式期限', () => {
    expect(OPERATION_IDS.length).toBeGreaterThan(0);
    for (const id of OPERATION_IDS) {
      expect(OPERATION_SPECS[id].timeoutMs).toBeGreaterThan(0);
    }
  });

  it('把具名操作解析成固定路径，并拒绝未登记的操作', () => {
    const resolved = resolveHttpTarget({
      operation: 'work.detail',
      params: { workId: 'work-123' },
      requestId: 'r1',
    });
    expect(resolved).toEqual({
      ok: true,
      target: { method: 'GET', path: '/api/library/works/work-123', query: [] },
    });

    const unknown = resolveHttpTarget({
      // 故意传入未登记的操作 id（模拟被攻陷的 Renderer）。
      operation: 'admin.exec' as never,
      requestId: 'r2',
    });
    expect(unknown.ok).toBe(false);
  });

  it('拒绝路径参数中的分隔符与未登记的查询参数', () => {
    const traversal = resolveHttpTarget({
      operation: 'work.detail',
      params: { workId: '../../etc/passwd' },
      requestId: 'r3',
    });
    expect(traversal.ok).toBe(false);

    const extraQuery = resolveHttpTarget({
      operation: 'library.list',
      query: { source: 'local', evil: '1' },
      requestId: 'r4',
    });
    expect(extraQuery.ok).toBe(false);
  });

  it('GET 操作不接受请求体', () => {
    const withBody = resolveHttpTarget({
      operation: 'library.list',
      body: { anything: 1 },
      requestId: 'r5',
    });
    expect(withBody.ok).toBe(false);
  });
});
