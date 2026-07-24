const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.USER_ID;
const DRY_RUN = process.argv.includes('--dry-run');
// Posts that already carry fallback coordinates are left alone: re-resolving
// them costs a live Nominatim query each (rate-limited to ~1/s) and normally
// writes back the identical coordinate. Pass --refresh to redo them anyway,
// e.g. after correcting a batch's country/city metadata.
const REFRESH = process.argv.includes('--refresh');

if (!supabaseUrl || !supabaseKey || !userId) {
  console.error('❌ Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or USER_ID');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Nominatim usage policy: max 1 req/s, identify ourselves via User-Agent.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'MaraMap-geocode-fallback/1.0 (personal project, single-run batch job)';
const RATE_LIMIT_MS = 1100;

function hasRealGeo(media) {
  return (media || []).some(
    (m) => m.lat !== null && m.lng !== null && !isNaN(m.lat) && !isNaN(m.lng),
  );
}

function hasFallback(metadata) {
  const m = metadata || {};
  return (
    m.fallback_lat !== undefined &&
    m.fallback_lat !== null &&
    m.fallback_lng !== undefined &&
    m.fallback_lng !== null
  );
}

// In-memory only for this run — no persistent cache file (see plan: future
// batches will mostly already have real GPS, so a durable cache isn't worth
// the extra complexity).
const queryCache = new Map();

async function geocode(query) {
  if (!query) return null;
  if (queryCache.has(query)) return queryCache.get(query);

  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));

  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();
    const hit = results[0]
      ? { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) }
      : null;
    queryCache.set(query, hit);
    return hit;
  } catch (err) {
    console.warn(`  ⚠️  Geocode failed for "${query}": ${err.message}`);
    queryCache.set(query, null);
    return null;
  }
}

async function main() {
  console.log('🌍 Starting geocode fallback for posts without real GPS...');

  const { data: posts, error } = await supabase
    .from('fb_posts')
    .select('id, category, metadata, media, trip_id')
    .eq('user_id', userId);
  if (error) {
    console.error('❌ Failed to fetch posts:', error.message);
    process.exit(1);
  }

  const noGeo = posts.filter((p) => !hasRealGeo(p.media));
  const alreadyResolved = noGeo.filter((p) => hasFallback(p.metadata));
  // The trip-sibling layer below still reads every post, so scoping the work
  // this way can't degrade a new post's result — it only stops us re-deriving
  // answers we already have.
  const todo = REFRESH ? noGeo : noGeo.filter((p) => !hasFallback(p.metadata));
  console.log(`📊 ${posts.length} total posts, ${noGeo.length} without real GPS`);
  console.log(
    REFRESH
      ? `🔄 --refresh: re-resolving all ${todo.length} of them`
      : `🎯 ${todo.length} still need coordinates (${alreadyResolved.length} already have fallback, skipped)`,
  );

  // Build trip_id -> representative real-GPS coordinate (layer 2 source)
  const tripCoord = new Map();
  posts.forEach((p) => {
    if (!p.trip_id || tripCoord.has(p.trip_id)) return;
    const rep = (p.media || []).find(
      (m) => m.lat !== null && m.lng !== null && !isNaN(m.lat) && !isNaN(m.lng),
    );
    if (rep) tripCoord.set(p.trip_id, { lat: rep.lat, lng: rep.lng });
  });

  const results = []; // { id, lat, lng, source }
  const stats = { venue: 0, trip: 0, city: 0, unresolved: 0 };

  for (const post of todo) {
    const meta = post.metadata || {};
    let coord = null;
    let source = null;

    // Layer 1 (highest precision): venue name — race_name for marathons,
    // mountain_name for hiking posts.
    if (post.category === '馬拉松' && meta.race_name) {
      coord = await geocode(`${meta.race_name} ${meta.country || ''}`.trim());
      if (coord) source = 'race_name';
    } else if (post.category === '登山' && meta.mountain_name) {
      coord = await geocode(`${meta.mountain_name} ${meta.country || '台灣'}`.trim());
      if (coord) source = 'mountain_name';
    }

    // Layer 2: same-trip sibling that has real GPS.
    if (!coord && post.trip_id && tripCoord.has(post.trip_id)) {
      coord = tripCoord.get(post.trip_id);
      source = 'trip_sibling';
    }

    // Layer 3 (broadest fallback): city + country text.
    if (!coord && (meta.city || meta.country)) {
      coord = await geocode(`${meta.city || ''} ${meta.country || ''}`.trim());
      if (coord) source = 'city_country';
    }

    if (coord) {
      results.push({ id: post.id, lat: coord.lat, lng: coord.lng, source });
      stats[source === 'trip_sibling' ? 'trip' : source === 'city_country' ? 'city' : 'venue']++;
    } else {
      stats.unresolved++;
    }
  }

  console.log('\n📈 Resolution breakdown:');
  console.log(`  venue (race/mountain name): ${stats.venue}`);
  console.log(`  trip sibling:               ${stats.trip}`);
  console.log(`  city/country:                ${stats.city}`);
  console.log(`  unresolved:                  ${stats.unresolved}`);
  console.log(`  Nominatim queries made:      ${queryCache.size} (deduped)`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Sample results:');
    results.slice(0, 15).forEach((r) =>
      console.log(`  ${r.id} -> (${r.lat}, ${r.lng}) via ${r.source}`),
    );
    return;
  }

  console.log('\n💾 Writing fallback coordinates to Supabase...');
  let updated = 0;
  let failed = 0;
  let unchanged = 0;
  for (const r of results) {
    const post = posts.find((p) => p.id === r.id);
    // Under --refresh a re-resolved post usually lands on the same coordinate;
    // writing it back would only churn the row.
    if (
      post.metadata &&
      post.metadata.fallback_lat === r.lat &&
      post.metadata.fallback_lng === r.lng
    ) {
      unchanged++;
      continue;
    }
    const newMetadata = { ...(post.metadata || {}), fallback_lat: r.lat, fallback_lng: r.lng };
    const { error: err } = await supabase
      .from('fb_posts')
      .update({ metadata: newMetadata })
      .eq('id', r.id)
      .eq('user_id', userId);
    if (err) {
      console.error(`  ❌ ${r.id}: ${err.message}`);
      failed++;
    } else {
      updated++;
    }
  }

  console.log(
    `\n✅ Done — updated ${updated} posts, ${unchanged} unchanged, ${failed} failed, ${stats.unresolved} left unresolved.`,
  );
}

main();
