const fs = require('fs');
const path = require('path');

// --- Configuration ---
const ETL_ROOT = path.join(__dirname, '..'); // /app/etl

const BATCH = process.env.BATCH;
if (!BATCH) {
  console.error('❌ Missing BATCH env var. Usage: BATCH=<folder-name> node merge.js');
  process.exit(1);
}

const CLASSIFIED_FILE = path.join(ETL_ROOT, `02_classify/output/${BATCH}/classified.json`);
const OUTPUT_FILE     = path.join(__dirname, `./output/${BATCH}/merged.json`);
fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

const DELTAS = [
  { label: 'base',     file: path.join(ETL_ROOT, `03_analyze/00_base/output/${BATCH}/base.json`),        required: true },
  { label: 'marathon', file: path.join(ETL_ROOT, `03_analyze/01_marathon/output/${BATCH}/marathon.json`), required: false },
  { label: 'hiking',   file: path.join(ETL_ROOT, `03_analyze/02_hiking/output/${BATCH}/hiking.json`),     required: false },
  { label: 'format',   file: path.join(ETL_ROOT, `04_format/output/${BATCH}/format.json`),                required: false },
];

function addPanguSpacing(text) {
  if (!text) return text;
  const CJK = '\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f';
  return text
    .replace(new RegExp(`([${CJK}])([A-Za-z0-9])`, 'g'), '$1 $2')
    .replace(new RegExp(`([A-Za-z0-9])([${CJK}])`, 'g'), '$1 $2')
    .replace(new RegExp(`([${CJK}])([\\(\\[\\{<\\$#])`, 'g'), '$1 $2')
    .replace(new RegExp(`([\\)\\]\\}>])([${CJK}])`, 'g'), '$1 $2');
}

function merge() {
  console.log('🔀 Starting MERGE...');

  if (!fs.existsSync(CLASSIFIED_FILE)) {
    console.error(`❌ classified.json not found: ${CLASSIFIED_FILE}`);
    process.exit(1);
  }

  // 1. classified.json is the base — already filtered (no skip posts)
  const posts = JSON.parse(fs.readFileSync(CLASSIFIED_FILE, 'utf8'));
  const postMap = new Map(posts.map((p) => [String(p.timestamp), p]));
  console.log(`📂 Loaded classified: ${posts.length} posts`);

  // 2. Load deltas
  const deltaData = {};
  for (const { label, file, required } of DELTAS) {
    if (!fs.existsSync(file)) {
      if (required) {
        console.error(`❌ Required delta not found: ${file}`);
        process.exit(1);
      }
      console.warn(`⚠️  Skipping ${label} — file not found: ${file}`);
      deltaData[label] = [];
      continue;
    }
    deltaData[label] = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`📂 Loaded ${label}: ${deltaData[label].length} records`);
  }

  // 3. Build metadata delta maps
  const baseMap = new Map(
    deltaData.base.map((d) => [String(d.timestamp), d.metadata]),
  );
  const marathonMap = new Map(
    deltaData.marathon.map((d) => [String(d.timestamp), d.metadata]),
  );
  const hikingMap = new Map(
    deltaData.hiking.map((d) => [String(d.timestamp), d.metadata]),
  );
  const formatMap = new Map(
    deltaData.format.map((d) => [String(d.timestamp), d]),
  );

  // 4. Assemble final output
  const result = [];
  for (const [key, post] of postMap) {
    const baseMeta = baseMap.get(key) || {};
    const marathonMeta = marathonMap.get(key) || {};
    const hikingMeta = hikingMap.get(key) || {};

    result.push({
      timestamp: post.timestamp,
      date: post.date,
      text: formatMap.get(key)?.text || post.text,
      title: addPanguSpacing(baseMeta.title || formatMap.get(key)?.title || post.title || null),
      category: post.category,
      sub_categories: post.sub_categories || [],
      metadata: {
        continent: baseMeta.continent || null,
        country: baseMeta.country || null,
        city: baseMeta.city || null,
        ...marathonMeta,
        ...hikingMeta,
      },
    });
  }

  // Sort by date ascending
  result.sort((a, b) => new Date(a.date) - new Date(b.date));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(
    `\n📦 Merge complete — ${result.length} posts written to ${OUTPUT_FILE}`,
  );
}

merge();
