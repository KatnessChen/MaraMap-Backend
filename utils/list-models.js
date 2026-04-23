const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    console.error('⚠️ GEMINI_API_KEY not found in environment.');
    return;
  }

  const genAI = new GoogleGenerativeAI(API_KEY);
  
  try {
    // Standard fetch to list models via API
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
    const data = await response.json();
    
    console.log('--- Available Models List ---');
    if (data.models) {
      data.models.forEach(m => console.log(`Model: ${m.name} (${m.displayName})`));
    } else {
      console.log('⚠️ No models found:', data);
    }
  } catch (error) {
    console.error('❌ Failed to list models:', error.message);
  }
}

listModels();
