#!/usr/bin/env node
/**
 * 演示模式素材准备。
 *
 * 从本地素材导出目录（`.context/artwork-export/<日期>/`）挑选若干部作品，
 * 把海报、背景、透明标志与剧集缩略图复制到被忽略的 `.build/desktop/mock-assets/`，
 * 并生成 Renderer 可静态引用的清单 `src/renderer/mock/asset-manifest.ts`。
 *
 * 约束：
 * - 只复制选定素材，不复制整个导出目录；
 * - 输出清单只写相对文件名与作品展示信息，不写任何原始私有路径；
 * - 素材缺失时明确报错并给出缺失项，不静默跳过。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');

/** 选定的作品：基作目录前缀 + 演示用稳定 slug。 */
const SELECTED = [
  { slug: 'w01', match: 'CLANNAD' },
  { slug: 'w02', match: 'Dandadan' },
  { slug: 'w03', match: 'Hyouka' },
  { slug: 'w04', match: 'Kono Subarashii' },
  { slug: 'w05', match: 'Majo no Tabitabi' },
  { slug: 'w06', match: 'Shoujo Shuumatsu' },
  // 该基作没有 clearlogo，用于验证详情页的透明标志回退。
  { slug: 'w07', match: '86-' },
];

const ROLE_LIMITS = { poster: 1, fanart: 1, clearlogo: 1, episode_thumb: 4 };

function findExportDir() {
  const root = path.join(projectRoot, '.context', 'artwork-export');
  if (!fs.existsSync(root)) {
    fail(`未找到素材导出目录：${path.join('.context', 'artwork-export')}`);
  }
  const days = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (days.length === 0) {
    fail(`素材导出目录为空：${path.join('.context', 'artwork-export')}`);
  }
  return path.join(root, days[days.length - 1]);
}

function fail(message) {
  console.error(`[mock-assets] ${message}`);
  process.exit(1);
}

function main() {
  const exportDir = findExportDir();
  const manifestPath = path.join(exportDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fail(`素材导出缺少 manifest.json（${path.relative(projectRoot, manifestPath)}）`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    fail('素材清单为空或格式不正确');
  }

  const outputRoot = path.join(projectRoot, '.build', 'desktop', 'mock-assets');
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  const works = [];
  const missing = [];

  for (const selection of SELECTED) {
    const entries = manifest.filter((entry) => String(entry.work).startsWith(selection.match));
    if (entries.length === 0) {
      missing.push(`${selection.match}（清单中没有匹配作品）`);
      continue;
    }
    const assets = [];
    for (const [role, limit] of Object.entries(ROLE_LIMITS)) {
      const picked = entries.filter((entry) => entry.role === role).slice(0, limit);
      if (role === 'poster' || role === 'fanart') {
        if (picked.length === 0) {
          missing.push(`${selection.match} 缺少 ${role}`);
        }
      }
      for (const entry of picked) {
        const source = path.resolve(entry.file);
        if (!fs.existsSync(source)) {
          missing.push(`${selection.match} 的 ${role} 文件缺失`);
          continue;
        }
        const extension = path.extname(source).toLowerCase();
        const fileName = `${role}${role === 'episode_thumb' ? `_${assets.filter((item) => item.role === role).length + 1}` : ''}${extension}`;
        const targetDir = path.join(outputRoot, selection.slug);
        fs.mkdirSync(targetDir, { recursive: true });
        const target = path.join(targetDir, fileName);
        fs.copyFileSync(source, target);
        assets.push({
          role,
          file: `${selection.slug}/${fileName}`,
          width: Number(entry.width) || 0,
          height: Number(entry.height) || 0,
        });
      }
    }
    works.push({
      slug: selection.slug,
      title: String(entries[0].work),
      year: Number(entries[0].year) || 0,
      assets,
    });
  }

  if (works.length === 0) {
    fail(`没有可用的演示素材。缺失明细：\n  - ${missing.join('\n  - ')}`);
  }
  if (missing.length > 0) {
    console.warn(`[mock-assets] 部分素材缺失，已跳过：\n  - ${missing.join('\n  - ')}`);
  }
  const incomplete = works.filter((work) => !work.assets.some((asset) => asset.role === 'poster'));
  if (incomplete.length > 0) {
    fail(`以下作品缺少海报，无法生成演示网格：${incomplete.map((work) => work.title).join('、')}`);
  }

  writeManifestModule(works);
  const fileCount = works.reduce((total, work) => total + work.assets.length, 0);
  console.log(
    `[mock-assets] 已准备 ${works.length} 部作品 / ${fileCount} 个素材文件 → ` +
      `${path.relative(projectRoot, outputRoot).replace(/\\/g, '/')}`,
  );
  console.log('[mock-assets] 已更新 src/renderer/mock/asset-manifest.ts');
}

function writeManifestModule(works) {
  const target = path.join(projectRoot, 'src', 'renderer', 'mock', 'asset-manifest.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = works
    .map((work) => {
      const assets = work.assets
        .map(
          (asset) =>
            `      { role: '${asset.role}', file: '${asset.file}', width: ${asset.width}, height: ${asset.height} },`,
        )
        .join('\n');
      return `  {
    slug: '${work.slug}',
    title: ${JSON.stringify(work.title)},
    year: ${work.year},
    assets: [
${assets}
    ],
  },`;
    })
    .join('\n');

  const content = `/**
 * 由 scripts/desktop/prepare-mock-assets.cjs 生成的演示素材清单。
 *
 * 请勿手改：运行 \`npm run mock:assets\` 重新生成。
 * 这里只登记相对文件名与展示信息，不包含任何原始私有路径。
 */

export type MockAssetRole = 'poster' | 'fanart' | 'clearlogo' | 'episode_thumb';

export interface MockAssetFile {
  readonly role: MockAssetRole;
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export interface MockBaseWork {
  readonly slug: string;
  readonly title: string;
  readonly year: number;
  readonly assets: readonly MockAssetFile[];
}

/** 演示素材在受控应用协议中的挂载前缀。 */
export const MOCK_ASSET_BASE = 'kumiplayer-app://app/__mock/';

export const MOCK_BASE_WORKS: readonly MockBaseWork[] = [
${body}
];
`;
  fs.writeFileSync(target, content, 'utf8');
}

main();
