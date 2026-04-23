const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const INPUT_FILE = path.join(
  __dirname,
  '../../02_classify/output/classified.json',
);
const OUTPUT_FILE = path.join(__dirname, './output/marathon.json');
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('⚠️  Please set the GEMINI_API_KEY environment variable!');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

// Output: delta array — [{timestamp, metadata: {race_name, participants}}]
async function analyzeMarathon() {
  console.log(
    '🏁 Starting MARATHON analysis (race_name, participants, is_pb)...',
  );

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ classified.json not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const allPosts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const posts = allPosts
    .filter((p) => p.category === '馬拉松')
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  console.log(`📊 Found ${posts.length} marathon posts to analyze...`);

  const deltas = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    console.log(
      `⏳ Batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(posts.length / BATCH_SIZE)}`,
    );

    if (i > 0) await new Promise((r) => setTimeout(r, 2000));

    const prompt = `
      你是一位來自台灣、到全世界告地跑馬拉松的專家。請精確分析以下貼文，提取「自己」（文章中的第一人稱，Davis）與「老婆」（Rose）的賽事數據。

      ### 篩選規則：
      1. **僅限主角**：只擷取 Davis 與 Rose 的數據。其餘人（兒女、跑友）請忽略。
      2. **賽事與里程判定**：
         - 半馬 (HM): 里程約 21K。
         - 全馬 (FM): 里程約 42K~43K。
         - 超馬 (UM): 里程 > 43K（如 44K、50K、100K）。
      3. **次數提取**：以下四個欄位各自獨立，同一篇貼文可以同時有多個值（例如「第200馬」且「海外第50馬」→ FM_count: 200, foreign_count: 50）：
         - FM_count：「第 X 馬」中的 X（全馬累積總場次，含國內外）
         - HM_count：「第 X 場半馬」中的 X（半馬累積總場次）
         - UM_count：「第 X 場超馬」中的 X（超馬累積總場次）
         - foreign_count：「海外第 X 馬」中的 X（海外馬拉松累積場次）
      4. **is_pb 判定**：
         - 貼文提到「PB」、「PR」、「個人最佳」、「破紀錄」、「破記錄」、「新紀錄」、「新記錄」、「最快」→ is_pb: true。
         - 否則 → is_pb: false。
      5. **race_name 提取**：從標題或內文提取正式賽事名稱（如「台北馬拉松」、「東京馬拉松」）。無法判斷時設為 null。

      回傳格式 (JSON array，長度必須等於輸入數量):
      [{
        "race_name": "賽事名稱|null",
        "participants": [
          {
            "name": "Davis|Rose",
            "distance": "全馬|半馬|超馬",
            "time": "H:MM:SS|null",
            "is_pb": true|false,
            "stats": {
              "distance_km": 數字|null,
              "FM_count": 數字|null,
              "HM_count": 數字|null,
              "UM_count": 數字|null,
              "foreign_count": 數字|null
            }
          }
        ]
      }]

      只回傳 JSON，不要任何解釋。

      貼文列表:
      ${JSON.stringify(batch.map((p) => ({ title: p.title, content: p.text, date: p.date })))}
    `;

    try {
      let results;
      const MAX_RETRIES = 5;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();
          const match = responseText.match(/\[[\s\S]*\]/);
          if (!match) throw new Error('Invalid response format');
          results = JSON.parse(match[0]);
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
        const item = results[idx];
        if (!item) return;
        deltas.push({
          timestamp: post.timestamp,
          metadata: {
            race_name: item.race_name || null,
            participants: item.participants || [],
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
    `✅ Marathon analysis complete — ${deltas.length} deltas saved to ${OUTPUT_FILE}`,
  );
}

analyzeMarathon();
