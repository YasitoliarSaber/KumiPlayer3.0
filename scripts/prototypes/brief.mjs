export function designBrief(manifest) {
  return `# 给 OpenDesign Cloud 的精修提示词

请在我提供的 KumiPlayer HTML 原型基础上逐页精修。它是现有新前端的真实 DOM、已编译 CSS、Lucide SVG 和演示素材导出，基线提交为 ${manifest.commit}。请先查看 index.html、manifest.json 和对应页面，再修改；不要把它重新生成成一个泛用仪表盘。

## 产品与本轮目标

KumiPlayer 是 Windows 本地与网盘媒体库播放器。当前先开发浏览器版，Electron 以后承担桌面封装；这一轮只处理 HTML 原型中的视觉与可操作状态，不接后端、不实现 mpv、不新增产品业务。当前界面是精修起点，保留可辨识的信息架构和业务入口。可以改善布局、字阶、间距、密度、层级、海报裁切、表单、弹层、空状态和响应式；不要擅自删掉功能。先从公共框架与共享组件提出一套一致方案，再应用到页面，避免逐页生成互相冲突的风格。

## 正式项目实际使用的技术

- React 19 + TypeScript 6 + Vite 8，React Router 8 的 HashRouter。
- TanStack Query 5 管服务端缓存，Zustand 5 管界面与演示状态，TanStack Virtual 3 管正式海报墙虚拟化。
- shadcn/ui 是项目内可维护的源码组件，配置为 New York、neutral、tsx、CSS variables；无 React Server Components。当前原语来自 radix-ui，不能假设是 Base UI。
- Tailwind CSS 4、@tailwindcss/vite、tw-animate-css；cva、clsx、tailwind-merge 组织组件变体与类名。
- Lucide React 图标；HTML 内对应可编辑 SVG，保持同一套线性图标语汇。
- 页面布局及媒体专用组件用 CSS Modules。新前端没有 Mantine，不引入 Fluent UI、MUI、Ant Design、Bootstrap 或第二套组件系统。

## 共享组件及维护责任

正式目录为 src/renderer/shared/ui/。Button、Input、Select、Dialog、DropdownMenu、Tabs、Switch、Label、Badge、Card、Separator、Skeleton 均由该目录统一维护。精修时为同类控件定义一致的默认、悬停、焦点、禁用、选中、加载和错误状态。按钮尺寸、圆角、边框、字体、图标尺寸与菜单密度不要在不同页面各做一套。

Artwork 负责图片和缺图回退；PosterCard 负责海报/背景、评分、收藏、进度、标题与副标题；PosterGrid 负责正式应用按行虚拟化。Surface 承载加载、空、错误、状态和分区标题。AppShell 统一顶栏、侧栏、窄窗抽屉和主滚动区。作品 hero、季集、版本和来源卡属于媒体专用组件，基于共享基础组件组合，并非某个现成组件库页面。

设置里的 demo-form 是 Select/NumberInput/Tooltip 的薄适配，不是 Mantine。不要按 Mantine 默认样式设计。页面结构、组件职责及对应源文件记录在 manifest.json。

## CSS 与主题纪律

正式项目单入口是 src/renderer/styles/tailwind.css，global.css 通过 layer(base) 导入。设计应优先修改语义变量和共享组件，不要添加无边界的全局 button/input/h1/* 选择器，也不要用大量 !important 或新一层全局覆盖修补样式。布局细节放页面/组件作用域，避免污染其他界面。

复用 --background、--foreground、--card、--popover、--primary、--secondary、--muted、--accent、--destructive、--border、--input、--ring 及其 foreground 配对变量；其他既有别名先核查其定义。统一间距、圆角、字阶、控件高度、图片比例与焦点规范。内部主题标识 fluent/cinema/mica 是当前应用的浅色/深色/纯白 token 名称，不表示使用 Fluent 组件。data-theme 和 data-motion 的行为应保留。配色可以提出精修建议，但不要为了效果重写整个技术路线。

## HTML 编辑方式

每个编号 HTML 是可单独打开的完整页面，内嵌样式、交互脚本和本页需要的图片。可以单独上传某一页逐项修改。HTML 保留现有 CSS Module 类名及 shadcn 的实用类，均是有意义的实际输出，不要批量改名。

请保留 prototype-data / prototype-assets JSON、template-*、data-proto-*、data-prototype-*、data-work-*、data-route、ARIA 语义和已有交互绑定。图片为 JSON 中去重的 data URI，通过小脚本恢复；不要删图片注册表、替换成联网占位图或把整页转成图片。需要替换布局时同步维护这些绑定。可增加一个清楚标注的、范围受控的样式区，不要复制多套旧 CSS。

原型没有 React 运行时，不会把你修改的 DOM 重绘回旧样式。列表为便于编辑而展开的普通网格；回写正式项目时恢复并保留原有虚拟化。240 个演示条目复用 7 部作品的素材，详情以 7 个代表页面承载；这不是作品事实或真实媒体数据。

## 每页必须保留的操作

公共导航、来源菜单、搜索/Ctrl+K、排序、打开详情、收藏、季集与版本、资料候选、模拟播放、媒体来源卡、导入各步骤、审核阻断选择、任务状态、七类设置、主题/开关/下拉框、首次引导、维护/移除确认。相关弹窗和菜单的模板已经放进 HTML。交互只模拟原型，不应宣称真实连接、真实删除或真实播放成功。

## 精修顺序与交付

先精修公共顶栏/侧栏/主内容框架与共享控件，再首页、媒体库/搜索/收藏、详情与季集、媒体管理/导入/任务、设置与引导。每次集中处理一个范围并保持所有页面的公共规则一致。检查 1440×900、1280×800、768×800，长标题、空列表、多季、窄弹层和滚动底部不能遮挡。

交付修改后的可运行 HTML，保留相同文件名和目录导航；附简短变更说明，列出共享 token/组件、页面布局、交互变化和需回写的源文件。不要只交截图或口头描述，不要用截图代替 DOM，不要接入新框架。后续开发者会依据 HTML 差异回写现有 React + shadcn/ui + Tailwind/CSS Modules 工程。
`;
}

