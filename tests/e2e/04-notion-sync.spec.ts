import { test, expect } from '@playwright/test'
import { pollUntil } from './helpers'

const NOTION_API = 'https://api.notion.com/v1'
const HEADERS = {
  Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
}

async function searchNotion(query: string): Promise<{ id: string; title: string }[]> {
  const res = await fetch(`${NOTION_API}/search`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, filter: { value: 'page', property: 'object' } }),
  })
  const data = await res.json() as {
    results?: Array<{
      id: string
      properties?: { title?: { title?: Array<{ plain_text?: string }> } }
    }>
  }
  return (data.results ?? []).map(r => ({
    id: r.id,
    title: r.properties?.title?.title?.[0]?.plain_text ?? '',
  }))
}

test('NOTION_TEST.md creates a Notion page', async () => {
  const pages = await pollUntil(async () => {
    const results = await searchNotion('Notion Test Document')
    return results.length > 0 ? results : null
  })
  expect(pages.some(p => p.title.toLowerCase().includes('notion test'))).toBe(true)
})
