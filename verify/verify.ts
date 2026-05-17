import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// Load ../.env when running locally
const envPath = resolve(import.meta.dirname, '../.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key?.trim() && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim()
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const S3_BUCKET = 'xadlabs-test-1-637423622157-eu-central-1-an'
const S3_REGION = 'eu-central-1'
const CLICKUP_LIST_ID = '901803133613'
const CLICKUP_WORKSPACE_ID = '9018494270'
// NOTION_ROOT_DATABASE_ID removed — notion-docs now uses page mode
const NOTION_BACKEND_PAGE_ID  = 'cc69bd0f-98d7-4d6e-8701-72d92a920cf5'
const CONFLUENCE_SPACE_KEY    = process.env.CONFLUENCE_SPACE_KEY!
const CONFLUENCE_PARENT_PAGE_ID = process.env.CONFLUENCE_PARENT_PAGE_ID ?? null

const POLL_TIMEOUT_MS  = 90_000
const POLL_INTERVAL_MS = 6_000
const DEBUG = !!process.env.DEBUG
const NO_POLL = !!process.env.NO_POLL

function dbg(...args: unknown[]) {
  if (DEBUG) console.log('  [dbg]', ...args)
}

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

async function pollUntil(name: string, fn: () => Promise<boolean>): Promise<void> {
  if (NO_POLL) {
    dbg(`no-poll — ${name}`)
    if (!await fn()) throw new Error('not found')
    return
  }
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let attempt = 0
  let lastErr: Error | null = null
  while (Date.now() < deadline) {
    attempt++
    dbg(`poll #${attempt} — ${name}`)
    try {
      if (await fn()) return
      lastErr = null
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      // "wrong parent" is a hard failure — don't retry
      if (msg.startsWith('wrong parent')) throw err
      // network/abort errors — log and retry
      dbg(`poll error (will retry): ${msg}`)
      lastErr = err as Error
    }
    if (!DEBUG) process.stdout.write('.')
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  if (lastErr) throw lastErr
  throw new Error(`timed out after ${POLL_TIMEOUT_MS / 1000}s (${attempt} attempts)`)
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

async function s3KeyExists(key: string): Promise<boolean> {
  dbg(`S3 HeadObject → s3://${S3_BUCKET}/${key}`)
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    dbg(`S3 → found`)
    return true
  } catch (err) {
    dbg(`S3 → not found (${(err as { name?: string }).name ?? 'unknown'})`)
    return false
  }
}

async function s3ObjectContains(key: string, marker: string): Promise<boolean> {
  dbg(`S3 GetObject → s3://${S3_BUCKET}/${key}`)
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    const body = await res.Body?.transformToString() ?? ''
    dbg(`S3 content length=${body.length} contains="${marker}": ${body.includes(marker)}`)
    return body.includes(marker)
  } catch (err) {
    dbg(`S3 GetObject failed (${(err as { name?: string }).name ?? 'unknown'})`)
    return false
  }
}

// ---------------------------------------------------------------------------
// ClickUp helpers
// ---------------------------------------------------------------------------

interface ClickUpTask {
  name: string
  description?: string
  list: { id: string }
  folder: { id: string }
}

async function getTasksInList(): Promise<ClickUpTask[]> {
  const url = `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?include_closed=true&include_markdown_description=true`
  dbg(`ClickUp GET ${url}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      headers: { Authorization: process.env.CLICKUP_API_TOKEN! },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`ClickUp API ${res.status}: ${await res.text()}`)
    const data = await res.json() as { tasks?: ClickUpTask[] }
    const tasks = data.tasks ?? []
    dbg(`ClickUp → ${tasks.length} tasks:`, tasks.map(t => `"${t.name}" list=${t.list?.id} folder=${t.folder?.id}`))
    console.log(`\n  [ClickUp list ${CLICKUP_LIST_ID}: ${tasks.length} task(s)${tasks.length ? ' — ' + tasks.map(t => `"${t.name}"`).join(', ') : ''}]`)
    return tasks
  } finally {
    clearTimeout(timer)
  }
}

function findTask(tasks: ClickUpTask[], titleSubstring: string): ClickUpTask | undefined {
  const match = tasks.find(t => t.name.toLowerCase().includes(titleSubstring.toLowerCase()))
  dbg(`findTask("${titleSubstring}") →`, match ? `found: "${match.name}"` : 'not found')
  return match
}

function taskContains(tasks: ClickUpTask[], titleSubstring: string, marker: string): boolean {
  const task = findTask(tasks, titleSubstring)
  if (!task) return false
  const desc = task.description ?? ''
  dbg(`taskContains("${titleSubstring}", "${marker}") desc length=${desc.length} result=${desc.includes(marker)}`)
  return desc.includes(marker)
}

async function findClickUpDoc(titleSubstring: string): Promise<{ id: string; name: string } | null> {
  const url = `https://api.clickup.com/api/v3/workspaces/${CLICKUP_WORKSPACE_ID}/docs?search=${encodeURIComponent(titleSubstring)}`
  dbg(`ClickUp Docs GET ${url}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      headers: { Authorization: process.env.CLICKUP_API_TOKEN! },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`ClickUp Docs API ${res.status}: ${await res.text()}`)
    const data = await res.json() as { data?: Array<{ id: string; name: string }> }
    const docs = data.data ?? []
    const match = docs.find(d => d.name.toLowerCase().includes(titleSubstring.toLowerCase()))
    dbg(`findClickUpDoc("${titleSubstring}") →`, match ? `found id=${match.id}` : 'not found')
    if (match) console.log(`\n  → https://app.clickup.com/${CLICKUP_WORKSPACE_ID}/docs/${match.id}  [doc ✓]`)
    return match ?? null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

interface NotionPage {
  id: string
  url: string
  title: string
  parentId: string | null
  parentType: string | null
}

async function searchNotionPages(query: string): Promise<NotionPage[]> {
  dbg(`Notion search → query="${query}"`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, filter: { value: 'page', property: 'object' } }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`)
    const data = await res.json() as {
      results?: Array<{
        id: string
        url: string
        parent?: { type?: string; page_id?: string; database_id?: string }
        properties?: { title?: { title?: Array<{ plain_text?: string }> } }
      }>
    }
    const pages = (data.results ?? []).map(p => ({
      id: p.id,
      url: p.url,
      title: p.properties?.title?.title?.map(t => t.plain_text).join('') ?? '',
      parentId: p.parent?.type === 'page_id'
        ? p.parent.page_id ?? null
        : p.parent?.type === 'database_id'
          ? p.parent.database_id ?? null
          : null,
      parentType: p.parent?.type ?? null,
    }))
    dbg(`Notion → ${pages.length} results:`, pages.map(p => `"${p.title}" parent=${p.parentType}:${p.parentId} ${p.url}`))
    return pages
  } finally {
    clearTimeout(timer)
  }
}

async function findNotionPage(title: string): Promise<NotionPage | null> {
  const pages = await searchNotionPages(title)
  const slug = title.toLowerCase().replace(/\s+/g, '-')
  const match = pages.find(p =>
    (p.title && p.title.toLowerCase() === title.toLowerCase()) ||
    p.url.toLowerCase().includes(slug)
  ) ?? null
  dbg(`findNotionPage("${title}") →`, match ? `found id=${match.id} url=${match.url}` : 'not found')
  return match
}


async function notionPageExistsUnderPage(title: string, expectedPageId: string): Promise<boolean> {
  const page = await findNotionPage(title)
  if (!page) return false

  if (page.parentType !== 'page_id' || page.parentId !== expectedPageId) {
    throw new Error(
      `wrong parent: type=${page.parentType} id=${page.parentId}, expected page_id=${expectedPageId}`
    )
  }

  console.log(`\n  → ${page.url}  [page ✓]`)
  return true
}

async function notionPageContains(title: string, marker: string): Promise<boolean> {
  const page = await findNotionPage(title)
  if (!page) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Notion blocks API ${res.status}`)
    const data = await res.json() as {
      results?: Array<{ type?: string; [key: string]: unknown }>
    }
    const text = (data.results ?? []).map(block => {
      const type = block.type as string
      const content = block[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined
      return content?.rich_text?.map(rt => rt.plain_text ?? '').join('') ?? ''
    }).join('\n')
    dbg(`notionPageContains("${title}", "${marker}") text length=${text.length} result=${text.includes(marker)}`)
    return text.includes(marker)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Confluence helpers
// ---------------------------------------------------------------------------

interface ConfluencePage {
  id: string
  title: string
  _links: { webui: string }
  ancestors: Array<{ id: string; title: string }>
  body?: { storage?: { value?: string } }
}

async function searchConfluencePages(title: string): Promise<ConfluencePage[]> {
  const base = (process.env.CONFLUENCE_BASE_URL ?? '').replace(/\/$/, '')
  const email = process.env.CONFLUENCE_EMAIL!
  const token = process.env.CONFLUENCE_TOKEN!
  const url = `${base}/wiki/rest/api/content?title=${encodeURIComponent(title)}&spaceKey=${CONFLUENCE_SPACE_KEY}&expand=ancestors,body.storage&limit=5`
  dbg(`Confluence GET ${url}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Confluence API ${res.status}: ${await res.text()}`)
    const data = await res.json() as { results?: ConfluencePage[] }
    const pages = data.results ?? []
    dbg(`Confluence → ${pages.length} results:`, pages.map(p => `"${p.title}" id=${p.id}`))
    return pages
  } finally {
    clearTimeout(timer)
  }
}

async function confluencePageExists(title: string): Promise<boolean> {
  const pages = await searchConfluencePages(title)
  const match = pages.find(p => p.title.toLowerCase() === title.toLowerCase())
  if (!match) return false
  const base = (process.env.CONFLUENCE_BASE_URL ?? '').replace(/\/$/, '')
  console.log(`\n  → ${base}/wiki${match._links.webui}  [confluence ✓]`)
  return true
}

async function confluencePageExistsUnderParent(title: string, parentPageId: string): Promise<boolean> {
  const pages = await searchConfluencePages(title)
  const match = pages.find(p => p.title.toLowerCase() === title.toLowerCase())
  if (!match) return false

  const directParent = match.ancestors.at(-1)
  console.log(`  [confluence-parent] page id=${match.id} ancestors=[${match.ancestors.map(a => `${a.id}(${a.title})`).join(' → ')}] expected_parent=${parentPageId}`)
  if (!directParent || directParent.id !== parentPageId) {
    throw new Error(
      `wrong parent: id=${directParent?.id ?? 'none'}, expected ${parentPageId}`
    )
  }

  const base = (process.env.CONFLUENCE_BASE_URL ?? '').replace(/\/$/, '')
  console.log(`\n  → ${base}/wiki${match._links.webui}  [confluence parent ✓]`)
  return true
}

async function confluencePageContains(title: string, marker: string): Promise<boolean> {
  const pages = await searchConfluencePages(title)
  const match = pages.find(p => p.title.toLowerCase() === title.toLowerCase())
  if (!match) return false
  const body = match.body?.storage?.value ?? ''
  dbg(`confluencePageContains("${title}", "${marker}") body length=${body.length} result=${body.includes(marker)}`)
  return body.includes(marker)
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type Check = {
  name: string
  expect: 'exists' | 'absent'
  fn: () => Promise<boolean>
}

const checks: Check[] = [

  // ── S3: flat mode (s3-flat/) ─────────────────────────────────────────────
  {
    name: 'S3 flat  | root file     → s3-flat/FLAT_A.md              [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-flat/FLAT_A.md'),
  },
  {
    name: 'S3 flat  | nested strips → s3-flat/FLAT_B.md (not nested)  [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-flat/FLAT_B.md'),
  },
  {
    name: 'S3 flat  | nested path   → s3-flat/nested/FLAT_B.md        [absent]',
    expect: 'absent',
    fn: () => s3KeyExists('s3-flat/nested/FLAT_B.md'),
  },

  // ── S3: hierarchy mode (s3-docs/) ────────────────────────────────────────
  {
    name: 'S3 hier  | root file     → s3-docs/ROOT_DOC.md             [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-docs/ROOT_DOC.md'),
  },
  {
    name: 'S3 hier  | nested file   → s3-docs/nested/NESTED_DOC.md    [exists]',
    expect: 'exists',
    fn: () => s3KeyExists('s3-docs/nested/NESTED_DOC.md'),
  },

  // ── S3: selective sub_folders glob (s3-selective/) ───────────────────────
  {
    name: 'S3 glob  | root always   → s3-selective/ROOT_FILE.md       [exists]',
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

  // ── ClickUp: sub_folders: false (clickup-root-only/) ─────────────────────
  {
    name: 'ClickUp  | sub_folders:false root   → "Shallow Task"       [exists]',
    expect: 'exists',
    fn: async () => {
      const tasks = await getTasksInList()
      return !!findTask(tasks, 'Shallow Task')
    },
  },
  {
    name: 'ClickUp  | sub_folders:false nested → "Deep Task"          [absent]',
    expect: 'absent',
    fn: async () => {
      const tasks = await getTasksInList()
      return !!findTask(tasks, 'Deep Task Should Not Sync')
    },
  },

  // ── ClickUp: link: list_id (clickup-link/) ───────────────────────────────
  {
    name: 'ClickUp  | link: list_id    → "ClickUp Link Task"          [exists]',
    expect: 'exists',
    fn: async () => {
      const tasks = await getTasksInList()
      return !!findTask(tasks, 'ClickUp Link Task')
    },
  },
  {
    name: 'ClickUp  | link: content    → "ClickUp Link Task" body synced [exists]',
    expect: 'exists',
    fn: async () => {
      const tasks = await getTasksInList()
      return taskContains(tasks, 'ClickUp Link Task', 'clickup-link-verify-marker')
    },
  },

  // ── ClickUp: doc mode at workspace wiki root (clickup-doc-wiki/) ────────
  {
    name: 'ClickUp  | doc wiki root   → "ClickUp Wiki Doc"              [exists]',
    expect: 'exists',
    fn: async () => !!await findClickUpDoc('ClickUp Wiki Doc'),
  },

  // ── Notion: page mode under Backend page (notion-docs/) ─────────────────
  {
    name: 'Notion   | first page    → "Notion Test Document"          [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderPage('Notion Test Document', NOTION_BACKEND_PAGE_ID),
  },
  {
    name: 'Notion   | second page   → "Notion Second Document"        [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderPage('Notion Second Document', NOTION_BACKEND_PAGE_ID),
  },
  {
    name: 'Notion   | nested page   → "Notion Nested Document"        [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderPage('Notion Nested Document', NOTION_BACKEND_PAGE_ID),
  },

  // ── Notion: sub-page parent (notion-subpage/ → Backend page) ─────────────
  {
    name: 'Notion   | sub-page      → "Backend Test Document" under Backend [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderPage('Backend Test Document', NOTION_BACKEND_PAGE_ID),
  },

  // ── Notion: link: parent (notion-link/ → Backend page via URL extraction) ─
  {
    name: 'Notion   | link: parent  → "Notion Link Test Document" under Backend [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderPage('Notion Link Test Document', NOTION_BACKEND_PAGE_ID),
  },
  {
    name: 'Notion   | link: content → "Notion Link Test Document" body synced   [exists]',
    expect: 'exists',
    fn: () => notionPageContains('Notion Link Test Document', 'notion-link-verify-marker'),
  },

  // ── Confluence: space root (confluence-docs/) ────────────────────────────
  {
    name: 'Confluence | first page   → "Confluence Test Document"        [exists]',
    expect: 'exists',
    fn: () => confluencePageExists('Confluence Test Document'),
  },
  {
    name: 'Confluence | second page  → "Confluence Second Document"      [exists]',
    expect: 'exists',
    fn: () => confluencePageExists('Confluence Second Document'),
  },
  {
    name: 'Confluence | nested page  → "Confluence Nested Document"      [exists]',
    expect: 'exists',
    fn: () => confluencePageExists('Confluence Nested Document'),
  },

  // ── Confluence: per-folder parent override (confluence-parent/) ───────────
  ...(CONFLUENCE_PARENT_PAGE_ID ? [{
    name: 'Confluence | child page   → "Confluence Child Document" under parent [exists]',
    expect: 'exists' as const,
    fn: () => confluencePageExistsUnderParent('Confluence Child Document', CONFLUENCE_PARENT_PAGE_ID!),
  }] : []),

  // ── Confluence: link: parent (confluence-link/) — skipped if CONFLUENCE_BASE_URL unset
  ...(process.env.CONFLUENCE_BASE_URL && process.env.CONFLUENCE_SPACE_KEY ? [
    {
      name: 'Confluence | link: parent → "Confluence Link Document" under parent page [exists]',
      expect: 'exists' as const,
      fn: () => confluencePageExistsUnderParent('Confluence Link Document', '360449'),
    },
    {
      name: 'Confluence | link: content → "Confluence Link Document" body synced [exists]',
      expect: 'exists' as const,
      fn: () => confluencePageContains('Confluence Link Document', 'confluence-link-verify-marker'),
    },
  ] : []),

  // ── Alias resolution (notion-alias/, clickup-alias/) ─────────────────────
  {
    name: 'Alias    | Notion alias:backend-page → "Notion Alias Test Document" under Backend [exists]',
    expect: 'exists',
    fn: () => notionPageExistsUnderPage('Notion Alias Test Document', NOTION_BACKEND_PAGE_ID),
  },
  {
    name: 'Alias    | Notion alias content synced correctly                   [exists]',
    expect: 'exists',
    fn: () => notionPageContains('Notion Alias Test Document', 'notion-alias-verify-marker'),
  },
  // ── Content verification ──────────────────────────────────────────────────
  {
    name: 'S3 content   | FLAT_A.md body synced correctly                [exists]',
    expect: 'exists',
    fn: () => s3ObjectContains('s3-flat/FLAT_A.md', 's3-flat-verify-marker'),
  },
  {
    name: 'Notion content | "Notion Test Document" body synced correctly [exists]',
    expect: 'exists',
    fn: () => notionPageContains('Notion Test Document', 'notion-database-verify-marker'),
  },
  {
    name: 'ClickUp content | "Shallow Task" description synced correctly [exists]',
    expect: 'exists',
    fn: async () => {
      const tasks = await getTasksInList()
      return taskContains(tasks, 'Shallow Task', 'clickup-task-verify-marker')
    },
  },
  {
    name: 'Confluence content | "Confluence Test Document" body synced  [exists]',
    expect: 'exists',
    fn: () => confluencePageContains('Confluence Test Document', 'confluence-test-verify-marker'),
  },
]

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\nmdspec verify — ${checks.length} checks${DEBUG ? ' [DEBUG]' : ''}\n`)

  const results: { name: string; ok: boolean; err?: string }[] = []
  const positives = checks.filter(c => c.expect === 'exists')
  const negatives = checks.filter(c => c.expect === 'absent')

  for (const check of positives) {
    process.stdout.write(`  ${check.name} `)
    if (DEBUG) process.stdout.write('\n')
    try {
      await pollUntil(check.name, check.fn)
      if (DEBUG) process.stdout.write(`  ${check.name} `)
      process.stdout.write(' ✅\n')
      results.push({ name: check.name, ok: true })
    } catch (err) {
      if (DEBUG) process.stdout.write(`  ${check.name} `)
      process.stdout.write(' ❌\n')
      results.push({ name: check.name, ok: false, err: (err as Error).message })
    }
  }

  console.log('\n  [negative checks — worker should be done by now]')
  for (const check of negatives) {
    process.stdout.write(`  ${check.name} `)
    if (DEBUG) process.stdout.write('\n')
    try {
      const exists = await check.fn()
      if (exists) {
        if (DEBUG) process.stdout.write(`  ${check.name} `)
        process.stdout.write(' ❌  (found — should be absent)\n')
        results.push({ name: check.name, ok: false, err: 'artifact exists but should not' })
      } else {
        if (DEBUG) process.stdout.write(`  ${check.name} `)
        process.stdout.write(' ✅\n')
        results.push({ name: check.name, ok: true })
      }
    } catch (err) {
      if (DEBUG) process.stdout.write(`  ${check.name} `)
      process.stdout.write(' ❌\n')
      results.push({ name: check.name, ok: false, err: (err as Error).message })
    }
  }

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
