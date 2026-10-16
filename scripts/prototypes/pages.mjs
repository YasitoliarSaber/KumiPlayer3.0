/** 当前新前端的原型目录；不会移动或读取旧前端。 */
export const pages = [
  ['home', '01-首页', '/', '浏览', 'src/renderer/features/home/HomePage.tsx'],
  ['library', '02-媒体库-番剧', '/library/anime_series', '浏览', 'src/renderer/features/library/PosterWallPage.tsx'],
  ['seasonal', '03-媒体库-新番', '/library/seasonal', '浏览'],
  ['movies', '04-媒体库-动画电影', '/library/anime_movie', '浏览'],
  ['live-series', '05-媒体库-剧集空状态', '/library/live_series', '浏览'],
  ['live-movies', '06-媒体库-电影空状态', '/library/live_movie', '浏览'],
  ['favorites', '07-我的收藏', '/favorites', '浏览'],
  ['recent', '08-最近观看', '/recent', '浏览', 'src/renderer/features/recent/RecentPage.tsx'],
  ['search', '09-搜索结果', '/search?q=CLANNAD', '浏览'],
  ['detail', '10-作品详情-CLANNAD', '/work/w01-v01', '详情', 'src/renderer/features/work/WorkDetailPage.tsx'],
  ['detail-w02', '11-作品详情-Dandadan', '/work/w02-v01', '详情'],
  ['detail-w03', '12-作品详情-Hyouka', '/work/w03-v01', '详情'],
  ['detail-w04', '13-作品详情-美好世界', '/work/w04-v01', '详情'],
  ['detail-w05', '14-作品详情-魔女之旅', '/work/w05-v01', '详情'],
  ['detail-w06', '15-作品详情-少女终末旅行', '/work/w06-v01', '详情'],
  ['detail-w07', '16-作品详情-86', '/work/w07-v01', '详情'],
  ['manage', '17-媒体管理', '/manage', '管理', 'src/renderer/features/manage/MediaManagementPage.tsx'],
  ['import-0', '18-导入-选择来源', '/manage?view=import', '管理'],
  ['import-1', '19-导入-扫描来源', '/manage?view=import&prototypeStep=1', '管理'],
  ['import-2', '20-导入-审核识别结果', '/manage?view=import&prototypeStep=2', '管理'],
  ['import-3', '21-导入-执行与发布', '/manage?view=import&prototypeStep=3', '管理'],
  ['maintenance', '22-媒体库维护', '/manage?view=maintenance', '管理'],
  ['tasks', '23-任务中心-空状态', '/tasks', '管理', 'src/renderer/features/tasks/TaskCenter.tsx'],
  ['tasks-populated', '24-任务中心-任务示例', '/tasks?prototypeTasks=1', '管理', 'src/renderer/features/tasks/TaskCenter.tsx'],
  ['settings-application', '25-设置-应用', '/settings?section=application', '设置', 'src/renderer/features/settings/SettingsPage.tsx'],
  ['settings-appearance', '26-设置-外观', '/settings?section=appearance', '设置'],
  ['settings-sources', '27-设置-媒体来源', '/settings?section=sources', '设置'],
  ['settings-openlist', '28-设置-WebDAV目录', '/settings?section=openlist', '设置'],
  ['settings-scrape', '29-设置-元数据与图片', '/settings?section=scrape', '设置'],
  ['settings-player', '30-设置-播放', '/settings?section=player', '设置'],
  ['settings-bangumi', '31-设置-账户与同步', '/settings?section=bangumi', '设置'],
  ['setup', '32-首次设置引导', '/settings?prototypeSetup=1', '弹层'],
  ['playback', '33-演示播放浮层', '/work/w01-v01?prototypePlayback=1', '弹层', 'src/renderer/features/playback/PlaybackOverlay.tsx'],
  ['controls', '34-共享组件基准', '/dev/controls', '组件', 'src/renderer/shared/ui'],
].map(([key, title, route, group, source]) => ({ key, title, file: `${title}.html`, route, group, source: source ?? '' }));

export const settingSections = [
  ['application', '应用'], ['appearance', '外观'], ['sources', '媒体来源'],
  ['openlist', 'WebDAV 目录'], ['scrape', '元数据与图片'], ['player', '播放'], ['bangumi', '账户与同步'],
];

export const templateKeys = [
  'menu-sort', 'menu-source', 'menu-version', 'menu-work', 'menu-select',
  'dialog-rename', 'dialog-delete', 'dialog-maintenance', 'dialog-reset', 'dialog-search',
  'setup-0', 'setup-1', 'setup-2', 'setup-3', 'playback', 'drawer', 'metadata-candidates', 'bangumi-candidates',
];
