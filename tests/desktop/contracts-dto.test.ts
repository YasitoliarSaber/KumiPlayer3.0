import { describe, expect, it } from 'vitest';

import {
  parseBangumiSession,
  parseLibraryChanges,
  parseLibrarySnapshot,
  parsePlaybackStatus,
  parseTaskList,
  parseWorkCard,
  parseWorkDeletePreview,
} from '@shared/contracts/dto';
import { hasResponseParser, interpretFailurePayload } from '@shared/contracts/responses';

import { loadFixture } from './fixtures';

describe('响应契约与真实夹具', () => {
  it('真实 /api/library 空库响应可以被当前 DTO 解析', () => {
    const fixture = loadFixture('library');
    const parsed = parseLibrarySnapshot(fixture.body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.works).toEqual([]);
      expect(parsed.value.change_sequence).toBe(0);
      expect(parsed.value.generation_id.length).toBeGreaterThan(0);
    }
  });

  it('真实 /api/library/changes 响应使用 next_sequence 而不是 cursor', () => {
    const fixture = loadFixture('library-changes');
    const parsed = parseLibraryChanges(fixture.body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.next_sequence).toBe(0);
      expect(parsed.value.reset_required).toBe(false);
    }
  });

  it('真实 /api/tasks 空列表响应可解析', () => {
    const fixture = loadFixture('tasks');
    const parsed = parseTaskList(fixture.body);
    expect(parsed.ok).toBe(true);
  });

  it('真实 /api/playback/status 是 {status, session}，不是平面播放字段', () => {
    const fixture = loadFixture('playback-status');
    const parsed = parsePlaybackStatus(fixture.body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.status).toBe('idle');
      expect(parsed.value.session).toBeNull();
    }
  });

  it('形状不符的响应被判为无效，不用断言掩盖缺口', () => {
    const broken = parseLibrarySnapshot({ works: 5, summary: {} });
    expect(broken.ok).toBe(false);

    const wrongCard = parseWorkCard({ work_id: 'w1', title: '标题', media_type: 'documentary' });
    expect(wrongCard.ok).toBe(false);
  });

  it('FastAPI 校验错误列表保留结构化明细', () => {
    const error = interpretFailurePayload(422, {
      detail: [{ loc: ['body', 'work_id'], msg: '字段必填', type: 'missing' }],
    });
    expect(error.kind).toBe('validation');
    expect(error.details?.[0]?.location).toBe('body.work_id');
  });

  it('401 错误体按字符串 detail 解释', () => {
    const fixture = loadFixture('error-unauthorized');
    const error = interpretFailurePayload(fixture.status, fixture.body);
    expect(error.kind).toBe('auth');
    expect(error.message).toContain('桌面会话');
  });

  it('每个 HTTP 操作都必须有响应解析器', () => {
    expect(hasResponseParser('library.list')).toBe(true);
    expect(hasResponseParser('tasks.list')).toBe(true);
    expect(hasResponseParser('config.get')).toBe(true);
    expect(hasResponseParser('bangumi.session')).toBe(true);
    expect(hasResponseParser('bangumi.progress.sync')).toBe(true);
    expect(hasResponseParser('system.openFolder')).toBe(true);
    expect(hasResponseParser('work.folder')).toBe(true);
    expect(hasResponseParser('work.deleteConfirm')).toBe(true);
    expect(hasResponseParser('desktop.status')).toBe(false);
  });

  it('Bangumi 账号名只从 session 的 user 字段读取', () => {
    const parsed = parseBangumiSession({
      credential_state: 'found',
      credential_saved: true,
      auth_status: 'valid',
      connectivity: 'online',
      status: 'connected',
      user: { id: 42, username: 'kumi', nickname: '久美子', avatar: '/api/integrations/bangumi/avatar?url=x', sign: '' },
      last_verified_at: '2026-10-17T10:00:00+08:00',
      last_success_at: '',
      last_failure_at: '',
      last_http_status: 200,
      last_error_code: '',
      last_error_message: '',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.user?.nickname).toBe('久美子');
      expect(parsed.value.credential_state).toBe('found');
    }
    // 未登录时 user 为 null，凭据态与账号资料必须分开判断。
    const signedOut = parseBangumiSession({
      credential_state: 'not_found',
      credential_saved: false,
      auth_status: 'unknown',
      connectivity: 'unknown',
      status: 'signed_out',
      user: null,
    });
    expect(signedOut.ok).toBe(true);
    if (signedOut.ok) {
      expect(signedOut.value.user).toBeNull();
    }
  });

  it('删除预览只保留影响计数与类型，不把绝对路径带进视图', () => {
    const parsed = parseWorkDeletePreview({
      preview_id: 'prev_work_abc',
      work_id: 'w1',
      revision_id: 'rev_1',
      artifact_paths: ['Z:/mirror/作品/a.nfo'],
      playback_count: 3,
      tracking_count: 1,
      blocked: true,
      blocked_job_count: 2,
      blocked_job_types: ['scrape_work', 'refresh_projection'],
      digest: 'd'.repeat(64),
      artifact_count: 1,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({ blocked: true, blocked_job_count: 2, artifact_count: 1 });
      expect(Object.keys(parsed.value)).not.toContain('artifact_paths');
    }
  });

  it('缺少必填身份的删除预览被判为无效，不用断言掩盖', () => {
    expect(parseWorkDeletePreview({ work_id: 'w1' }).ok).toBe(false);
  });
});
