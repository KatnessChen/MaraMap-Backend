const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const INPUT_FILE = path.join(__dirname, '../../02_classify/output/classified.json');
const OUTPUT_FILE = path.join(__dirname, './output/base.json');
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('⚠️  Please set the GEMINI_API_KEY environment variable!');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

/**
 * Rule-based title extraction (no AI needed).
 * Priority:
 *   1. Text in [...] at the start of the post
 *   2. First sentence / first line
 * Returns null if neither rule produces a usable result.
 */
function extractTitle(text) {
  if (!text) return null;

  // 1. [標題] at the very start of the text
  const bracketMatch = text.match(/^\s*\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1].trim();

  // 2. First sentence (split on newline or Chinese punctuation)
  const first = text.split(/[\n。！？!?]/)[0].trim();

  // Reject if too long — let AI summarise instead
  if (first.length > 60) return null;

  // Reject if fewer than 4 Chinese characters (e.g. pure date/day markers like "114.5.30(五) D9")
  const chineseChars = (first.match(/[\u4e00-\u9fff]/g) || []).length;
  if (chineseChars < 4) return null;

  return first.length >= 4 ? first : null;
}

// Output: delta array — [{timestamp, metadata: {country, city, title}}]
async function analyzeBase() {
  console.log(
    '🌍 Starting BASE analysis (country + city + title for all posts)...',
  );

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const posts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`📊 Processing ${posts.length} posts...`);

  // Pre-extract rule-based titles
  const ruleBasedTitles = new Map();
  let ruleCount = 0;
  posts.forEach((p) => {
    const t = extractTitle(p.text);
    if (t) {
      ruleBasedTitles.set(p.timestamp, t);
      ruleCount++;
    }
  });
  console.log(
    `📝 Rule-based titles extracted: ${ruleCount} / ${posts.length} (remaining ${posts.length - ruleCount} need AI)`,
  );

  const deltas = [];
  const BATCH_SIZE = 40;

  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    console.log(
      `⏳ Batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(posts.length / BATCH_SIZE)}`,
    );

    if (i > 0) await new Promise((r) => setTimeout(r, 5000));

    const batchInput = batch.map((p) => ({
      text: p.text?.slice(0, 300),
      title: p.title,
      needsTitle: !ruleBasedTitles.has(p.timestamp),
    }));

    const prompt = `
      你是地理與活動資訊專家。請根據以下貼文，提取每篇的所在國家、城市，以及在需要時生成標題。

      回傳格式 (JSON array，長度必須等於輸入數量):
      [{
        "continent": "亞洲|歐洲|北美洲|南美洲|非洲|大洋洲|南極洲|null",
        "country": "國家（中文）| null",
        "city": "城市或地區（中文）| null",
        "title": "標題（中文）| null"
      }]

      地點規則：
      - 根據貼文內容（賽事地點、旅遊目的地、山岳位置）判斷「已發生」的事件地點，忽略未來計畫。
      - 若在台灣，continent 填「亞洲」，country 填「台灣」，city 填縣市（如「台北市」、「花蓮縣」）。
      - 無法判斷時填 null。

      標題規則：
      - 若該貼文的 needsTitle 為 false，title 一律回傳 null（不需要生成）。
      - 若該貼文的 needsTitle 為 true，請生成一個 20 字以內的中文標題，需包含地點與事件名稱（例如：「東京馬拉松初體驗」、「玉山主峰攻頂」、「首爾自由行」）。
      - 標題必須根據貼文實際內容生成，不可捏造。

      只回傳 JSON，不要任何解釋。

      貼文列表:
      ${JSON.stringify(batchInput)}
    `;

    try {
      let aiResults;
      const MAX_RETRIES = 5;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();
          const match = responseText.match(/\[[\s\S]*\]/);
          if (!match) throw new Error('Invalid response format');
          aiResults = JSON.parse(match[0]);
          break;
        } catch (err) {
          const is503 = err.message.includes('503') || err.message.includes('Service Unavailable');
          if (attempt < MAX_RETRIES && is503) {
            const wait = attempt * 15;
            console.warn(`⚠️  503 on attempt ${attempt}/${MAX_RETRIES} — retrying in ${wait}s...`);
            await new Promise((r) => setTimeout(r, wait * 1000));
          } else {
            throw err;
          }
        }
      }
      batch.forEach((post, idx) => {
        const ai = aiResults[idx];
        if (!ai) return;

        // Title: rule-based takes priority, fall back to AI
        const title = ruleBasedTitles.get(post.timestamp) || ai.title || null;

        deltas.push({
          timestamp: post.timestamp,
          metadata: {
            continent: ai.continent || null,
            country: ai.country || null,
            city: ai.city || null,
            title,
          },
        });
      });
    } catch (err) {
      console.error(
        `❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} error:`,
        err.message,
      );
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(deltas, null, 2));
  console.log(
    `✅ Base analysis complete — ${deltas.length} deltas saved to ${OUTPUT_FILE}`,
  );
}

analyzeBase();
