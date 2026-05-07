export const PROJECT_ID = '7d656b4d-9e66-4fff-a807-86d4f0f96a0d'
export const PROJECT_URL = `/projects/${PROJECT_ID}`

export const S3_BUCKET = 'xadlabs-test-1-637423622157-eu-central-1-an'
export const S3_REGION = 'eu-central-1'

export const CLICKUP_LIST_ID = '901817533430'
export const CLICKUP_API = 'https://api.clickup.com/api/v2'

export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  { timeoutMs = 30_000, intervalMs = 3_000 } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await fn()
    if (result !== null) return result
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
}
