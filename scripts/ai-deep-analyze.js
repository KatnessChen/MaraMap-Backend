const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const INPUT_FILE = path.join(__dirname, '../maramap_final_data.json');
const OUTPUT_FILE = path.join(__dirname, '../maramap_final_data.json');
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('⚠️ Please set the GEMINI_API_KEY environment variable!');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

async function deepAnalyzeLocal() {
  console.log('🏁 Starting LOCAL Deep Analysis (Focus: Davis & Rose)...');

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Input file not found: ${INPUT_FILE}.`);
    return;
  }

  let posts = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  posts.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  console.log(`📊 Analyzing ${posts.length} posts for participant stats...`);

  const BATCH_SIZE = 10;
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    const needsAnalysis = batch.some(p => ['marathon', 'travel', 'training'].includes(p.category));
    
    if (!needsAnalysis) continue;

    console.log(`⏳ Processing batch ${i / BATCH_SIZE + 1}...`);

    const prompt = `
      你是一位台灣馬拉松專家。請精確分析以下貼文，提取 Davis 與 Rose 的賽事數據。
      
      ### 篩選規則：
      1. **僅限主角**：只擷取 Davis (我) 與 Rose (妻子) 的數據。其餘人等(如兒女、跑友)請忽略。
      2. **賽事與里程判定**：
         - 半馬 (HM): 里程約 21K。
         - 全馬 (FM): 里程約 42K~45K。
         - 超馬 (UM): 里程 > 45K (例如 50K, 100K)。
      3. **次數提取 (方案 A)**：
         - 請尋找內文中提到的「第 X 馬」、「第 X 場半馬」等關鍵字。
      
      回傳格式 (JSON): 
      [{"id": "...", "metadata": { "participants": [
        {
          "name": "Davis|Rose", 
          "distance": "全馬|半馬|超馬", 
          "time": "H:MM:SS",
          "stats": {
            "distance_km": 數字|null,
            "FM_count": 數字|null, 
            "HM_count": 數字|null, 
            "UM_count": 數字|null
          }
        }
      ]}}]
      
      貼文列表:
      ${JSON.stringify(batch.map((p, idx) => ({ id: i + idx, title: p.title, content: p.text, date: p.date })))}
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const responseText = response.text();

      const match = responseText.match(/\[[\s\S]*\]/);
      if (match) {
        const results = JSON.parse(match[0]);
        results.forEach(item => {
          const index = parseInt(item.id);
          if (posts[index]) {
            if (!posts[index].metadata) posts[index].metadata = {};
            // 覆蓋 participants
            posts[index].metadata.participants = item.metadata.participants;
          }
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (err) {
      console.error(`❌ Error in batch ${i / BATCH_SIZE + 1}:`, err.message);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(posts, null, 2));
  console.log(`✅ Local Deep Analysis complete! Final data saved to: ${OUTPUT_FILE}`);
}

deepAnalyzeLocal();
