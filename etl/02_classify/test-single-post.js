/**
 * Single-post classification test
 * Usage: GEMINI_API_KEY=xxx node test-single-post.js <timestamp>
 */
const fs = require('fs');
const path = require('path');
const { buildPrompt, callAI } = require('./ai-classify');

const timestamp = parseInt(process.argv[2]);
if (!timestamp) {
  console.error('Usage: node test-single-post.js <timestamp>');
  process.exit(1);
}

const INPUT_FILE = path.join(__dirname, '../01_ingest/output/posts.json');
const posts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
const POST = posts.find((p) => p.timestamp === timestamp);
if (!POST) {
  console.error(`❌ Post with timestamp ${timestamp} not found`);
  process.exit(1);
}

async function testClassify() {
  console.log('🧪 Testing classification for post:', POST.timestamp);
  console.log('─'.repeat(60));
  console.log('Title:', POST.title);
  console.log('Text:', POST.text);
  console.log('─'.repeat(60));

  const responseText = await callAI(buildPrompt([POST], 0));
  const match = responseText.match(/\[[\s\S]*\]/);
  if (!match) {
    console.error('❌ Invalid response format:', responseText);
    process.exit(1);
  }

  const classification = JSON.parse(match[0])[0];
  console.log('\n📊 Classification result:');
  console.log(JSON.stringify(classification, null, 2));
  console.log('─'.repeat(60));
}

testClassify().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
