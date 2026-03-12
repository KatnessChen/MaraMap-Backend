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

async function importData() {
  const filePath = path.join(__dirname, '../maramap_final_data.json');
  if (!fs.existsSync(filePath)) {
    console.error('⚠️ Error: maramap_final_data.json not found. Please run ai-classify.js first.');
    return;
  }

  const rawData = fs.readFileSync(filePath, 'utf8');
  const posts = JSON.parse(rawData);
  console.log(`📦 Preparing to import ${posts.length} posts to Supabase (fb_posts) for user: ${userId}...`);

  // Map JSON data to database columns
  const formattedPosts = posts.map(p => ({
    user_id: userId,
    fb_timestamp: p.timestamp,
    event_date: p.date,
    title: p.title,
    content: p.text,
    category: p.category || 'daily',
    tags: p.tags || [],
    media: p.media
  }));

  // Perform upsert based on user_id and fb_timestamp to prevent duplicates
  const { data, error } = await supabase
    .from('fb_posts')
    .upsert(formattedPosts, { onConflict: 'user_id, fb_timestamp' });

  if (error) {
    console.error('❌ Import failed:', error.message);
    if (error.code === '42P01') {
      console.log('💡 Hint: Please make sure you have created the "fb_posts" table in Supabase.');
    }
  } else {
    console.log(`✅ Import successful! Imported ${formattedPosts.length} records.`);
  }
}

importData();
