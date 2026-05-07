import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const S3_BUCKET = 'xadlabs-test-1-637423622157-eu-central-1-an'
const S3_REGION = 'eu-central-1'

// ClickUp IDs (from .mdspecmap)
const CLICKUP_LIST_ID   = '901817533430'
const CLICKUP_FOLDER_ID = '901813560821'   // space_id: id:folder:<this>

const POLL_TIMEOUT_MS  = 180_000  // 3 min — worker processes async after publish
const POLL_INTERVAL_MS = 6_000

// ---------------------------------------------------------------------------
// AWS client
// ---------------------------------------------------------------------------

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
})

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function pollUntil(_name: string, fn: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await fn()) return
    process.stdout.write('.')
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`timed out after ${POLL_TIMEOUT_MS / 1000}s`)
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

async function s3KeyExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// ClickUp helpers
// ---------------------------------------------------------------------------

interface ClickUpTask {
  name: string
  list: { id: string }
  folder: { id: string }
}

async function getTasksInList(): Promise<ClickUpTask[]> {
  const res = await fetch(
    `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?include_closed=true`,
    { headers: { Authorization: process.env.CLICKUP_API_TOKEN! } }
  )
  if (!res.ok) throw new Error(`ClickUp API ${res.status}: ${await res.text()}`)
  const data = await res.json() as { tasks?: ClickUpTask[] }
  return data.tasks ?? []
}

