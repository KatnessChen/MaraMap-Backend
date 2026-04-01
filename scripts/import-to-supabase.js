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
  const filePath = path.join(__dirname, '../maramap_final_data.json');
  if (!fs.existsSync(filePath)) {
    console.error('⚠️ Error: maramap_final_data.json not found. Please run ai-classify.js first.');
    return;
  }

  const rawData = fs.readFileSync(filePath, 'utf8');
  const posts = JSON.parse(rawData);
  console.log(`📦 Preparing to import ${posts.length} posts to Supabase (fb_posts) for user: ${userId}...`);

  // --- Fetch existing data if protection is enabled ---
  let existingPostsMap = new Map();
  if (isPreserveUserEdition) {
    console.log('🛡️ Protection enabled. Fetching existing records to merge metadata...');
    const { data: existingData } = await supabase
      .from('fb_posts')
      .select('fb_timestamp, metadata, title, category, continent, is_overseas, is_hidden')
      .eq('user_id', userId);
    
    if (existingData) {
      existingData.forEach(d => existingPostsMap.set(d.fb_timestamp.toString(), d));
    }
  }

  // Map JSON data to database columns
  const formattedPosts = posts.map(p => {
    let finalMetadata = p.metadata || {};
    let finalTitle = p.title;
    let finalCategory = p.category || 'daily';
    let finalContinent = p.continent;
    let finalIsOverseas = p.is_overseas || false;
    let finalIsHidden = p.is_hidden || false;
    
    // Extract first line of text as the title if not already set
    if (!finalTitle && p.text) {
      finalTitle = p.text.split('\n')[0].trim();
    }

    // Merge logic: If protected and record exists, merge instead of overwrite
    if (isPreserveUserEdition && existingPostsMap.has(p.timestamp.toString())) {
      const dbRecord = existingPostsMap.get(p.timestamp.toString());
      const currentDbMetadata = dbRecord.metadata || {};
      
      // SURGICAL MERGE: 
      // 1. Only update participants from AI, keep everything else from DB
      finalMetadata = { 
        ...currentDbMetadata, 
        participants: finalMetadata.participants || currentDbMetadata.participants 
      };
      
      // 2. Keep core fields from DB to avoid overwriting manual fixes
      finalTitle = dbRecord.title || finalTitle;
      finalCategory = dbRecord.category || finalCategory;
      finalContinent = dbRecord.continent || finalContinent;
      finalIsOverseas = dbRecord.is_overseas ?? finalIsOverseas;
      finalIsHidden = dbRecord.is_hidden ?? finalIsHidden;
    }

    return {
      user_id: userId,
      fb_timestamp: p.timestamp,
      event_date: p.date,
      title: finalTitle,
      content: p.text,
      category: finalCategory,
      tags: p.tags || [],
      media: p.media,
      continent: finalContinent,
      is_overseas: finalIsOverseas,
      is_hidden: finalIsHidden,
      metadata: finalMetadata
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
