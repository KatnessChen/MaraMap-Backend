const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const INPUT_FILE = path.join(__dirname, '../01_ingest/output/posts.json');
const OUTPUT_FILE = path.join(__dirname, './output/classified.json');
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('⚠️ Please set the GEMINI_API_KEY environment variable!');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// --- Partial re-run: node ai-classify.js 1755792563 1743792778 ...
const TARGET_TIMESTAMPS = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => !isNaN(n));
const isPartialRun = TARGET_TIMESTAMPS.length > 0;

// --- Prompt ---
function buildPrompt(batch, batchOffset) {
  return `
    你是一位馬拉松、登山與旅遊專家。請根據以下貼文列表判讀每篇的主題分類。
    回傳 JSON 數組（長度必須等於輸入數量）：
    [{ "category": "馬拉松|旅遊|登山|skip", "sub_categories": [] }]

    === CATEGORY 定義 ===

    1. 馬拉松：作者本人親身完成正式賽事，且文中有至少 3 個句子詳細描述賽事過程（賽道、補給、配速、心情、天氣等）。

    2. 旅遊：出國或國內旅遊行程紀錄，含練習跑、自主訓練、非正式比賽。

    【馬拉松 vs 旅遊 決策流程】（按順序判斷，第一個符合的就採用）：
    STEP 1: 文章是否為多天行程日記（有 D1, D2, D3... 或「第一天」「第二天」格式）？
      → 是：計算賽事描述的行數。若賽事只有 1~3 行（只提時間/成績），其餘都是景點 → 旅遊
      → 是：若賽事描述有 5 行以上詳細過程（賽道、補給等）→ 馬拉松
    STEP 2: 文章不是多天日記，而是以賽事為主的單篇記錄，且有詳細完賽過程描述 → 馬拉松
    STEP 3: 其餘含有旅遊內容的 → 旅遊

    3. 登山：作者本人完成登頂，文中有明確的已完成登頂紀錄。

    4. skip：不屬於以上任何類別（見下方規則）。

    === 一定要 skip 的情況（即使內容提到馬拉松/登山/旅遊）===
    - 生日祝賀、生日感謝文
    - 年度回顧/總結/感想/全年摘要（含回顧+展望混合文）
    - 年度計畫、新年新希望、心願清單、夢想清單
    - 整篇主旨為未來計畫（整篇都是未來式才 skip，文末附帶提下一場不算）
    - 里程碑感言/豐功偉業回顧（以累積成就統計為主旨，無具體新賽事紀錄）
    - 對過去賽事的純感想/心得/評論（無本次具體完賽成績）
    - 事後補記類：這場賽事已在其他貼文記錄過，這篇只是補充購買照片、購買紀念品、收到獎牌/成績單。判斷特徵：「向XX公司購買XX馬拉松的照片」「買了XX的照片留念」「收到成績單」→ 一律 skip
    - 吃飯、開會、生活瑣事、節日問候
    - 轉發他人貼文、分享外部連結、賽事資訊列表

    === sub_categories 規則 ===

    category 為「馬拉松」時：
    - "海外馬"：賽事在台灣以外（必填其一）
    - "國內馬"：賽事在台灣（必填其一）
    - "普查"：AIMS/WA/IAAF 認證計時賽道（或文中提及「普查承認」）
    - "超馬"：賽事距離 44K（含）以上（含超馬、50K、100K 等）
    - "高山馬"：賽道位於高海拔山區（如合歡山馬、阿里山馬、梨山馬、太平山馬等）。判斷關鍵字：「高山馬」「山區賽道」「海拔XXXm起跑」「高山馬拉松」
    - "七大馬"：世界七大馬拉松之一（東京、波士頓、倫敦、柏林、芝加哥、紐約、雪梨）
    - 可同時多個，例如 ["海外馬", "超馬", "高山馬"]

    category 為「登山」時（三選一）：
    - "大百岳"：文中明確提到「大百岳」且已完成登頂
    - "小百岳"：文中明確提到「小百岳」且已完成登頂
    - "海外登山"：登山地點不在台灣（如富士山、喜馬拉雅等）
    - 只能選一個，不可同時多個

    其他 category 回傳 []

    === 其他規則 ===
    - 文字太少或標題模糊無法判讀 → skip
    - 只回傳 JSON，不要任何解釋
    - 必須回傳與傳入數量相同的 JSON 元素

    貼文列表:
    ${JSON.stringify(batch.map((p, idx) => ({ id: batchOffset + idx, text: p.text, title: p.title })))}
  `;
}

// --- Core AI call with retry ---
async function callAI(prompt) {
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      return responseText;
    } catch (err) {
      const is503 =
        err.message.includes('503') ||
        err.message.includes('Service Unavailable');
      if (attempt < MAX_RETRIES && is503) {
        const wait = attempt * 15;
        console.warn(
          `⚠️  503 on attempt ${attempt}/${MAX_RETRIES} — retrying in ${wait}s...`,
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
      } else {
        throw err;
      }
    }
  }
}

