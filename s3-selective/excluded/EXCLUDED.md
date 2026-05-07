---
title: S3 Selective Excluded File
---

# S3 Selective Excluded File

This file is in `excluded/` which does NOT match `sub_folders: ['included/**']`.
The CLI should skip it. No S3 object should be created for this file.