export function usage(manifest) {
  return `# KumiPlayer 当前界面 HTML 原型

打开 index.html 查看目录。共有 ${manifest.pages.length} 个页面/状态入口，来自当前浏览器演示前端，基线 ${manifest.commit}。新旧前端目录均未搬动；正式源码没有被原型替换。

每个编号 HTML 内嵌 CSS、SVG、所需演示图片和原型脚本，可在浏览器双击打开；无需 Node、Python、Electron 或网络。必须允许页面 JavaScript 才能恢复图片与交互。若设计工具只解析静态源码而不执行脚本，请让它保留并读取 prototype-assets 图片注册表及 template-*，不能把缺图误认为真实空白。

建议按页上传 HTML，并一起提供「OpenDesign精修提示词.md」。先公共框架和共享控件，再业务页面。修改后保留文件名与交互标识，交回 HTML 和变更说明；正式项目只根据确认后的差异进行组件级修改。

原型覆盖：首页；五种媒体分类（含两个真实空分类）；收藏、最近观看、搜索；7 种代表作品详情与额外季；媒体管理、导入四态、维护；任务空态与有任务态；设置七类；首次引导四步；模拟播放；共享组件基准。菜单、快捷搜索、编辑/移除/维护/重置弹窗、候选面板与窄窗抽屉也有模板。

## 原型和正式实现的区别

- DOM/CSS/图标取自实际应用，没有新增设计。原型交互是离线模拟，无业务 API、文件操作、账号登录、后端、mpv 或桌面桥接。
- 海报墙为可编辑性展开为普通网格，正式应用继续使用 TanStack Virtual；图片懒加载保留。搜索、来源、排序在当前页面过滤，不改真实库。
- 演示库有 240 个条目、7 部基础作品，点击同一作品的变体均进入其代表详情。演示年份/评分/元数据只是既有夹具，不是研究事实。
- 各 HTML 是独立设计快照；设置、收藏、标题、审核选择只在当前页面内改变，切页不共享状态。取消/确认均不写入真实配置。删除/重置只展示演示反馈。
- 首次引导与额外季使用捕获的模板切换。版本菜单、资料候选和播放是代表样例，不覆盖所有媒体变体。任务时刻保持采集时的演示值，不是实时后台任务。
- 只读技术/开发调试面板不纳入产品原型；34 号页只保留共享组件夹具。
- 可直接修改初始 DOM。交互切换到另一模板后，该状态由 template-* 决定，因此精修弹层、季集、候选和引导时也应修改其模板。

manifest.json 记录页面与源码映射、实装依赖版本、采集视口、文件摘要和覆盖范围。重新导出工具：scripts/prototypes/export-current.mjs；需要事先更新的浏览器 DOM 快照和对应浏览器构建，不会自动抓取用户真实实例。
`;
}
