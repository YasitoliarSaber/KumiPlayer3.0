/**
 * 读取本轮抓取的真实响应夹具（tests/desktop/fixtures/*.json）。
 * 夹具由 scripts/desktop/capture-dto-fixtures.cjs 在隔离数据目录生成。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface CapturedFixture {
  readonly status: number;
  readonly body: unknown;
}

const fixturesDir = path.join(__dirname, 'fixtures');

export function loadFixture(name: string): CapturedFixture {
  const file = path.join(fixturesDir, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CapturedFixture;
}
