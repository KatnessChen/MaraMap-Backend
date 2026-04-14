const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.USER_ID;

if (!supabaseUrl || !supabaseKey || !userId) {
  console.error('❌ Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or USER_ID');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const DRY_RUN = process.argv.includes('--dry-run');

async function cleanupSkipped() {
  const allPosts     = JSON.parse(fs.readFileSync(path.join(__dirname, '../01_ingest/output/posts.json'), 'utf8'));
  const classified   = JSON.parse(fs.readFileSync(path.join(__dirname, '../02_classify/output/classified.json'), 'utf8'));

  const keepSet      = new Set(classified.map(p => p.timestamp));
  const skipTimestamps = allPosts
    .filter(p => !keepSet.has(p.timestamp))
    .map(p => p.timestamp);

  console.log(`📊 全部貼文: ${allPosts.length}`);
  console.log(`✅ 保留（已分類）: ${keepSet.size}`);
  console.log(`🗑️  應刪除（skip）: ${skipTimestamps.length}`);

  if (skipTimestamps.length === 0) {
    console.log('沒有需要刪除的資料。');
    return;
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 以下 timestamps 將被刪除：');
    skipTimestamps.forEach(ts => console.log(' ', ts));
    return;
  }

  const { error, count } = await supabase
    .from('fb_posts')
    .delete({ count: 'exact' })
    .eq('user_id', userId)
    .in('fb_timestamp', skipTimestamps);

  if (error) {
    console.error('❌ 刪除失敗:', error.message);
  } else {
    console.log(`✅ 成功刪除 ${count} 筆記錄`);
  }
}

cleanupSkipped();
