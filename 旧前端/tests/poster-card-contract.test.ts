import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const card = readFileSync(new URL('../src/components/library/PosterCard.tsx', import.meta.url), 'utf8')

test('海报卡始终渲染标题占位：未解码或失败时不出现空白海报位（白卡）', () => {
  assert.match(card, /poster-placeholder-title/, '必须常驻渲染标题占位')
  assert.doesNotMatch(
    card,
    /\{imageUrl \? \(/,
    '不应再用 imageUrl 三元分支把占位与图片互斥',
  )
})

test('资源加载失败后不得回退原图重复请求', () => {
  assert.doesNotMatch(
    card,
    /setUseOriginalImage\(true\)/,
    '必须删除失败后切换到原图的重复请求',
  )
})

test('横图和竖图都按展示尺寸选择已发布的缩略图', () => {
  assert.doesNotMatch(
    card,
    /thumbnailWidth > 0 && !isHorizontal/,
    '横图此前跳过缩略图，等于把大背景图塞进小卡',
  )
  assert.match(card, /preferredArtworkPath\(work, artworkKind, thumbnailWidth \|\| undefined\)/, '应从已发布资源中按尺寸选择')
  assert.doesNotMatch(card, /cacheOnly:|\/thumbnail\?|prepareThumbnail/, '展示不触发临时缩图或准备请求')
})
