import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const navigation = readFileSync(new URL('../src/styles/settings-navigation.css', import.meta.url), 'utf8')
const index = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const page = readFileSync(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')

test('设置导航由责任样式维护，不再依赖末尾第二套归一化覆盖', () => {
  assert.doesNotMatch(index, /设置页版式归一化（用户反馈"文字重叠"）/)
  assert.match(navigation, /\.settings-focused[\s\S]{0,240}max-width:\s*1280px/)
  assert.match(navigation, /\.settings-focused[\s\S]{0,240}padding:\s*24px/)
  assert.doesNotMatch(navigation, /\.settings-focused \.fui-Button\s*\{[^}]*font-size/)
})

test('分类导航保持常驻，隐藏的面板不占布局空间', () => {
  assert.match(navigation, /\.settings-focused \.settings-outline-popover-wrap\s*\{[^}]*position:\s*sticky/)
  assert.match(navigation, /\.settings-focused \.settings-outline-popover-wrap\s*\{[^}]*top:\s*24px/)
  assert.match(navigation, /\.settings-anchor-section\[hidden\]\s*\{[^}]*display:\s*none/)
  assert.match(page, /from '\.\.\/components\/ui\/SettingsPrimitives'/)
  assert.doesNotMatch(page, /function SettingsSection\(/)
})
