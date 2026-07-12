// One-off backfill driver: re-ingest a batch (now including posts/album/*.json),
// then run the AI classify + analyze stages in PARTIAL mode against only the newly
// added album timestamps, then format + merge. Import runs only with --import.
//
// Usage:
//   node etl/rerun-albums.js <BATCH> [--import]
//
// Spawns children with argv arrays (not a shell string) so timestamp lists are
// passed as discrete args — zsh does not word-split unquoted vars, which silently
// turned an earlier "partial" run into a full re-run.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BATCH = process.argv[2];
const doImport = process.argv.includes('--import');
if (!BATCH) {
  console.error('Usage: node etl/rerun-albums.js <BATCH> [--import]');
  process.exit(1);
}

const ETL = __dirname;
const env = { ...process.env, BATCH };

function run(script, args = [], extraEnv = {}) {
  console.log(`\n▶️  ${path.relative(ETL, script)} ${args.join(' ')}`);
  execFileSync('node', [script, ...args], {
    env: { ...env, ...extraEnv },
    stdio: 'inherit',
  });
}

// 1 · Re-ingest (idempotent) — regenerates posts.json/media.json/album_timestamps.json
run(path.join(ETL, '01_ingest/ingest-fb-data.js'));

const albumTs = JSON.parse(
  fs.readFileSync(
    path.join(ETL, `01_ingest/output/${BATCH}/album_timestamps.json`),
    'utf8',
  ),
).map(String);

if (albumTs.length === 0) {
  console.log(`\n✅ ${BATCH}: no album posts — nothing to backfill.`);
  process.exit(0);
}
console.log(`\n📸 ${BATCH}: ${albumTs.length} album timestamp(s) to backfill.`);

// 2 · Classify (partial, merges into classified.json)
run(path.join(ETL, '02_classify/ai-classify.js'), albumTs);

// 3 · Analyze base/marathon/hiking (partial, merge into each delta file)
run(path.join(ETL, '03_analyze/00_base/analyze.js'), albumTs);
run(path.join(ETL, '03_analyze/01_marathon/analyze.js'), albumTs);
run(path.join(ETL, '03_analyze/02_hiking/analyze.js'), albumTs);

// 4 · Format + 5 · Merge (deterministic, no AI — safe to run full)
run(path.join(ETL, '04_format/analyze.js'));
run(path.join(ETL, '05_merge/merge.js'));

// 6 · Import album posts only (ALBUM_ONLY avoids the broken signature dedup —
//     existing rows' DB media URIs are absolute post-R2, local URIs are relative)
// 7 · Upload the new album media to R2 and rewrite their URIs to CDN URLs
//     (idempotent: HeadObject skips files already in R2, only rewrites relative URIs)
if (doImport) {
  run(path.join(ETL, '06_import/import-to-supabase.js'), [], { ALBUM_ONLY: '1' });
  run(path.join(ETL, '../utils/upload-to-r2.js'));
} else {
  console.log(
    `\n🛑 Stopped before import. merged.json is ready at 05_merge/output/${BATCH}/merged.json.` +
    `\n   Re-run with --import to insert the album posts and upload their media to R2.`,
  );
}
