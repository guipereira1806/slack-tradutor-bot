require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// =================================================================
// 1. CONFIGURAÇÕES GEMINI (MODELO STANDARD / PRO)
// =================================================================

const rawKey = process.env.GEMINI_API_KEY || '';
const GEMINI_KEY = rawKey.trim().replace(/^["']|["']$/g, '');

/**
 * SOLUÇÃO DEFINITIVA:
 * Mudamos para 'gemini-pro'.
 * Este modelo é universal e funciona em qualquer conta Google AI Studio.
 */
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`;

const MIN_MESSAGE_LENGTH = 5;

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

receiver.app.get('/', (req, res) => res.status(200).send('🤖 Bot Gemini Pro está ONLINE!'));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});

// =================================================================
// 3. FUNÇÃO DE TRADUÇÃO
// =================================================================

async function translateWithGemini(text) {
  try {
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

    const response = await axios.post(GEMINI_URL, {
      contents: [{
        parts: [{ text: promptText }]
      }]
    }, { 
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.data || !response.data.candidates || response.data.candidates.length === 0) {
        console.log("Resposta vazia do Gemini.");
        return null;
    }

    const candidate = response.data.candidates[0];
    
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
        console.error("Bloqueio de segurança:", candidate.finishReason);
        return null;
    }

    if (!candidate.content || !candidate.content.parts) {
      throw new Error("Formato inválido recebido do Google");
    }

    let rawText = candidate.content.parts[0].text;
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    return JSON.parse(rawText);

  } catch (error) {
    if (error.response) {
        console.error("Erro API Gemini:", JSON.stringify(error.response.data, null, 2));
    } else {
        console.error("Erro Requisição:", error.message);
    }
    return null;
  }
}

// =================================================================
// 4. LISTENER DE MENSAGENS
// =================================================================

app.message(async ({ message, say }) => {
  if (message.thread_ts) return; 
  if (message.subtype === 'bot_message' || message.bot_id) return;
  if (!message.text) return;

  const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
  if (cleanText.length < MIN_MESSAGE_LENGTH) return;

  try {
    const result = await translateWithGemini(cleanText);

    if (!result || !result.translations || result.translations.length === 0) return;

    const sourceCode = result.sourceLang === 'PT' ? 'PT-BR' : result.sourceLang;
    const sourceInfo = LANGUAGE_MAP[sourceCode] || { emoji: '🌐', name: sourceCode };

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
        text: `🔠 Original: ${sourceInfo.emoji} ${sourceInfo.name} | _via Gemini Pro_`
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
  console.log(`🚀 Bot Gemini PRO rodando na porta ${port}!`);
})();
