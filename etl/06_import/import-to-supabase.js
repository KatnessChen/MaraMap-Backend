const { createClient } = require('@supabase/supabase-js');
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

async function importData() {
  const filePath = path.join(__dirname, '../05_merge/output/merged.json');
  if (!fs.existsSync(filePath)) {
    console.error('⚠️ Error: merged.json not found. Please run the merge step first.');
    return;
  }

  const rawData = fs.readFileSync(filePath, 'utf8');
  const posts = JSON.parse(rawData);

  // Load media lookup (timestamp → media[]) from ingest output
  const mediaPath = path.join(__dirname, '../01_ingest/output/media.json');
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

  // --- De-duplicate locally before upserting ---
  const uniquePostsMap = new Map();
  formattedPosts.forEach(post => {
    uniquePostsMap.set(`${post.user_id}-${post.fb_timestamp}`, post);
  });
  const uniquePosts = Array.from(uniquePostsMap.values());

  if (uniquePosts.length < formattedPosts.length) {
    console.log(`🧹 Found ${formattedPosts.length - uniquePosts.length} duplicate timestamp(s) in local data, keeping the latest versions.`);
  }

  // Perform upsert based on user_id and fb_timestamp to prevent duplicates
  const { data, error } = await supabase
    .from('fb_posts')
    .upsert(uniquePosts, { onConflict: 'user_id, fb_timestamp' });

  if (error) {
    console.error('❌ Import failed:', error.message);
  } else {
    console.log(`✅ Import successful! Updated ${uniquePosts.length} records with surgical merge.`);
  }
}

importData();
