import { test, expect } from '@playwright/test'
import { CLICKUP_LIST_ID, CLICKUP_API, pollUntil } from './helpers'

const HEADERS = {
  Authorization: process.env.CLICKUP_API_TOKEN!,
  'Content-Type': 'application/json',
}

async function getTasksInList(): Promise<{ name: string; id: string }[]> {
  const res = await fetch(`${CLICKUP_API}/list/${CLICKUP_LIST_ID}/task?include_closed=true`, {
    headers: HEADERS,
  })
  const data = await res.json() as { tasks?: { name: string; id: string }[] }
  return data.tasks ?? []
}

test('CLICKUP_ROOT.md creates a task in the configured list', async () => {
  const tasks = await pollUntil(async () => {
    const t = await getTasksInList()
    return t.some(task => task.name.toLowerCase().includes('clickup root')) ? t : null
  })
  expect(tasks.some(t => t.name.toLowerCase().includes('clickup root'))).toBe(true)
})

test('multi-docs/MULTI_TEST.md creates a task in the configured list', async () => {
  const tasks = await pollUntil(async () => {
    const t = await getTasksInList()
    return t.some(task => task.name.toLowerCase().includes('multi-integration')) ? t : null
  })
  expect(tasks.some(t => t.name.toLowerCase().includes('multi-integration'))).toBe(true)
})

test('all expected ClickUp tasks exist', async () => {
  const expectedTitles = ['ClickUp Root Task', 'Multi-Integration Test Document']
  const tasks = await getTasksInList()
  const taskNames = tasks.map(t => t.name.toLowerCase())
  for (const title of expectedTitles) {
    expect(taskNames.some(n => n.includes(title.toLowerCase()))).toBeTruthy()
  }
})
