import { test, expect } from '@playwright/test'
import { PROJECT_URL } from './helpers'

const EXPECTED_SPECS = [
  'CLICKUP_ROOT.md',
  's3-docs/S3_TEST.md',
  's3-docs/subfolder/S3_NESTED.md',
  'notion-docs/NOTION_TEST.md',
  'multi-docs/MULTI_TEST.md',
]

test('all committed specs appear in mdspec.dev dashboard', async ({ page }) => {
  await page.goto(`${PROJECT_URL}/specs`)
  await expect(page.getByRole('main')).toBeVisible()

  for (const spec of EXPECTED_SPECS) {
    const filename = spec.split('/').pop()!
    await expect(
      page.getByText(filename.replace('.md', '')).first()
    ).toBeVisible({ timeout: 10_000 })
  }
})

test('project shows correct spec count', async ({ page }) => {
  await page.goto(`${PROJECT_URL}/specs`)
  // At minimum all test docs + README should be present
  const rows = page.locator('table tbody tr, [data-testid="spec-row"]')
  await expect(rows).toHaveCount(expect.any(Number) as never)
  const count = await rows.count()
  expect(count).toBeGreaterThanOrEqual(EXPECTED_SPECS.length)
})
