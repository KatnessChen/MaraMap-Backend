const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const BATCH = process.env.BATCH;
if (!BATCH) {
  console.error('❌ Missing BATCH env var. Usage: BATCH=<folder-name> node analyze.js');
  process.exit(1);
}
const INPUT_FILE = path.join(
  __dirname,
  `../../02_classify/output/${BATCH}/classified.json`,
);
const OUTPUT_FILE = path.join(__dirname, `./output/${BATCH}/hiking.json`);
fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('⚠️  Please set the GEMINI_API_KEY environment variable!');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// --- Partial re-run: node analyze.js <ts1> <ts2> ... — process only these
// timestamps and merge into the existing delta file (mirrors 02_classify).
const TARGET_TIMESTAMPS = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => !isNaN(n));
const isPartialRun = TARGET_TIMESTAMPS.length > 0;

// Output: delta array — [{timestamp, metadata: {mountain_name, peak_number, elevation_m}}]
async function analyzeHiking() {
  console.log(
    '🏔️  Starting HIKING analysis (mountain_name, peak_number, elevation)...',
  );

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ classified.json not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const allPosts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const posts = allPosts
    .filter((p) => p.category === '登山')
    .filter((p) => !isPartialRun || TARGET_TIMESTAMPS.includes(p.timestamp))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (isPartialRun) {
    console.log(
      `🔁 Partial re-run — ${TARGET_TIMESTAMPS.length} target(s), ${posts.length} classified as 登山`,
    );
  }
  console.log(`📊 Found ${posts.length} hiking posts to analyze...`);

  const deltas = [];
  const BATCH_SIZE = 20;

  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    console.log(
      `⏳ Batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(posts.length / BATCH_SIZE)}`,
    );

    if (i > 0) await new Promise((r) => setTimeout(r, 3000));

    const prompt = `
      你是台灣山岳專家。請分析以下登山貼文，提取山岳資訊。

      回傳格式 (JSON array，長度必須等於輸入數量):
      [{
        "mountain_name": "山名（中文）|null",
        "peak_number": 數字|null,
        "elevation_m": 數字|null
      }]

      規則：
      - mountain_name: 從文中提取最主要的山岳名稱（如「玉山」、「雪山」）。
      - peak_number: 山岳在大百岳或小百岳名單中的官方編號（如「百岳編號34」「小百岳編號4」中的數字），不是當事人攀爬的第幾座。判斷順序（依序執行，第一個成立就採用）：
        STEP 1: 文中是否明確寫出編號（如「百岳編號34」「小百岳編號4」）？→ 是：直接採用文中數字。
        STEP 2: 文中未寫出編號 → 根據你對台灣百岳/小百岳官方名單的知識，用 mountain_name 查出正確編號。
        STEP 3: 連山名都無法確定、或不在百岳/小百岳名單中 → null。
      - elevation_m: 文中提到的海拔高度（公尺數字，去掉單位）。無則 null。
      - 只回傳 JSON，不要任何解釋。

      貼文列表:
      ${JSON.stringify(batch.map((p) => ({ title: p.title, content: p.text?.slice(0, 1200) })))}
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
      batch.forEach((post, idx) => {
        const item = results[idx];
        if (!item) return;
        deltas.push({
          timestamp: post.timestamp,
          metadata: {
            mountain_name: item.mountain_name || null,
            peak_number: item.peak_number || null,
            elevation_m: item.elevation_m || null,
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

  let finalDeltas = deltas;
  if (isPartialRun && fs.existsSync(OUTPUT_FILE)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    const kept = existing.filter(
      (d) => !TARGET_TIMESTAMPS.includes(d.timestamp),
    );
    finalDeltas = [...kept, ...deltas];
    console.log(
      `🔀 Merged: ${kept.length} existing + ${deltas.length} re-analyzed = ${finalDeltas.length} total`,
    );
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalDeltas, null, 2));
  console.log(
    `✅ Hiking analysis complete — ${finalDeltas.length} deltas saved to ${OUTPUT_FILE}`,
  );
}

analyzeHiking();
