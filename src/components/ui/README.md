# KumiPlayer UI 组合模板

新界面第一版先选模板，再组合控件。形态查 WinUIonWeb，API 查 Fluent UI；沿用 KumiPlayer 的 Windows 桌面风格、主题和既有工作流。

## 模板入口

| 界面类型 | 复用入口 | 组织方式 |
|---|---|---|
| 设置表单 | `SettingsPrimitives.tsx`，落点为 `SettingsPage`、`OngoingUpdateSettingsPanel`、`PlayerTuningPage` | 分组标题、标签与控件、对应操作；只保留必要说明与实际反馈 |
| 设置分类导航 | `src/pages/SettingsPage.tsx` | 沿用已有分类与单面板导航，不另建设置入口 |
| 导入与任务流程 | `src/pages/MediaManagementPage.tsx`、既有 media 组件 | 复用来源、预览、确认、任务状态的现有流程，长任务状态仍由后端提供 |
| 作品与剧集详情 | `src/pages/WorkDetailPage.tsx` | 沿用海报、作品信息、主播放操作与季度剧集结构 |
| 对话框 | 现有业务对话框 + Fluent `Dialog` | 标题、正文、主次操作；焦点进入、Esc 关闭及焦点返回使用 Fluent 机制 |
| 空、加载与错误状态 | `loading-state.tsx`、Fluent `Spinner` / `MessageBar` | 说明当前状态，必要时给出可执行操作；错误不能只用颜色表达 |

历史页面作为工作流参考，不能因复用模板而重新设计整个页面。设置表单的共享组合已实际接入两个界面，其他类型复用原组件，不额外制造平行体系。

## 设置表单组合

`SettingsSection` 提供具名分组与标题层级；`SettingsField` 包装 Fluent `Field`，统一标签、帮助文字与单个控件，可附选择或保存操作；`SettingsFeedback` 包装 Fluent `MessageBar`，错误使用 alert，成功和普通进度使用 status。它们只负责展示，不读取配置、不保存数据。

```tsx
<SettingsSection title="播放器">
  <SettingsField label="模式" description="对新开始播放的视频生效。">
    <Select value={mode} disabled={saving} onChange={onModeChange}>
      {options}
    </Select>
  </SettingsField>
  <SettingsFeedback intent="success">设置已保存</SettingsFeedback>
</SettingsSection>
```

每个 SettingsField 只放一个要关联标签的 Fluent 控件；附加按钮使用 action。开关自带 label，在同一表单栈中使用 Fluent Switch，不再额外拼一份文字。反馈只在业务确实有消息时渲染，不保留空白占位。说明不是每项设置的必填内容；标签和选项已表达清楚时不重复补描述。短枚举优先使用 Dropdown + Option，受控选择同时提供 value 与 selectedOptions。

## 样式与第一版验收

- 共用字体、圆角、间距、背景、边框与状态颜色来自 Fluent 和 `src/styles/foundation.css`。共享设置容器的语义别名在 `settings-primitives.css` 中定义，组件不自行选择新配色。
- 新样式进入既有 Cascade Layers；独立使用 `kp-settings-*` 名称。迁移旧样式时审核完整选择器范围，不能继续在 `index.css` 末尾叠加补丁。
- 历史原生表单样式必须排除 Fluent 内部节点，不能给 `fui-Input__input` / `fui-Select__select` 重新添加边框或背景。Fluent 主次按钮、悬停和禁用颜色由组件管理；带保存操作的旧表单行使用 `settings-config-row--with-action`，明确按钮所在列与窄窗口排列。
- 新页面开工前明确页面模板、可复用组件与实际查看的参考 URL；只有现有模式不足以满足功能时才新增组合。
- 设置与媒体管理采用 24px 页面内边距、16px 分组卡片内边距和统一的 24px 页面标题；窄窗可用 16px 页边距。卡片网格分配剩余宽度，字段和操作分列；不改分类草稿、导入确认与删除预览语义。
- 第一版检查正常、加载、失败、禁用、长文字、窄窗口、键盘导航及浅色/影院/Mica 主题。控件标签与帮助文字要能被辅助技术读取，成功与失败反馈使用对应语义。
- 共享展示组件的改动用组件测试与类型/前端构建验证；有布局改动时用隔离页面检查真实画面。浏览器预览不能代替 Windows 桌面实测。

实际参考：WinUIonWeb 的 `#/combobox`、`#/infobar` 与 `#/toggleswitch`，以及 Fluent Field / MessageBar / Dropdown 文档。完整来源与边界见根目录本地《UI参考设计规范.md》。页面布局与控件选型遵循这些参考，不引入第二套组件库、滚动动画或动态折射材质。
