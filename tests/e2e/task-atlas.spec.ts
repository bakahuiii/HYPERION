import { expect, test } from '@playwright/test'

test('journal keeps one low-friction text entry point and removes direct daily state fields', async ({ page }) => {
  await page.goto('/')
  await page.locator('.nav-list .nav-item').nth(4).click()
  await expect(page.locator('.journal-composer textarea')).toBeVisible()
  await expect(page.locator('.checkin-panel')).toHaveCount(0)
  await expect(page.locator('.checkin-history')).toHaveCount(0)
})

test('task atlas renders, zooms and drags a category without selecting text', async ({ page }) => {
  await page.goto('/')
  const atlas = page.getByRole('region', { name: '按主题组织的任务图' })
  await expect(atlas).toBeVisible()
  await expect(atlas).toHaveScreenshot('task-atlas.png', { animations: 'disabled' })

  const world = page.locator('.task-atlas-world')
  const widthBefore = await world.evaluate((element) => element.getBoundingClientRect().width)
  await page.getByRole('button', { name: '放大任务图' }).click()
  await expect.poll(() => world.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(widthBefore)

  const category = page.getByRole('button', { name: /拖动.+主题，或查看任务/ }).first()
  const before = await category.boundingBox()
  if (!before) throw new Error('任务主题没有可拖动区域')
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 90, before.y + before.height / 2 + 45, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await category.boundingBox())?.x ?? before.x).not.toBe(before.x)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

  const field = page.locator('.task-atlas-field')
  const fieldBounds = await field.boundingBox()
  if (!fieldBounds) throw new Error('任务图画布不可用')
  const cameraOffset = () => world.evaluate((element) => {
    const match = element.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null
  })
  const start = { x: fieldBounds.x + 36, y: fieldBounds.y + fieldBounds.height * .55 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 220, start.y + 42, { steps: 8 })
  await page.mouse.up()
  const released = await cameraOffset()
  await page.waitForTimeout(120)
  const glided = await cameraOffset()
  if (!released || !glided) throw new Error('任务图视角偏移不可读')
  expect(Math.hypot(glided.x - released.x, glided.y - released.y)).toBeGreaterThan(4)
})

test('storage health and map provider controls are visible in options', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '选项', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: '公共地图服务' })).toBeVisible()
  await expect(page.getByLabel(/底图源/)).toHaveValue('osm-de')
  await page.getByRole('button', { name: '展开数据与存储' }).click()
  await expect(page.getByText(/共享状态 schema v1/)).toBeVisible()
  await expect(page.getByText(/个归档段/)).toBeVisible()
})

test('conversation archive filters by name and shows each chat kind', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '情报库', exact: true }).first().click()

  const search = page.getByRole('searchbox', { name: '搜索会话名称' })
  await expect(search).toBeVisible()
  await search.fill('示例同学')
  await expect(page.locator('.conversation-row').first()).toContainText('私聊')
  await expect(page.getByRole('heading', { name: '示例同学' })).toBeVisible()

  await search.fill('不存在的会话')
  await expect(page.getByText('没有名称匹配的对话。')).toBeVisible()
})
