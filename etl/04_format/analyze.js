const fs = require('fs');
const path = require('path');

const BATCH = process.env.BATCH;
if (!BATCH) {
  console.error('❌ Missing BATCH env var. Usage: BATCH=<folder-name> node analyze.js');
  process.exit(1);
}
const INPUT_FILE = path.join(__dirname, `../02_classify/output/${BATCH}/classified.json`);
const BASE_FILE  = path.join(__dirname, `../03_analyze/00_base/output/${BATCH}/base.json`);
const OUTPUT_FILE = path.join(__dirname, `./output/${BATCH}/format.json`);
fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

/**
 * Add a half-width space between half-width (ASCII) and full-width (CJK) characters.
 * Follows the "pangu" typography convention for Chinese text readability.
 */
function addPanguSpacing(text) {
  if (!text) return text;

  const CJK = '\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f';

  return text
    // CJK → ASCII (letters, digits)
    .replace(new RegExp(`([${CJK}])([A-Za-z0-9])`, 'g'), '$1 $2')
    // ASCII (letters, digits) → CJK
    .replace(new RegExp(`([A-Za-z0-9])([${CJK}])`, 'g'), '$1 $2')
    // CJK → half-width opening brackets/symbols: ( [ { < % $ #
    .replace(new RegExp(`([${CJK}])([\\(\\[\\{<\\$#])`, 'g'), '$1 $2')
    // half-width closing brackets → CJK: ) ] } >
    .replace(new RegExp(`([\\)\\]\\}>])([${CJK}])`, 'g'), '$1 $2');
}

function formatPosts() {
  console.log('✏️  Starting FORMAT analysis (pangu spacing)...');

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  if (!fs.existsSync(BASE_FILE)) {
    console.error(`❌ Base file not found: ${BASE_FILE}`);
    process.exit(1);
  }

  const posts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const baseRecords = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'));
  const baseMap = new Map(baseRecords.map(d => [String(d.timestamp), d.metadata]));

  console.log(`📊 Formatting ${posts.length} posts...`);

  const deltas = posts.map((p) => {
    const baseMeta = baseMap.get(String(p.timestamp)) || {};
    const title = baseMeta.title || p.title || null;
    return {
      timestamp: p.timestamp,
      text: addPanguSpacing(p.text),
      title: addPanguSpacing(title),
    };
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(deltas, null, 2));
  console.log(`✅ Format complete — ${deltas.length} deltas saved to ${OUTPUT_FILE}`);
}

formatPosts();
