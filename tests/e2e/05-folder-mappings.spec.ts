import { test, expect } from '@playwright/test'
import { PROJECT_URL } from './helpers'

test('map page shows all folder mappings', async ({ page }) => {
  await page.goto(`${PROJECT_URL}/map`)
  await expect(page.getByRole('main')).toBeVisible()

  // All four integrations should appear in the mapping UI
  await expect(page.getByText('clickup', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('s3', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('notion', { exact: false }).first()).toBeVisible()
})

test('integrations page shows all three as connected', async ({ page }) => {
  await page.goto('/integrations')

  for (const integration of ['ClickUp', 'S3', 'Notion']) {
    const card = page.locator(`text=${integration}`).locator('..')
    await expect(card.getByText(/connected/i)).toBeVisible({ timeout: 10_000 })
  }
})
