---
title: S3 Flat Document B
---

# S3 Flat Document B

Tests S3 flat mode for a nested file. Despite being in a subfolder,
flat mode strips the path and stores just the filename under `parent_dir`.

Expected S3 key: `s3-flat/FLAT_B.md` (NOT `s3-flat/nested/FLAT_B.md`)
