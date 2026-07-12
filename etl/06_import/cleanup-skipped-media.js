const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.R2_BUCKET_NAME;

if (!BUCKET || !process.env.R2_ENDPOINT) {
  console.error('❌ Missing R2_ENDPOINT or R2_BUCKET_NAME');
  process.exit(1);
}

async function cleanupMedia() {
  const BATCH = process.env.BATCH;
  if (!BATCH) {
    console.error('❌ Missing BATCH env var. Usage: BATCH=<folder-name> node cleanup-skipped-media.js [--dry-run]');
    process.exit(1);
  }

  const allPosts   = JSON.parse(fs.readFileSync(path.join(__dirname, `../01_ingest/output/${BATCH}/posts.json`), 'utf8'));
  const classified = JSON.parse(fs.readFileSync(path.join(__dirname, `../02_classify/output/${BATCH}/classified.json`), 'utf8'));
  const allMedia   = JSON.parse(fs.readFileSync(path.join(__dirname, `../01_ingest/output/${BATCH}/media.json`), 'utf8'));

  const keepSet    = new Set(classified.map(p => p.timestamp));
  const skipTs     = new Set(allPosts.filter(p => !keepSet.has(p.timestamp)).map(p => p.timestamp));
  const orphaned   = allMedia.filter(m => skipTs.has(m.timestamp)).map(m => m.uri).filter(Boolean);

  console.log(`🗑️  孤立媒體檔案: ${orphaned.length} 個`);

  if (orphaned.length === 0) {
    console.log('沒有需要刪除的檔案。');
    return;
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 以下檔案將被刪除：');
    orphaned.forEach(uri => console.log(' ', uri));
    return;
  }

  // R2 DeleteObjects 每次最多 1000 個
  const CHUNK = 1000;
  let totalDeleted = 0;
  let totalErrors  = 0;

  for (let i = 0; i < orphaned.length; i += CHUNK) {
    const chunk = orphaned.slice(i, i + CHUNK);
    const objects = chunk.map(uri => ({ Key: uri }));

    const { Deleted, Errors } = await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: objects, Quiet: false },
    }));

    totalDeleted += Deleted?.length ?? 0;
    totalErrors  += Errors?.length  ?? 0;

    if (Errors?.length) {
      Errors.forEach(e => console.error(`  ❌ ${e.Key}: ${e.Message}`));
    }
    console.log(`  批次 ${Math.floor(i / CHUNK) + 1}: 刪除 ${Deleted?.length ?? 0} 個`);
  }

  console.log(`\n✅ 完成 — 成功刪除 ${totalDeleted} 個，失敗 ${totalErrors} 個`);
}

cleanupMedia();
