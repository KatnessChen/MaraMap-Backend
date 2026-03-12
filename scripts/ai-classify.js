const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const INPUT_FILE = path.join(__dirname, '../marathon_gps_data.json');
const OUTPUT_FILE = path.join(__dirname, '../maramap_final_data.json');
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('⚠️ Please set the GEMINI_API_KEY environment variable!');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

async function classifyPosts() {
  console.log('🧠 Starting AI Classification Engine...');

  try {
    if (!fs.existsSync(INPUT_FILE)) {
      throw new Error(`Input file not found: ${INPUT_FILE}`);
    }

    const rawData = fs.readFileSync(INPUT_FILE, 'utf8');
    const posts = JSON.parse(rawData);
    const results = [];

    // Process in batches of 40 to minimize API calls and stay within daily quotas
    const BATCH_SIZE = 40;
    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      const batch = posts.slice(i, i + BATCH_SIZE);
      console.log(`⏳ Processing items ${i + 1} to ${Math.min(i + BATCH_SIZE, posts.length)}...`);

      // Rate limiting delay (5 seconds)
      if (i > 0) {
        console.log('💤 Waiting 5 seconds to comply with rate limits...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      const prompt = `
        你是一位馬拉松與旅遊專家。請根據以下貼文列表，判讀每篇的主題分類。
        請回傳一組 JSON 數組，格式為: [{"category": "馬拉松|旅遊|跑步訓練|日常生活", "tags": ["關鍵字1"]}]
        
        重要規則：
        1. 馬拉松 (marathon): 正式的馬拉松賽事 (通常有完賽時間、第幾馬、號碼布、破紀錄等資訊)。
        2. 跑步訓練 (training): 日常練習跑、自主訓練。
        3. 旅遊 (travel): 出國旅遊、參觀景點、飛機、飯店、不包含跑步內容。
        4. 日常生活 (daily): 祝人生日快樂、吃飯、開會等日常瑣事。
        5. 如果文字太少或標題模糊（如「分享了 1 則貼文」）導致無法判讀，請直接將 category 設為 "日常生活" 即可。
        6. **請務必只回傳 JSON 內容，不要包含任何開場白或解釋。**
        7. 必須回傳與傳入數量相同的 JSON 元素。

        貼文列表:
        ${JSON.stringify(batch.map((p, idx) => ({ id: i + idx, text: p.text, title: p.title })))}
      `;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const responseText = response.text();
      
      // Extract the JSON array from the response string
      const match = responseText.match(/\[[\s\S]*\]/);
      if (!match) {
        throw new Error(`Invalid AI response format: ${responseText}`);
      }
      const cleanJson = match[0].trim();
      const classifications = JSON.parse(cleanJson);

      // Merge classifications with original data
      batch.forEach((post, idx) => {
        results.push({
          ...post,
          category: classifications[idx].category,
          tags: classifications[idx].tags
        });
      });
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`✅ AI Classification complete! Final data saved to: ${OUTPUT_FILE}`);
    console.log(`📊 Categorized ${results.length} posts.`);

  } catch (error) {
    console.error('❌ AI Processing Error:', error.message);
  }
}

classifyPosts();
