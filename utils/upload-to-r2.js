const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const pLimit = require('p-limit');

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
const FB_EXPORT_PATH = path.join(__dirname, '../fb/raw/');

const s3 = new S3Client(r2Config);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const limit = pLimit(CONCURRENCY_LIMIT);

// Map to cache local URI -> R2 URL to avoid redundant uploads and lookups
const urlMap = new Map();

async function uploadFileToR2(relativeUri) {
  if (urlMap.has(relativeUri)) return urlMap.get(relativeUri);

  const localPath = path.join(FB_EXPORT_PATH, relativeUri);
  const key = relativeUri;

  if (!fs.existsSync(localPath)) {
    // console.warn(`⚠️ File not found: ${localPath}`);
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
  console.log(`🚀 Starting Parallel Media Migration (Concurrency: ${CONCURRENCY_LIMIT})...`);
  const startTime = Date.now();

  const { data: posts, error } = await supabase.from('fb_posts').select('fb_timestamp, media');
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
        .eq('fb_timestamp', post.fb_timestamp);
      
      if (!err) updateCount++;
    }
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  console.log(`🏁 Finished! Total time: ${duration} mins. Updated ${updateCount} posts.`);
}

startMigration();
