# testmdspecdocs

> Local repo: `/Users/mfmz/testmdspecdocs`

End-to-end integration test repo for [mdspec.dev](https://mdspec.dev). Every push to `main` triggers a full publish → verify cycle via GitHub Actions.

## How it works

```
push to main
  └─ mdspec.yml       runs `mdspeci publish` → syncs changed docs to S3, ClickUp, Notion
       └─ e2e.yml     runs verify/verify.ts  → polls each integration and asserts results
```

The `.mdspecmap` files in each folder are the **source of truth** for routing. The verify script checks that docs land exactly where the maps say they should, that their body content was synced correctly, and that docs outside the allowed paths do not appear.

## Folder structure

```
testmdspecdocs/
├── s3-flat/              S3: flat mode (no path hierarchy)
├── s3-docs/              S3: hierarchy mode (preserves folder structure)
├── s3-selective/         S3: sub_folders glob filter
├── clickup-root-only/    ClickUp: sub_folders: false (root files only)
├── clickup-link/         ClickUp: list_id resolved from a clickup.com URL
├── clickup-alias/        ClickUp: list_id via alias (alongside notion-alias/)
├── notion-docs/          Notion: page mode under configured parent page
├── notion-subpage/       Notion: per-folder parent page override
├── notion-alias/         Notion: parent resolved via alias name
├── notion-link/          Notion: parent resolved from a notion.so URL
├── confluence-docs/      Confluence: space root (flat + nested hierarchy)
├── confluence-parent/    Confluence: per-folder parent page override
├── confluence-link/      Confluence: parent resolved from an Atlassian URL
└── verify/               Verification script
```

## Test scenarios

### S3 — flat mode (`s3-flat/`)

`.mdspecmap`: `integration: s3`, no `maintain_hierarchy`

| File | Expected S3 key | Check |
|------|----------------|-------|
| `FLAT_A.md` | `s3-flat/FLAT_A.md` | exists |
| `FLAT_A.md` | body contains `s3-flat-verify-marker` | content synced |
| `nested/FLAT_B.md` | `s3-flat/FLAT_B.md` (path stripped) | exists |
| _(nested path)_ | `s3-flat/nested/FLAT_B.md` | absent — flat mode must not preserve path |

Verifies: flat mode strips subdirectory paths; all files land at the prefix root; body content is faithfully written to S3.

---

### S3 — hierarchy mode (`s3-docs/`)

`.mdspecmap`: `integration: s3`, `maintain_hierarchy: true`

| File | Expected S3 key | Check |
|------|----------------|-------|
| `ROOT_DOC.md` | `s3-docs/ROOT_DOC.md` | exists |
| `nested/NESTED_DOC.md` | `s3-docs/nested/NESTED_DOC.md` | exists |

Verifies: hierarchy mode preserves the full relative path under the prefix.

---

### S3 — sub_folders glob filter (`s3-selective/`)

`.mdspecmap`: `sub_folders: ['included/**']`, `maintain_hierarchy: true`

| File | Expected S3 key | Check |
|------|----------------|-------|
| `ROOT_FILE.md` | `s3-selective/ROOT_FILE.md` | exists — root files always pass |
| `included/INCLUDED.md` | `s3-selective/included/INCLUDED.md` | exists — matches glob |
| `excluded/EXCLUDED.md` | `s3-selective/excluded/EXCLUDED.md` | absent — does not match glob |

Verifies: `sub_folders` glob restricts which subdirectories are synced; root files are always included regardless of glob; the most-specific folder mapping wins (a root integration without restrictions cannot rescue a file that a scoped mapping rejects).

---

### ClickUp — sub_folders: false (`clickup-root-only/`)

`.mdspecmap`: `sub_folders: false`, `target: task`

| File | Expected ClickUp task | Check |
|------|-----------------------|-------|
| `SHALLOW.md` | "Shallow Task" | exists |
| `SHALLOW.md` | task description contains `clickup-task-verify-marker` | content synced |
| `deep/DEEP.md` | "Deep Task Should Not Sync" | absent |

Task titles come from the frontmatter `title:` field, not the filename. Descriptions are synced as markdown via `include_markdown_description=true`.

Verifies: `sub_folders: false` limits syncing to root-level files only (depth 1); nested files are not published; task description body is correctly written.

---

### ClickUp — `list_id: link:` URL resolution (`clickup-link/`)

`.mdspecmap`: `list_id: link:https://app.clickup.com/90181844797/li/901817533430`, `sub_folders: false`, `target: task`

| File | Expected ClickUp task | Check |
|------|-----------------------|-------|
| `CLICKUP_LINK_TASK.md` | "ClickUp Link Task" in list `901817533430` | exists |
| `CLICKUP_LINK_TASK.md` | task description contains `clickup-link-verify-marker` | content synced |

Task routes to the same list as `clickup-root-only/` (which uses `list_id: id:901817533430` directly), proving that the `link:` URL resolver extracts the correct list ID from a ClickUp web URL.

Verifies: `list_id: link:<url>` resolves the list ID from a full ClickUp app URL; the resolved ID produces the same routing as an explicit `id:` reference; task description body is correctly written.

---

### Notion — database mode (`notion-docs/`)

`.mdspecmap`: `integration: notion`, `target: document` (no `parent:`)

| File | Expected Notion location | Check |
|------|--------------------------|-------|
| `NOTION_TEST.md` | "Notion Test Document" under root database | exists |
| `NOTION_TEST.md` | page blocks contain `notion-database-verify-marker` | content synced |
| `NOTION_SECOND.md` | "Notion Second Document" under root database | exists |
| `nested/NOTION_NESTED.md` | "Notion Nested Document" under root database | exists |

Verifies: without a `parent:` override, all docs land as rows in the connected Notion database regardless of subfolder depth; page body blocks are correctly written.

---

### Confluence — space root (`confluence-docs/`)

`.mdspecmap`: `integration: confluence`, `target: document`

| File | Expected Confluence page | Check |
|------|--------------------------|-------|
| `CONFLUENCE_TEST.md` | "Confluence Test Document" in configured space | exists |
| `CONFLUENCE_TEST.md` | page body (storage) contains `confluence-test-verify-marker` | content synced |
| `CONFLUENCE_SECOND.md` | "Confluence Second Document" in configured space | exists |
| `nested/CONFLUENCE_NESTED.md` | "Confluence Nested Document" in configured space | exists |

The nested file exercises automatic ancestor page creation: the adapter creates a `confluence-docs` parent page and a `nested` child page before publishing the spec beneath them.

Verifies: basic Confluence publish; multiple docs per folder; nested path triggers intermediate page hierarchy; body content is written in Confluence storage format.

---

### Confluence — per-folder parent override (`confluence-parent/`)

`.mdspecmap`: `integration: confluence`, `parent: id:<pageId>`

| File | Expected Confluence location | Check |
|------|------------------------------|-------|
| `CONFLUENCE_CHILD.md` | "Confluence Child Document" as child of the configured parent page | exists |

Set `CONFLUENCE_PARENT_PAGE_ID` in `verify/.env` to the ID of an existing Confluence page to enable this check. If the variable is unset the check is skipped.

Verifies: when `parent: id:<pageId>` is set in `.mdspecmap`, docs route to that specific Confluence page instead of computing the full folder hierarchy from the path.

---

### Notion — per-folder page override (`notion-subpage/`)

`.mdspecmap`: `integration: notion`, `parent: id:cc69bd0f-98d7-4d6e-8701-72d92a920cf5`

| File | Expected Notion location | Check |
|------|--------------------------|-------|
| `BACKEND_DOC.md` | "Backend Test Document" as child page under the Backend page | exists |

Verifies: when `parent: id:<pageId>` is set in `.mdspecmap`, docs route to that specific Notion page even when the integration is in database mode. The `.mdspecmap` is authoritative — the dashboard integration default is overridden per folder.

---

### Notion — `parent: link:` URL resolution (`notion-link/`)

`.mdspecmap`: `parent: link:https://www.notion.so/cc69bd0f-98d7-4d6e-8701-72d92a920cf5`

| File | Expected Notion location | Check |
|------|--------------------------|-------|
| `NOTION_LINK_DOC.md` | "Notion Link Test Document" as child page under the Backend page | exists |
| `NOTION_LINK_DOC.md` | page blocks contain `notion-link-verify-marker` | content synced |

Routes to the same page as `notion-subpage/` (which uses `parent: id:cc69bd0f-98d7-4d6e-8701-72d92a920cf5` directly), proving that the `link:` URL resolver extracts the correct page ID from a Notion web URL.

Verifies: `parent: link:<url>` resolves the page ID from a full notion.so URL; the resolved ID produces the same routing as an explicit `id:` reference; page body blocks are correctly written.

---

### Confluence — `parent: link:` URL resolution (`confluence-link/`)

`.mdspecmap`: `parent: id:360449` (resolved from a full Atlassian URL via `link:` syntax)

Skipped unless `CONFLUENCE_BASE_URL` and `CONFLUENCE_SPACE_KEY` are set.

| File | Expected Confluence location | Check |
|------|------------------------------|-------|
| `CONFLUENCE_LINK_DOC.md` | "Confluence Link Document" as child of page `360449` | exists |
| `CONFLUENCE_LINK_DOC.md` | page body contains `confluence-link-verify-marker` | content synced |

Routes to the same page as `confluence-parent/` (which uses `parent: id:360449` directly), proving that the `link:` URL resolver extracts the correct page ID from an Atlassian URL.

Verifies: `parent: link:<url>` resolves the Confluence page ID from a full Atlassian URL; page body (storage format) is correctly written under the resolved parent.

---

### Aliases — `alias:` resolution (`notion-alias/`, `clickup-alias/`)

Aliases are named shortcuts defined in the dashboard (Integrations → Aliases) that map a human-readable name to a native integration target ID. In `.mdspecmap`, use `parent: alias:<name>` or `list_id: alias:<name>` instead of hardcoding a raw ID.

Pre-created aliases used by these tests:

| Alias | Integration | Resolves to |
|-------|-------------|-------------|
| `backend-page` | Notion | Backend page `cc69bd0f-98d7-4d6e-8701-72d92a920cf5` |
| `clickup-tasks` | ClickUp | List `901817533430` |

**`notion-alias/.mdspecmap`**: `parent: alias:backend-page`

| File | Expected Notion location | Check |
|------|--------------------------|-------|
| `NOTION_ALIAS_DOC.md` | "Notion Alias Test Document" under the Backend page | exists |
| `NOTION_ALIAS_DOC.md` | page blocks contain `notion-alias-verify-marker` | content synced |

**`clickup-alias/.mdspecmap`**: `list_id: id:901817533430`, `sub_folders: false`

> Note: `list_id` does not support `alias:` syntax — only the `parent:` field is alias-resolved by the processor. The ClickUp folder exists to confirm ClickUp routing still works alongside alias-using folders in the same repo, but uses a direct `id:` reference. The Notion alias check is sufficient to prove the full alias resolution pipeline.

| File | Expected ClickUp task | Check |
|------|-----------------------|-------|
| `ALIAS_TASK.md` | "ClickUp Alias Task" in the tasks list | exists (via root ClickUp mapping) |

Verifies: the alias → native ID resolution pipeline works end-to-end; docs reach the correct destination when the `.mdspecmap` uses an alias name rather than a hardcoded ID.

---

## Check summary

| # | Integration | Type | What it proves |
|---|-------------|------|----------------|
| 1 | S3 flat | exists | flat mode routes to correct key |
| 2 | S3 flat | content | file body written to S3 |
| 3 | S3 flat | absent | flat mode does not preserve nested path |
| 4 | S3 hierarchy | exists (root) | hierarchy root file at correct key |
| 5 | S3 hierarchy | exists (nested) | hierarchy preserves subfolder path |
| 6 | S3 glob | exists (root) | root files bypass glob filter |
| 7 | S3 glob | exists (matched) | matched glob subfolder syncs |
| 8 | S3 glob | absent | unmatched glob subfolder excluded |
| 9 | ClickUp root-only | exists | task created with correct title |
| 10 | ClickUp root-only | content | task description body synced |
| 11 | ClickUp root-only | absent | nested file not published (depth filter) |
| 12 | ClickUp link | exists | `list_id: link:<url>` resolves to correct list |
| 13 | ClickUp link | content | link-routed task description body synced |
| 14 | Notion page | exists (1) | first doc published under configured page |
| 15 | Notion page | exists (2) | second doc published under configured page |
| 16 | Notion page | exists (nested) | nested file published under configured page |
| 17 | Notion page | content | page blocks body synced |
| 18 | Notion subpage | exists | per-folder parent override routes to correct page |
| 19 | Notion link | exists | `parent: link:<url>` resolves to correct Notion page |
| 20 | Notion link | content | link-routed page body synced |
| 21 | Notion alias | exists | `alias:backend-page` resolves to correct Notion page |
| 22 | Notion alias | content | alias-routed page body synced |
| 23 | ClickUp alias | exists | ClickUp task created alongside alias-using Notion folder |
| 24 | Confluence | exists (1) | first page published to space |
| 25 | Confluence | exists (2) | second page published to space |
| 26 | Confluence | exists (nested) | nested file triggers ancestor hierarchy creation |
| 27 | Confluence parent | exists | per-folder parent override routes to correct page |
| 28 | Confluence link | exists | `parent: link:<url>` resolves to correct Confluence page |
| 29 | Confluence link | content | link-routed page body (storage format) synced |

**Total: 28 checks** (27 without `CONFLUENCE_PARENT_PAGE_ID`; 25–26 without `CONFLUENCE_BASE_URL`) — 25 positive (polled up to 3 min), 3 negative (run once after positives complete).

---

## Known gaps

| Area | Gap |
|------|-----|
| ClickUp `list_id` alias | `list_id: alias:<name>` is not resolved by the processor — only `parent:` supports alias syntax. ClickUp alias routing is untested. |
| ClickUp doc mode | Not tested — only task list mode is covered |
| Notion subpage | Content not verified for the Backend page — only parent routing is checked |
| Notion alias content | Only routing is verified — no deeper block-by-block diff |
| S3 hierarchy | Content not verified — only key existence is checked |
| S3 flat | Only `FLAT_A.md` content is verified; `FLAT_B.md` (nested strip) is existence-only |
| Confluence | No content check for space-root mode — only page existence is verified |
| Confluence parent | Skipped unless `CONFLUENCE_PARENT_PAGE_ID` is set in verify/.env |
| Confluence link | Skipped unless `CONFLUENCE_BASE_URL` and `CONFLUENCE_SPACE_KEY` are set |
| Frontmatter title | No dedicated test where filename ≠ `title:` frontmatter to isolate title resolution |
| Update cycle | No test that edits a file and verifies the updated content replaces the old content |
| Deletion | No test that removing a file from the repo causes it to be removed from the integration |
| Multi-integration | No folder mapped to two integrations simultaneously |

---

## Running verification locally

```bash
# Copy and fill in credentials
cp verify/.env.example verify/.env

# Poll for up to 3 minutes (mirrors CI)
npm run verify

# Check once immediately — fails fast if not ready
npm run verify:now

# Full API response logging
npm run verify:debug
```

### Required environment variables

| Variable | Used by |
|----------|---------|
| `AWS_ACCESS_KEY_ID` | S3 checks |
| `AWS_SECRET_ACCESS_KEY` | S3 checks |
| `CLICKUP_API_TOKEN` | ClickUp checks |
| `NOTION_TOKEN` | Notion checks |
| `CONFLUENCE_BASE_URL` | Confluence checks |
| `CONFLUENCE_EMAIL` | Confluence checks |
| `CONFLUENCE_TOKEN` | Confluence checks |
| `CONFLUENCE_SPACE_KEY` | Confluence checks |
| `CONFLUENCE_PARENT_PAGE_ID` | Confluence parent check (optional — skipped if unset) |

---

## CI workflows

### `.github/workflows/mdspec.yml` — Publish

Trigger: push to `main`

Runs `mdspeci publish` to sync any changed docs to the configured integrations.

### `.github/workflows/e2e.yml` — Verify

Trigger: `workflow_run` after Publish completes successfully

Waits 30s for the mdspec worker to process jobs, then runs `verify/verify.ts`. Positive checks (docs that should exist) poll for up to 3 minutes. Negative checks (docs that should be absent) run once after all positive checks pass.

Exits non-zero if any check fails, which marks the GitHub Actions run as failed.
