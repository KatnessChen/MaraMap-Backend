const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.USER_ID; // The target user's UUID in Supabase

if (!supabaseUrl || !supabaseKey || !userId) {
  console.error('❌ Error: Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or USER_ID');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// --- Feature Flag: Protection Mechanism ---
// Set to true to prevent overwriting existing metadata fields (useful once manual edits start)
const isPreserveUserEdition = false;

// fb_timestamp alone is not a reliable post identity: batch actions (e.g. wishing
// several friends happy birthday back-to-back, bulk sticker shares) land multiple
// distinct posts on the same second. Content distinguishes them; a timestamp+content
// signature is what actually identifies "the same post" across re-imports.
function postSignature(fbTimestamp, title, content, mediaList) {
  const mediaUris = (mediaList || []).map((m) => m.uri || '').sort().join('|');
  const raw = `${fbTimestamp}::${title || ''}::${content || ''}::${mediaUris}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function importData() {
  const BATCH = process.env.BATCH;
  if (!BATCH) {
    console.error('❌ Missing BATCH env var. Usage: BATCH=<folder-name> node import-to-supabase.js');
    process.exit(1);
  }

  const filePath = path.join(__dirname, `../05_merge/output/${BATCH}/merged.json`);
  if (!fs.existsSync(filePath)) {
    console.error('⚠️ Error: merged.json not found. Please run the merge step first.');
    return;
  }

  const rawData = fs.readFileSync(filePath, 'utf8');
  const posts = JSON.parse(rawData);

  // Load media lookup (timestamp → media[]) from ingest output
  const mediaPath = path.join(__dirname, `../01_ingest/output/${BATCH}/media.json`);
  const mediaByTimestamp = new Map();
  if (fs.existsSync(mediaPath)) {
    const allMedia = JSON.parse(fs.readFileSync(mediaPath, 'utf8'));
    allMedia.forEach(m => {
      const key = String(m.timestamp);
      if (!mediaByTimestamp.has(key)) mediaByTimestamp.set(key, []);
      mediaByTimestamp.get(key).push(m);
    });
    console.log(`🖼️  Loaded media for ${mediaByTimestamp.size} posts from media.json`);
  } else {
    console.warn('⚠️  media.json not found — media field will be empty');
  }
  console.log(`📦 Preparing to import ${posts.length} posts to Supabase (fb_posts) for user: ${userId}...`);

  // --- Fetch existing data if protection is enabled ---
  let existingPostsMap = new Map();
  if (isPreserveUserEdition) {
    console.log('🛡️ Protection enabled. Fetching existing records to merge metadata...');
    const { data: existingData } = await supabase
      .from('fb_posts')
      .select('fb_timestamp, metadata, title, category')
      .eq('user_id', userId);
    
    if (existingData) {
      existingData.forEach(d => existingPostsMap.set(d.fb_timestamp.toString(), d));
    }
  }

  // Map JSON data to database columns
  const formattedPosts = posts.map(p => {
    let finalMetadata = p.metadata || {};
    let finalTitle = p.title;
    let finalCategory = p.category;

    // Merge logic: If protected and record exists, merge instead of overwrite
    if (isPreserveUserEdition && existingPostsMap.has(p.timestamp.toString())) {
      const dbRecord = existingPostsMap.get(p.timestamp.toString());
      const currentDbMetadata = dbRecord.metadata || {};

      // SURGICAL MERGE: preserve manual edits, only update AI-computed fields
      finalMetadata = {
        ...currentDbMetadata,
        participants: finalMetadata.participants || currentDbMetadata.participants,
      };
      finalTitle    = dbRecord.title    || finalTitle;
      finalCategory = dbRecord.category || finalCategory;
    }

    return {
      user_id: userId,
      fb_timestamp: p.timestamp,
      event_date: p.date,
      title: finalTitle,
      content: p.text,
      category: finalCategory,
      sub_categories: p.sub_categories || [],
      media: mediaByTimestamp.get(String(p.timestamp)) || [],
      metadata: finalMetadata,
    };
  });

  // --- De-duplicate locally by content signature, not just timestamp ---
  // (two distinct posts can share an fb_timestamp; a naive timestamp-only key
  // would silently drop one of them here)
  const uniquePostsMap = new Map();
  formattedPosts.forEach(post => {
    const sig = postSignature(post.fb_timestamp, post.title, post.content, post.media);
    uniquePostsMap.set(`${post.user_id}-${sig}`, post);
  });
  const uniquePosts = Array.from(uniquePostsMap.values());

  if (uniquePosts.length < formattedPosts.length) {
    console.log(`🧹 Found ${formattedPosts.length - uniquePosts.length} exact duplicate post(s) in local data, collapsed to one.`);
  }

  // --- Skip posts that already exist in the database (never overwrite) ---
  console.log('🔎 Fetching existing posts for this user to check for duplicates...');
  const { data: existingRows, error: fetchError } = await supabase
    .from('fb_posts')
    .select('fb_timestamp, title, content, media')
    .eq('user_id', userId);

  if (fetchError) {
    console.error('❌ Failed to fetch existing posts:', fetchError.message);
    return;
  }

  const existingSignatures = new Set(
    (existingRows || []).map((r) => postSignature(r.fb_timestamp, r.title, r.content, r.media))
  );

  const newPosts = [];
  const skipped = [];
  uniquePosts.forEach((post) => {
    const sig = postSignature(post.fb_timestamp, post.title, post.content, post.media);
    if (existingSignatures.has(sig)) {
      skipped.push(post);
    } else {
      newPosts.push(post);
    }
  });

  console.log(`⏭️  Skipping ${skipped.length} post(s) already in the database.`);

  if (newPosts.length === 0) {
    console.log('✅ Nothing new to import — all posts already exist.');
    return;
  }

  // The DB's unique constraint is (user_id, fb_timestamp) only — coarser than our
  // content-aware signature. If two distinct new posts share an fb_timestamp (seen in
  // practice: back-to-back birthday wall posts, batch sticker shares), inserting them
  // together in one statement would fail the whole batch. Pull those out and insert
  // one at a time so a single collision can't block unrelated posts.
  const timestampCounts = new Map();
  newPosts.forEach((p) => {
    timestampCounts.set(p.fb_timestamp, (timestampCounts.get(p.fb_timestamp) || 0) + 1);
  });
  const safePosts = newPosts.filter((p) => timestampCounts.get(p.fb_timestamp) === 1);
  const riskyPosts = newPosts.filter((p) => timestampCounts.get(p.fb_timestamp) > 1);

  let insertedCount = 0;
  const failed = [];

  if (safePosts.length > 0) {
    const { error } = await supabase.from('fb_posts').insert(safePosts);
    if (error) {
      console.error('❌ Bulk import failed:', error.message);
      return;
    }
    insertedCount += safePosts.length;
  }

  for (const post of riskyPosts) {
    const { error } = await supabase.from('fb_posts').insert([post]);
    if (error) {
      failed.push({ post, error });
    } else {
      insertedCount += 1;
    }
  }

  console.log(`✅ Inserted ${insertedCount} new record(s).`);
  if (failed.length > 0) {
    console.error(
      `⚠️  ${failed.length} post(s) could not be inserted — each shares an fb_timestamp ` +
      'with another post (new or already-imported) but has different content. The current ' +
      '(user_id, fb_timestamp) schema constraint can only keep one. Nothing was overwritten; ' +
      'these were skipped and need a manual look:'
    );
    failed.forEach(({ post, error }) => {
      console.error(`   - ${post.fb_timestamp} (${post.event_date}): "${(post.title || '').slice(0, 40)}" — ${error.message}`);
    });
  }
}

importData();
