/**
 * 由 scripts/desktop/prepare-mock-assets.cjs 生成的演示素材清单。
 *
 * 请勿手改：运行 `npm run mock:assets` 重新生成。
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
  {
    slug: 'w01',
    title: "CLANNAD",
    year: 2007,
    assets: [
      { role: 'poster', file: 'w01/poster.jpg', width: 256, height: 362 },
      { role: 'fanart', file: 'w01/fanart.jpg', width: 512, height: 288 },
      { role: 'clearlogo', file: 'w01/clearlogo.png', width: 256, height: 69 },
      { role: 'episode_thumb', file: 'w01/episode_thumb_1.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w01/episode_thumb_2.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w01/episode_thumb_3.jpg', width: 384, height: 216 },
    ],
  },
  {
    slug: 'w02',
    title: "Dandadan",
    year: 0,
    assets: [
      { role: 'poster', file: 'w02/poster.jpg', width: 256, height: 362 },
      { role: 'fanart', file: 'w02/fanart.jpg', width: 512, height: 288 },
      { role: 'clearlogo', file: 'w02/clearlogo.png', width: 256, height: 186 },
      { role: 'episode_thumb', file: 'w02/episode_thumb_1.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w02/episode_thumb_2.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w02/episode_thumb_3.jpg', width: 384, height: 216 },
    ],
  },
  {
    slug: 'w03',
    title: "Hyouka",
    year: 0,
    assets: [
      { role: 'poster', file: 'w03/poster.jpg', width: 256, height: 376 },
      { role: 'fanart', file: 'w03/fanart.jpg', width: 512, height: 288 },
      { role: 'clearlogo', file: 'w03/clearlogo.png', width: 256, height: 158 },
      { role: 'episode_thumb', file: 'w03/episode_thumb_1.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w03/episode_thumb_2.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w03/episode_thumb_3.jpg', width: 384, height: 216 },
    ],
  },
  {
    slug: 'w04',
    title: "Kono Subarashii Sekai ni Shukufuku wo!",
    year: 0,
    assets: [
      { role: 'poster', file: 'w04/poster.jpg', width: 256, height: 384 },
      { role: 'fanart', file: 'w04/fanart.jpg', width: 512, height: 288 },
      { role: 'clearlogo', file: 'w04/clearlogo.png', width: 256, height: 115 },
      { role: 'episode_thumb', file: 'w04/episode_thumb_1.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w04/episode_thumb_2.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w04/episode_thumb_3.jpg', width: 384, height: 216 },
    ],
  },
  {
    slug: 'w05',
    title: "Majo no Tabitabi",
    year: 0,
    assets: [
      { role: 'poster', file: 'w05/poster.jpg', width: 256, height: 384 },
      { role: 'fanart', file: 'w05/fanart.jpg', width: 511, height: 287 },
      { role: 'clearlogo', file: 'w05/clearlogo.png', width: 255, height: 82 },
      { role: 'episode_thumb', file: 'w05/episode_thumb_1.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w05/episode_thumb_2.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w05/episode_thumb_3.jpg', width: 384, height: 216 },
    ],
  },
  {
    slug: 'w06',
    title: "Shoujo Shuumatsu Ryokou",
    year: 0,
    assets: [
      { role: 'poster', file: 'w06/poster.jpg', width: 256, height: 384 },
      { role: 'fanart', file: 'w06/fanart.jpg', width: 512, height: 288 },
      { role: 'clearlogo', file: 'w06/clearlogo.png', width: 256, height: 81 },
      { role: 'episode_thumb', file: 'w06/episode_thumb_1.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w06/episode_thumb_2.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w06/episode_thumb_3.jpg', width: 384, height: 216 },
    ],
  },
  {
    slug: 'w07',
    title: "86-不存在的战区",
    year: 2021,
    assets: [
      { role: 'poster', file: 'w07/poster.jpg', width: 256, height: 384 },
      { role: 'fanart', file: 'w07/fanart.jpg', width: 512, height: 288 },
      { role: 'episode_thumb', file: 'w07/episode_thumb_1.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w07/episode_thumb_2.jpg', width: 384, height: 216 },
      { role: 'episode_thumb', file: 'w07/episode_thumb_3.jpg', width: 384, height: 216 },
    ],
  },
];
