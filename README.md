# testmdspecdocs

End-to-end integration test repo for [mdspec.dev](https://mdspec.dev). Every push to `main` triggers a full publish → verify cycle via GitHub Actions.

## How it works

```
push to main
  └─ mdspec.yml       runs `mdspeci publish` → syncs changed docs to S3, ClickUp, Notion
       └─ e2e.yml     runs verify/verify.ts  → polls each integration and asserts results
```

The `.mdspecmap` files in each folder are the **source of truth** for routing. The verify script checks that docs land exactly where the maps say they should — and that docs outside the allowed paths do not appear.

## Folder structure

```
testmdspecdocs/
├── s3-flat/              S3: flat mode (no path hierarchy)
├── s3-docs/              S3: hierarchy mode (preserves folder structure)
├── s3-selective/         S3: sub_folders glob filter
├── clickup-root-only/    ClickUp: sub_folders: false (root files only)
├── notion-docs/          Notion: database mode (default root)
├── notion-subpage/       Notion: database mode with per-folder page override
└── verify/               Verification script
```

## Test scenarios

### S3 — flat mode (`s3-flat/`)

`.mdspecmap`: `integration: s3`, no `maintain_hierarchy`

| File | Expected S3 key | Check |
|------|----------------|-------|
| `FLAT_A.md` | `s3-flat/FLAT_A.md` | exists |
| `nested/FLAT_B.md` | `s3-flat/FLAT_B.md` (path stripped) | exists |
| _(nested path)_ | `s3-flat/nested/FLAT_B.md` | absent — flat mode must not preserve path |

Verifies: flat mode strips subdirectory paths, all files land at the prefix root.

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

Verifies: `sub_folders` glob restricts which subdirectories are synced; root files are always included regardless of glob.

---

### ClickUp — sub_folders: false (`clickup-root-only/`)

`.mdspecmap`: `sub_folders: false`, `target: task`

| File | Expected ClickUp task | Check |
|------|-----------------------|-------|
| `SHALLOW.md` | "Shallow Task" | exists |
| `deep/DEEP.md` | "Deep Task Should Not Sync" | absent |

Verifies: `sub_folders: false` limits syncing to root-level files only (depth 1); nested files are not published.

---

### Notion — database mode (`notion-docs/`)

`.mdspecmap`: `integration: notion`, `target: document` (no `parent:`)

| File | Expected Notion location | Check |
|------|--------------------------|-------|
| `NOTION_TEST.md` | "Notion Test Document" under root database | exists |
| `NOTION_SECOND.md` | "Notion Second Document" under root database | exists |
| `nested/NOTION_NESTED.md` | "Notion Nested Document" under root database | exists |

Verifies: without a `parent:` override, all docs land as rows in the connected Notion database.

---

### Notion — per-folder page override (`notion-subpage/`)

`.mdspecmap`: `integration: notion`, `parent: id:cc69bd0f-98d7-4d6e-8701-72d92a920cf5`

| File | Expected Notion location | Check |
|------|--------------------------|-------|
| `BACKEND_DOC.md` | "Backend Test Document" as child page under the Backend page | exists |

Verifies: when `parent: id:<pageId>` is set in `.mdspecmap`, docs route to that specific Notion page even when the integration is in database mode. The `.mdspecmap` is authoritative — the dashboard integration default is overridden per folder.

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

---

## CI workflows

### `.github/workflows/mdspec.yml` — Publish

Trigger: push to `main`

Runs `mdspeci publish` to sync any changed docs to the configured integrations.

### `.github/workflows/e2e.yml` — Verify

Trigger: `workflow_run` after Publish completes successfully

Waits 30s for the mdspec worker to process jobs, then runs `verify/verify.ts`. Positive checks (docs that should exist) poll for up to 3 minutes. Negative checks (docs that should be absent) run once after all positive checks pass.

Exits non-zero if any check fails, which marks the GitHub Actions run as failed.