async function classifyPosts() {
  if (isPartialRun) {
    console.log(
      `🔁 Partial re-run mode — ${TARGET_TIMESTAMPS.length} timestamps: ${TARGET_TIMESTAMPS.join(', ')}`,
    );
  } else {
    console.log('🧠 Starting AI Classification Engine (full run)...');
  }

  try {
    if (!fs.existsSync(INPUT_FILE)) {
      throw new Error(`Input file not found: ${INPUT_FILE}`);
    }

    const allPosts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

    // Determine which posts to process
    const postsToProcess = isPartialRun
      ? allPosts.filter((p) => TARGET_TIMESTAMPS.includes(p.timestamp))
      : allPosts;

    if (isPartialRun && postsToProcess.length !== TARGET_TIMESTAMPS.length) {
      const found = postsToProcess.map((p) => p.timestamp);
      const missing = TARGET_TIMESTAMPS.filter((ts) => !found.includes(ts));
      console.warn(
        `⚠️  Timestamps not found in posts.json: ${missing.join(', ')}`,
      );
    }

    console.log(`📊 Processing ${postsToProcess.length} posts...`);

    const newResults = [];
    const skipQueue = []; // posts that were classified as skip — pending review
    const BATCH_SIZE = 5;

    // --- Pass 1: classify ---
    for (let i = 0; i < postsToProcess.length; i += BATCH_SIZE) {
      const batch = postsToProcess.slice(i, i + BATCH_SIZE);
      console.log(
        `⏳ Processing items ${i + 1} to ${Math.min(i + BATCH_SIZE, postsToProcess.length)}...`,
      );

      if (i > 0) {
        console.log('💤 Waiting 5 seconds...');
        await new Promise((r) => setTimeout(r, 5000));
      }

      let classifications;
      try {
        const responseText = await callAI(buildPrompt(batch, i));
        const match = responseText.match(/\[[\s\S]*\]/);
        if (!match)
          throw new Error(`Invalid AI response format: ${responseText}`);
        classifications = JSON.parse(match[0].trim());
      } catch (err) {
        console.error(
          `❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} error:`,
          err.message,
        );
        continue;
      }

      if (classifications.length !== batch.length) {
        console.warn(
          `⚠️  AI returned ${classifications.length} items, expected ${batch.length}`,
        );
      }

      batch.forEach((post, idx) => {
        const cls = classifications[idx];
        if (!cls) {
          console.warn(
            `⚠️  No classification for ${post.timestamp} — queuing for review`,
          );
          skipQueue.push(post);
          return;
        }
        if (cls.category === 'skip') {
          skipQueue.push(post);
          return;
        }
        newResults.push({
          timestamp: post.timestamp,
          date: post.date,
          text: post.text,
          title: post.title,
          category: cls.category,
          sub_categories: cls.sub_categories || [],
        });
      });
    }

    // --- Pass 2: review skip queue one by one ---
    if (skipQueue.length > 0) {
      console.log(`\n🔍 Reviewing ${skipQueue.length} skipped posts...`);
      for (let i = 0; i < skipQueue.length; i++) {
        const post = skipQueue[i];
        console.log(
          `  [${i + 1}/${skipQueue.length}] Reviewing ${post.timestamp}...`,
        );

        await new Promise((r) => setTimeout(r, 3000));

        try {
          const responseText = await callAI(buildPrompt([post], 0));
          const match = responseText.match(/\[[\s\S]*\]/);
          if (!match) throw new Error('Invalid review response');
          const review = JSON.parse(match[0].trim())[0];

          if (review && review.category !== 'skip') {
            console.log(`  ✅ Rescued: ${post.timestamp} → ${review.category}`);
            newResults.push({
              timestamp: post.timestamp,
              date: post.date,
              text: post.text,
              title: post.title,
              category: review.category,
              sub_categories: review.sub_categories || [],
            });
          } else {
            console.log(`  ⏭️  Confirmed skip: ${post.timestamp}`);
          }
        } catch (err) {
          console.error(
            `  ❌ Review error for ${post.timestamp}:`,
            err.message,
          );
        }
      }
    }

    // --- Merge with existing classified.json (partial run) ---
    let finalResults;
    if (isPartialRun && fs.existsSync(OUTPUT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      const updatedTs = new Set(newResults.map((p) => p.timestamp));
      // Remove old entries for re-classified timestamps, then append new ones
      const kept = existing.filter(
        (p) => !TARGET_TIMESTAMPS.includes(p.timestamp),
      );
      finalResults = [...kept, ...newResults].sort(
        (a, b) => new Date(a.date) - new Date(b.date),
      );
      console.log(
        `\n🔀 Merged: ${kept.length} existing + ${newResults.length} re-classified = ${finalResults.length} total`,
      );
    } else {
      finalResults = newResults.sort(
        (a, b) => new Date(a.date) - new Date(b.date),
      );
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalResults, null, 2));
    console.log(
      `\n✅ Classification complete — ${finalResults.length} posts saved to ${OUTPUT_FILE}`,
    );
    console.log(
      `📊 This run: ${newResults.length} classified, ${skipQueue.length} reviewed (${skipQueue.length - (newResults.length - (isPartialRun ? 0 : 0))} confirmed skip)`,
    );
  } catch (error) {
    console.error('❌ AI Processing Error:', error.message);
  }
}

// Allow importing without auto-running
if (require.main === module) {
  classifyPosts();
}

module.exports = { buildPrompt, callAI };
