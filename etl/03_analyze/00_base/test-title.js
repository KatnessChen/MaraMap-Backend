/**
 * Test title extraction on 10 sampled posts.
 * Usage: node test-title.js
 */
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('⚠️  Please set the GEMINI_API_KEY environment variable!');
  process.exit(1);
}

const INPUT_FILE = path.join(__dirname, '../../02_classify/output/classified.json');
const posts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

// 10 evenly-spaced posts
const step = Math.floor(posts.length / 10);
const sample = Array.from({ length: 10 }, (_, i) => posts[i * step]);

function extractTitle(text) {
  if (!text) return null;

  const bracketMatch = text.match(/^\s*\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1].trim();

  const first = text.split(/[\n。！？!?]/)[0].trim();

  if (first.length > 60) return null;

  const chineseChars = (first.match(/[\u4e00-\u9fff]/g) || []).length;
  if (chineseChars < 4) return null;

  return first.length >= 4 ? first : null;
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

async function run() {
  console.log(`\n${'─'.repeat(70)}`);
  console.log('  Title Extraction Test — 10 posts');
  console.log(`${'─'.repeat(70)}\n`);

  // Pre-extract rule-based titles
  const ruleBasedTitles = new Map();
  sample.forEach(p => {
    const t = extractTitle(p.text);
    if (t) ruleBasedTitles.set(p.timestamp, t);
  });

  const needAI = sample.filter(p => !ruleBasedTitles.has(p.timestamp));
  console.log(`Rule-based: ${ruleBasedTitles.size} / ${sample.length}`);
  console.log(`Need AI:    ${needAI.length} / ${sample.length}\n`);

  // AI titles for the remainder
  const aiTitles = new Map();
  if (needAI.length > 0) {
    const batchInput = needAI.map(p => ({
      text: p.text?.slice(0, 300),
      title: p.title,
      needsTitle: true,
    }));

    const prompt = `
      你是地理與活動資訊專家。請根據以下貼文，提取每篇的所在國家、城市，以及在需要時生成標題。

      回傳格式 (JSON array，長度必須等於輸入數量):
      [{
        "country": "國家（中文）| null",
        "city": "城市或地區（中文）| null",
        "title": "標題（中文）| null"
      }]

      地點規則：
      - 根據貼文內容（賽事地點、旅遊目的地、山岳位置）判斷「已發生」的事件地點，忽略未來計畫。
      - 若在台灣，country 填「台灣」，city 填縣市（如「台北市」、「花蓮縣」）。
      - 無法判斷時填 null。

      標題規則：
      - 若該貼文的 needsTitle 為 false，title 一律回傳 null（不需要生成）。
      - 若該貼文的 needsTitle 為 true，請生成一個 20 字以內的中文標題，需包含地點與事件名稱（例如：「東京馬拉松初體驗」、「玉山主峰攻頂」、「首爾自由行」）。
      - 標題必須根據貼文實際內容生成，不可捏造。

      只回傳 JSON，不要任何解釋。

      貼文列表:
      ${JSON.stringify(batchInput)}
    `;

    const result = await model.generateContent(prompt);
    const match = result.response.text().match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Invalid AI response');
    const aiResults = JSON.parse(match[0]);
    needAI.forEach((p, idx) => {
      if (aiResults[idx]?.title) aiTitles.set(p.timestamp, aiResults[idx].title);
    });
  }

  // Print results
  sample.forEach((p, i) => {
    const ruleTitle = ruleBasedTitles.get(p.timestamp);
    const aiTitle = aiTitles.get(p.timestamp);
    const finalTitle = ruleTitle || aiTitle || '(none)';
    const source = ruleTitle ? '🔤 rule' : aiTitle ? '🤖 AI  ' : '❌ none';

    console.log(`[${String(i + 1).padStart(2)}] ${source}  ${finalTitle}`);
    console.log(`      category: ${p.category} | text: ${p.text?.slice(0, 60)}...`);
    console.log();
  });
}

run().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