function findTask(tasks: ClickUpTask[], titleSubstring: string): ClickUpTask | undefined {
  return tasks.find(t => t.name.toLowerCase().includes(titleSubstring.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

interface NotionPage {
  id: string
  url: string
  title: string
  parentPageId: string | null
}

async function searchNotionPages(title: string): Promise<NotionPage[]> {
  const res = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: title, filter: { value: 'page', property: 'object' } }),
  })
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`)
  const data = await res.json() as {
    results?: Array<{
      id: string
      url: string
      parent?: { type?: string; page_id?: string }
      properties?: { title?: { title?: Array<{ plain_text?: string }> } }
    }>
  }
  return (data.results ?? []).map(p => ({
    id: p.id,
    url: p.url,
    title: p.properties?.title?.title?.map(t => t.plain_text).join('') ?? '',
    parentPageId: p.parent?.type === 'page_id' ? (p.parent.page_id ?? null) : null,
  }))
}

async function findNotionPage(title: string): Promise<NotionPage | null> {
  const pages = await searchNotionPages(title)
  return pages.find(p => p.title.toLowerCase() === title.toLowerCase()) ?? null
}

// All synced Notion pages should share the same root_page_id (the integration parent).
// We collect it from the first verified page and assert all others match.
let notionRootPageId: string | null = null

async function notionPageExistsUnderSameParent(title: string): Promise<boolean> {
  const page = await findNotionPage(title)
  if (!page) return false

  if (notionRootPageId === null) {
    // First page found — its parent becomes the expected root
    notionRootPageId = page.parentPageId
    console.log(`\n  [notion root_page_id locked: ${notionRootPageId ?? 'workspace'}]`)
  } else if (page.parentPageId !== notionRootPageId) {
    throw new Error(
      `parent mismatch: "${title}" is under ${page.parentPageId}, expected ${notionRootPageId}`
    )
  }

  console.log(`\n  → ${page.title}  ${page.url}`)
  return true
}

// ---------------------------------------------------------------------------
// Checks — positive (must exist) and negative (must NOT exist)
// ---------------------------------------------------------------------------

type Check = {
  name: string
  expect: 'exists' | 'absent'
  fn: () => Promise<boolean>
}

const checks: Check[] = [

  // ── S3: flat mode (s3-flat/) ─────────────────────────────────────────────
  // flat strips subfolder path, only filename + parent_dir prefix
  {
    name: 'S3 flat  | root file     → s3-flat/FLAT_A.md             [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-flat/FLAT_A.md'),
  },
  {
    name: 'S3 flat  | nested strips → s3-flat/FLAT_B.md (not nested) [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-flat/FLAT_B.md'),
  },
  {
    name: 'S3 flat  | nested path   → s3-flat/nested/FLAT_B.md       [absent]',
    expect: 'absent',
    fn: () => s3KeyExists('s3-flat/nested/FLAT_B.md'),
  },

  // ── S3: hierarchy mode (s3-docs/) ────────────────────────────────────────
  // maintain_hierarchy preserves path relative to mapping folder
  {
    name: 'S3 hier  | root file     → s3-docs/ROOT_DOC.md            [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-docs/ROOT_DOC.md'),
  },
  {
    name: 'S3 hier  | nested file   → s3-docs/nested/NESTED_DOC.md   [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-docs/nested/NESTED_DOC.md'),
  },

  // ── S3: selective sub_folders glob (s3-selective/) ───────────────────────
  // sub_folders: ['included/**'] — root always included, excluded/ should be skipped
  {
    name: 'S3 glob  | root always   → s3-selective/ROOT_FILE.md      [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-selective/ROOT_FILE.md'),
  },
  {
    name: 'S3 glob  | matched glob  → s3-selective/included/INCLUDED.md [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-selective/included/INCLUDED.md'),
  },
  {
    name: 'S3 glob  | no-match skip → s3-selective/excluded/EXCLUDED.md [absent]',
    expect: 'absent',
    fn: () => s3KeyExists('s3-selective/excluded/EXCLUDED.md'),
  },

  // ── ClickUp: root mapping ─────────────────────────────────────────────────
  // Verifies task exists in list AND is under the correct folder
  {
    name: 'ClickUp  | root task     → "ClickUp Root Task" in list+folder [exists]',
    expect: 'exists',
    fn: async () => {
      const tasks = await getTasksInList()
      const task = findTask(tasks, 'ClickUp Root Task')
      if (!task) return false
      if (task.list.id !== CLICKUP_LIST_ID)
        throw new Error(`wrong list: got ${task.list.id}, want ${CLICKUP_LIST_ID}`)
      if (task.folder.id !== CLICKUP_FOLDER_ID)
        throw new Error(`wrong folder: got ${task.folder.id}, want ${CLICKUP_FOLDER_ID}`)
      return true
    },
  },

  // ── ClickUp: sub_folders: false (clickup-root-only/) ─────────────────────
  // SHALLOW.md at root should sync, DEEP.md in subdirectory should NOT
  {
    name: 'ClickUp  | sub_folders:false root   → "Shallow Task"      [exists]',
    expect: 'exists',
    fn: async () => {
      const tasks = await getTasksInList()
      return !!findTask(tasks, 'Shallow Task')
    },
  },
  {
    name: 'ClickUp  | sub_folders:false nested → "Deep Task"         [absent]',
    expect: 'absent',
    fn: async () => {
      const tasks = await getTasksInList()
      return !!findTask(tasks, 'Deep Task Should Not Sync')
    },
  },

  // ── Notion ────────────────────────────────────────────────────────────────
  // All three pages must exist and land under the same root_page_id
  {
    name: 'Notion   | first page    → "Notion Test Document"         [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderSameParent('Notion Test Document'),
  },
  {
    name: 'Notion   | second page   → "Notion Second Document"       [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderSameParent('Notion Second Document'),
  },
  {
    name: 'Notion   | nested page   → "Notion Nested Document"       [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderSameParent('Notion Nested Document'),
  },
]

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\nmdspec verify — ${checks.length} checks\n`)

  const results: { name: string; ok: boolean; err?: string }[] = []
  const positives = checks.filter(c => c.expect === 'exists')
  const negatives = checks.filter(c => c.expect === 'absent')

  // Run positive checks with polling — wait until each artifact appears
  for (const check of positives) {
    process.stdout.write(`  ${check.name} `)
    try {
      await pollUntil(check.name, check.fn)
      process.stdout.write(' ✅\n')
      results.push({ name: check.name, ok: true })
    } catch (err) {
      process.stdout.write(' ❌\n')
      results.push({ name: check.name, ok: false, err: (err as Error).message })
    }
  }

  // Run negative checks once — positive checks passing means the worker is done,
  // so anything absent now is genuinely absent
  console.log('\n  [negative checks — worker should be done by now]')
  for (const check of negatives) {
    process.stdout.write(`  ${check.name} `)
    try {
      const exists = await check.fn()
      if (exists) {
        process.stdout.write(' ❌  (found — should be absent)\n')
        results.push({ name: check.name, ok: false, err: 'artifact exists but should not' })
      } else {
        process.stdout.write(' ✅\n')
        results.push({ name: check.name, ok: true })
      }
    } catch (err) {
      process.stdout.write(' ❌\n')
      results.push({ name: check.name, ok: false, err: (err as Error).message })
    }
  }

  // Summary
  console.log('\n─────────────────────────────────────────')
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}`)
    if (r.err) console.log(`   └─ ${r.err}`)
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exit(1)
}

run().catch(err => { console.error(err); process.exit(1) })
