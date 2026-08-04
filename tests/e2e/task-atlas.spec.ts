import { expect, test } from '@playwright/test'

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
