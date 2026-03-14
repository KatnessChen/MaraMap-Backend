const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

// --- Configuration ---
const API_KEY = process.env.GEMINI_API_KEY;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

async function extractFinalStats() {
  console.log(
    '🏁 Starting FINAL Data Extraction (Race Stats + Mountain Indices)...',
  );

  const { data: posts, error } = await supabase
    .from('fb_posts')
    .select('id, content, title')
    .in('category', ['marathon', 'travel', 'training']);

  if (error) {
    console.error('❌ Failed to fetch posts:', error.message);
    return;
  }

  console.log(`📊 Found ${posts.length} posts to fully re-analyze.`);

  const BATCH_SIZE = 5;
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    console.log(`⏳ Processing batch ${i / BATCH_SIZE + 1}...`);

    const prompt = `
      你是一位台灣馬拉松成績與登山成就專家。請精確分析以下貼文，提取結構化數據。
      
      ### 規則 1: 跑者與賽事 (PARTICIPANTS)
      - Davis: 發文者(我)，通常跑全馬或超馬。
      - Rose: 妻子/老婆，通常跑 10K 或 21K。
      - 距離格式：42.195K/Full -> "全馬", 21K/Half -> "半馬", 其他 -> "數字+K"。
      - 時間格式：必須為 "H:MM:SS" (例如 3:52:19)。若無時間則為 null。
      - 必須以物件陣列回傳: {"name": "Davis", "distance": "全馬", "time": "3:52:19", "race_count": 221}。
...
      Extract into JSON format:
      {
        "race_name": "...",
        "country": "...",
        "city": "...",
        "participants": [
          { "name": "Davis", "distance": "全馬", "time": "HH:MM:SS", "race_count": 221 },
          { "name": "Rose", "distance": "10K", "time": "HH:MM:SS" }
        ],
        "mountains": [...]
      }
      
      ### 規則 2: 登山成就 (MOUNTAINS)
      - 識別文中提到的山名。
      - 若為「百岳」或「小百岳」，務必查出或提取其【標準編號】(index)。
      - 結構：{"name": "山名", "type": "百岳|小百岳|一般", "index": 數字, "elevation": "海拔"}。

      ### JSON 格式要求:
      回傳陣列: [{"post_id": "...", "metadata": { "race_name": "...", "mountains": [...], "participants": [...] }}]
      
      ### 貼文列表:
      ${JSON.stringify(batch.map((p) => ({ id: p.id, title: p.title, content: p.content })))}
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const responseText = response.text();

      const match = responseText.match(/\[[\s\S]*\]/);
      if (match) {
        const results = JSON.parse(match[0]);
        for (const item of results) {
          // 雙重檢查結構，防止再次覆蓋錯誤
          if (item.metadata && Array.isArray(item.metadata.participants)) {
            await supabase
              .from('fb_posts')
              .update({ metadata: item.metadata })
              .eq('id', item.post_id);
          }
        }
        console.log(
          `✅ Successfully recovered and updated batch ${i / BATCH_SIZE + 1}.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch (err) {
      console.error(`❌ Error in batch ${i / BATCH_SIZE + 1}:`, err.message);
    }
  }
  console.log('🏁 Full recovery and extraction complete!');
}

extractFinalStats();
