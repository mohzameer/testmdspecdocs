import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.join(__dirname, '.auth/user.json')

setup('authenticate', async ({ page }) => {
  await page.goto('/login')

  await page.getByLabel(/email/i).fill(process.env.TEST_EMAIL!)
  await page.getByLabel(/password/i).fill(process.env.TEST_PASSWORD!)
  await page.getByRole('button', { name: /sign in|log in/i }).click()

  await expect(page).toHaveURL(/dashboard|projects/, { timeout: 15_000 })

  await page.context().storageState({ path: authFile })
})
