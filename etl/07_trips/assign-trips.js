const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId      = process.env.USER_ID;

if (!supabaseUrl || !supabaseKey || !userId) {
  console.error('❌ Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or USER_ID');
  process.exit(1);
}

const supabase  = createClient(supabaseUrl, supabaseKey);
const DRY_RUN   = process.argv.includes('--dry-run');
const WINDOW_DAYS = 14;

function daysBetween(dateA, dateB) {
  return Math.abs((new Date(dateA) - new Date(dateB)) / 86400000);
}

async function assignTrips() {
  const { data: posts, error } = await supabase
    .from('fb_posts')
    .select('id, event_date, category, metadata, trip_id')
    .eq('user_id', userId)
    .order('event_date', { ascending: true });

  if (error) { console.error('❌ Fetch failed:', error.message); process.exit(1); }

  const marathons   = posts.filter(p => p.category === '馬拉松');
  const secondaries = posts.filter(p => p.category !== '馬拉松');

  console.log(`📦 馬拉松主貼文: ${marathons.length} 篇`);
  console.log(`📦 次要貼文 (旅遊/登山): ${secondaries.length} 篇`);

  // 每篇次要貼文找最近的馬拉松（同國 + 14天內）
  const assignments = new Map(); // postId -> trip_id

  // 馬拉松自己也要標記 trip_id = 自身 id
  for (const m of marathons) {
    assignments.set(m.id, m.id);
  }

  for (const sec of secondaries) {
    const secCountry = sec.metadata?.country?.trim() ?? null;
    const secDate    = sec.event_date;

    let best = null;
    let bestDays = Infinity;

    for (const m of marathons) {
      const mCountry = m.metadata?.country?.trim() ?? null;
      const days     = daysBetween(secDate, m.event_date);

      const sameCountry = secCountry && mCountry && secCountry === mCountry;
      if (sameCountry && days <= WINDOW_DAYS && days < bestDays) {
        best     = m;
        bestDays = days;
      }
    }

    if (best) {
      assignments.set(sec.id, best.id);
    }
  }

  // 統計
  const grouped = new Map();
  for (const [postId, tripId] of assignments) {
    if (!grouped.has(tripId)) grouped.set(tripId, []);
    grouped.get(tripId).push(postId);
  }
  const multiGroups = [...grouped.values()].filter(g => g.length > 1);
  const unmatched   = secondaries.filter(s => !assignments.has(s.id));

  console.log(`\n✅ 分配結果:`);
  console.log(`  - 有關聯的 trip 組數: ${multiGroups.length}`);
  console.log(`  - 次要貼文成功配對: ${secondaries.length - unmatched.length} 篇`);
  console.log(`  - 次要貼文未配對 (無同國馬拉松): ${unmatched.length} 篇`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 以下 trip 組將被建立:');
    for (const [tripId, members] of grouped) {
      if (members.length < 2) continue;
      const anchor = posts.find(p => p.id === tripId);
      console.log(`\n  🏁 ${anchor?.event_date} ${anchor?.metadata?.country} — ${anchor?.metadata?.race_name || anchor?.metadata?.city || ''}`);
      for (const memberId of members) {
        const p = posts.find(x => x.id === memberId);
        const tag = p?.id === tripId ? '[主]' : '[次]';
        console.log(`    ${tag} [${p?.category}] ${p?.event_date} ${p?.metadata?.country} ${p?.metadata?.city || ''}`);
      }
    }
    if (unmatched.length > 0) {
      console.log('\n  ⚠️  未配對次要貼文:');
      for (const p of unmatched) {
        console.log(`    [${p.category}] ${p.event_date} ${p.metadata?.country || '(無國家)'}`);
      }
    }
    return;
  }

  // 批次寫入
  let updated = 0;
  let errors  = 0;
  const CHUNK = 50;
  const entries = [...assignments.entries()];

  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    for (const [postId, tripId] of chunk) {
      const { error: err } = await supabase
        .from('fb_posts')
        .update({ trip_id: tripId })
        .eq('id', postId)
        .eq('user_id', userId);
      if (err) { console.error(`  ❌ ${postId}: ${err.message}`); errors++; }
      else updated++;
    }
    console.log(`  批次 ${Math.floor(i / CHUNK) + 1}: 已處理 ${Math.min(i + CHUNK, entries.length)} / ${entries.length}`);
  }

  console.log(`\n✅ 完成 — 寫入 ${updated} 筆，失敗 ${errors} 筆`);
}

assignTrips();
