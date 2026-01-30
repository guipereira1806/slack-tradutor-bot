require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios'); // Vamos usar o axios que você já tem!

// =================================================================
// 1. CONFIGURAÇÕES GEMINI (Via HTTP/Axios)
// =================================================================

// Limpeza da chave
const rawKey = process.env.GEMINI_API_KEY || '';
const GEMINI_KEY = rawKey.trim().replace(/^["']|["']$/g, '');

// Endpoint direto da API REST do Google (Modelo Flash é rápido e free)
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

const MIN_MESSAGE_LENGTH = 5;

// Mapeamento visual
const LANGUAGE_MAP = {
  EN: { emoji: '🇺🇸', name: 'Inglês' },
  ES: { emoji: '🇪🇸', name: 'Espanhol' },
  'PT-BR': { emoji: '🇧🇷', name: 'Português' }
};

// =================================================================
// 2. INICIALIZAÇÃO SLACK
// =================================================================

const receiver = new ExpressReceiver({ 
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

receiver.app.get('/', (req, res) => res.status(200).send('🤖 Bot Gemini (Axios) está ONLINE!'));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});

// =================================================================
// 3. FUNÇÃO DE TRADUÇÃO (CHAMADA DIRETA)
// =================================================================

async function translateWithGemini(text) {
  try {
    // Prompt que ensina o Gemini a ser um tradutor JSON
    const promptText = `
      You are a translation bot.
      Task:
      1. Detect source language of: "${text}".
      2. If source is Portuguese, translate to English (EN) and Spanish (ES).
      3. If source is English, translate to Portuguese (PT-BR) and Spanish (ES).
      4. If source is Spanish, translate to Portuguese (PT-BR) and English (EN).
      
      Output requirement:
      Return ONLY valid JSON. No markdown formatting. No \`\`\` code blocks.
      Format:
      {
        "sourceLang": "CODE",
        "translations": [
          { "lang": "CODE", "text": "TRANSLATED_TEXT" },
          { "lang": "CODE", "text": "TRANSLATED_TEXT" }
        ]
      }
    `;

    // Chamada HTTP para o Google
    const response = await axios.post(GEMINI_URL, {
      contents: [{
        parts: [{ text: promptText }]
      }]
    }, { 
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    // Extraindo a resposta do JSON complexo do Google
    const candidate = response.data.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      throw new Error("Resposta vazia do Gemini");
    }

    let rawText = candidate.content.parts[0].text;

    // Limpeza de segurança (caso a IA mande blocos de código markdown)
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    return JSON.parse(rawText);

  } catch (error) {
    console.error("Erro na chamada Gemini:", error.response ? error.response.data : error.message);
    return null; // Retorna nulo para não quebrar o bot
  }
}

// =================================================================
// 4. LISTENER DE MENSAGENS
// =================================================================

app.message(async ({ message, say }) => {
  // Filtros: Ignora threads, bots e mensagens curtas
  if (message.thread_ts) return; 
  if (message.subtype === 'bot_message' || message.bot_id) return;
  if (!message.text) return;

  const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
  if (cleanText.length < MIN_MESSAGE_LENGTH) return;

  try {
    // Chama o Gemini
    const result = await translateWithGemini(cleanText);

    // Se falhar ou não tiver traduções, não faz nada (silêncio)
    if (!result || !result.translations || result.translations.length === 0) return;

    // Configura infos do idioma original
    const sourceCode = result.sourceLang === 'PT' ? 'PT-BR' : result.sourceLang;
    const sourceInfo = LANGUAGE_MAP[sourceCode] || { emoji: '🌐', name: sourceCode };

    // Monta a resposta bonita
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '✨ Tradução', emoji: true }
      },
      { type: 'divider' }
    ];

    result.translations.forEach(t => {
      const langCode = t.lang === 'PT' ? 'PT-BR' : t.lang;
      const info = LANGUAGE_MAP[langCode] || { emoji: '🏳️', name: langCode };
      
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${info.emoji} *${info.name}*:\n${t.text}` }
      });
    });

    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn', 
        text: `🔠 Original: ${sourceInfo.emoji} ${sourceInfo.name} | _via Gemini_`
      }]
    });

    await say({
      thread_ts: message.ts,
      blocks: blocks,
      text: `Tradução disponível`
    });

  } catch (error) {
    console.error('Erro no handler:', error);
  }
});

// =================================================================
// 5. INICIALIZAÇÃO
// =================================================================

(async () => {
  const port = process.env.PORT || 3000;
  await app.start({ port, host: '0.0.0.0' });
  console.log(`🚀 Bot Gemini (Axios) rodando na porta ${port}!`);
})();
