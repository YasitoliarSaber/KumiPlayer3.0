import { beforeEach, expect, test } from 'vitest'
import { useUiStore } from '../../src/stores/ui'

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({
    page: 'home',
    activeCategory: null,
    selectedWorkId: null,
    manageView: 'overview',
    navigationHistory: [],
    forwardHistory: [],
    canGoBack: false,
    canGoForward: false,
    query: '',
  })
})

test('媒体管理内部页面进入全局前进后退历史', () => {
  useUiStore.getState().goManage()
  expect(useUiStore.getState().manageView).toBe('overview')

  useUiStore.getState().goManageView('import')
  expect(useUiStore.getState()).toMatchObject({ page: 'manage', manageView: 'import', canGoBack: true })

  useUiStore.getState().goBack()
  expect(useUiStore.getState()).toMatchObject({ page: 'manage', manageView: 'overview', canGoForward: true })

  useUiStore.getState().goForward()
  expect(useUiStore.getState()).toMatchObject({ page: 'manage', manageView: 'import' })
})

test('从侧栏重新进入媒体管理时回到来源卡概览', () => {
  useUiStore.setState({ page: 'manage', manageView: 'maintenance' })
  useUiStore.getState().goHome()
  useUiStore.getState().goManage()

  expect(useUiStore.getState()).toMatchObject({ page: 'manage', manageView: 'overview' })
})

test('指定设置分类与连接进入历史，前进后退保留目的地', () => {
  useUiStore.getState().goManageView('import')
  useUiStore.getState().goSettingsSection('openlist', 'connection-a')
  useUiStore.getState().goSettingsSection('openlist', 'connection-b')
  expect(useUiStore.getState()).toMatchObject({ page: 'settings', settingsConnectionId: 'connection-b' })
  useUiStore.getState().goBack()
  expect(useUiStore.getState()).toMatchObject({ page: 'settings', settingsSection: 'openlist', settingsConnectionId: 'connection-a' })
  useUiStore.getState().goBack()
  expect(useUiStore.getState()).toMatchObject({ page: 'manage', manageView: 'import' })
  useUiStore.getState().goForward()
  expect(useUiStore.getState()).toMatchObject({ page: 'settings', settingsSection: 'openlist', settingsConnectionId: 'connection-a' })
})
