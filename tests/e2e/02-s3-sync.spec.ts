import { test, expect } from '@playwright/test'
import { S3Client, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3'
import { S3_BUCKET, S3_REGION, pollUntil } from './helpers'

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
})

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function listObjects(prefix: string): Promise<string[]> {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix }))
  return (res.Contents ?? []).map(o => o.Key!)
}

test('S3_TEST.md is published to the S3 bucket', async () => {
  const keys = await pollUntil(() => listObjects('s3-docs/').then(k => k.length > 0 ? k : null))
  expect(keys.some(k => k.includes('S3_TEST'))).toBeTruthy()
})

test('S3_NESTED.md preserves subfolder hierarchy in S3', async () => {
  const exists = await pollUntil(() =>
    objectExists('s3-docs/subfolder/S3_NESTED.md').then(v => v ? true : null)
  )
  expect(exists).toBe(true)
})

test('multi-docs/MULTI_TEST.md is also in S3', async () => {
  const keys = await pollUntil(() => listObjects('multi-docs/').then(k => k.length > 0 ? k : null))
  expect(keys.some(k => k.includes('MULTI_TEST'))).toBeTruthy()
})

test('bucket contains only expected prefixes (no stray files)', async () => {
  const allKeys = await listObjects('')
  const allowedPrefixes = ['s3-docs/', 'multi-docs/']
  const stray = allKeys.filter(k => !allowedPrefixes.some(p => k.startsWith(p)))
  expect(stray).toHaveLength(0)
})
