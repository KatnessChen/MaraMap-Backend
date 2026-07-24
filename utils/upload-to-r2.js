const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const pLimit = require('p-limit').default;

// --- Configuration ---
const CONCURRENCY_LIMIT = 20; // Number of simultaneous uploads
const r2Config = {
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
};

const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;
const USER_ID = process.env.USER_ID;
// Optional: scope to one batch folder under raw/ + its posts only. Omit to scan
// everything (all batches, whatever in the DB still has a non-http media uri).
const BATCH = process.env.BATCH;
// Raw exports now live under etl/01_ingest/raw/<batch>/<extracted-folder>/..., one
// subtree per Facebook data batch, instead of a single flat fb/raw/ folder.
const RAW_ROOT = BATCH
  ? path.join(__dirname, '../etl_local/01_ingest/raw/', BATCH)
  : path.join(__dirname, '../etl_local/01_ingest/raw/');

const s3 = new S3Client(r2Config);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const limit = pLimit(CONCURRENCY_LIMIT);

// Map to cache local URI -> R2 URL to avoid redundant uploads and lookups
const urlMap = new Map();

// Build an index of relativeUri ("your_facebook_activity/posts/media/...") -> absolute
// local path by walking every batch folder under RAW_ROOT once. Facebook's media
// filenames are its own internal numeric IDs, so collisions across batches aren't a
// practical concern.
function buildLocalFileIndex() {
  const index = new Map();
  if (!fs.existsSync(RAW_ROOT)) return index;
  const entries = fs.readdirSync(RAW_ROOT, { recursive: true });
  for (const entry of entries) {
    const marker = `your_facebook_activity${path.sep}posts${path.sep}media${path.sep}`;
    const idx = entry.indexOf(marker);
    if (idx === -1) continue;
    const fullPath = path.join(RAW_ROOT, entry);
    if (!fs.statSync(fullPath).isFile()) continue;
    const relativeUri = entry.slice(idx).split(path.sep).join('/');
    if (!index.has(relativeUri)) index.set(relativeUri, fullPath);
  }
  return index;
}

const localFileIndex = buildLocalFileIndex();
console.log(`🗂️  Indexed ${localFileIndex.size} local media files under raw/${BATCH || ''}`);

async function uploadFileToR2(relativeUri) {
  if (urlMap.has(relativeUri)) return urlMap.get(relativeUri);

  const localPath = localFileIndex.get(relativeUri);
  const key = relativeUri;

  if (!localPath || !fs.existsSync(localPath)) {
    console.warn(`⚠️ File not found in any raw/ batch: ${relativeUri}`);
    return null;
  }

  try {
    // Check if file exists in R2
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    } catch (e) {
      // If 404, upload it
      const fileBuffer = fs.readFileSync(localPath);
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: fileBuffer,
        ContentType: getContentType(localPath),
      }));
      console.log(`✅ Uploaded: ${key}`);
    }

    const finalUrl = `${PUBLIC_URL}/${key}`;
    urlMap.set(relativeUri, finalUrl);
    return finalUrl;
  } catch (error) {
    console.error(`❌ Failed: ${key}`, error.message);
    return null;
  }
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime'
  };
  return types[ext] || 'application/octet-stream';
}

async function startMigration() {
  if (!USER_ID) {
    console.error('❌ Missing USER_ID env var.');
    process.exit(1);
  }

  console.log(
    BATCH
      ? `🚀 Starting Media Migration for batch "${BATCH}" (Concurrency: ${CONCURRENCY_LIMIT})...`
      : `🚀 Starting Parallel Media Migration — all batches (Concurrency: ${CONCURRENCY_LIMIT})...`,
  );
  const startTime = Date.now();

  let query = supabase.from('fb_posts').select('fb_timestamp, media').eq('user_id', USER_ID);

  if (BATCH) {
    const postsJsonPath = path.join(__dirname, '../etl_local/01_ingest/output', BATCH, 'posts.json');
    if (!fs.existsSync(postsJsonPath)) {
      console.error(`❌ No ingest output found for batch "${BATCH}": ${postsJsonPath}`);
      process.exit(1);
    }
    const batchTimestamps = JSON.parse(fs.readFileSync(postsJsonPath, 'utf8')).map((p) => p.timestamp);
    console.log(`🎯 Restricting to ${batchTimestamps.length} post(s) from batch "${BATCH}"`);
    query = query.in('fb_timestamp', batchTimestamps);
  }

  const { data: posts, error } = await query;
  if (error) {
    console.error('❌ Failed to fetch posts:', error.message);
    return;
  }

  console.log(`📊 Scanning ${posts.length} posts for media...`);

  // Step 1: Collect all unique local URIs
  const uniqueLocalUris = new Set();
  posts.forEach(post => {
    post.media.forEach(m => {
      if (m.uri && !m.uri.startsWith('http')) {
        uniqueLocalUris.add(m.uri);
      }
    });
  });

  console.log(`📦 Found ${uniqueLocalUris.size} unique local files to process.`);

  // Step 2: Upload unique files in parallel
  const uploadTasks = Array.from(uniqueLocalUris).map(uri => 
    limit(() => uploadFileToR2(uri))
  );
  await Promise.all(uploadTasks);

  // Step 3: Update Supabase records
  console.log('💾 Updating Supabase with new R2 URLs...');
  let updateCount = 0;

  for (const post of posts) {
    let changed = false;
    const updatedMedia = post.media.map(m => {
      if (m.uri && !m.uri.startsWith('http') && urlMap.has(m.uri)) {
        changed = true;
        return { ...m, uri: urlMap.get(m.uri) };
      }
      return m;
    });

    if (changed) {
      const { error: err } = await supabase
        .from('fb_posts')
        .update({ media: updatedMedia })
        .eq('fb_timestamp', post.fb_timestamp)
        .eq('user_id', USER_ID);
      
      if (!err) updateCount++;
    }
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  console.log(`🏁 Finished! Total time: ${duration} mins. Updated ${updateCount} posts.`);
}

startMigration();
