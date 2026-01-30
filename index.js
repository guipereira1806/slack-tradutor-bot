require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// =================================================================
// 1. CONFIGURAÇÕES GEMINI (Via HTTP/Axios)
// =================================================================

// Limpeza da chave
const rawKey = process.env.GEMINI_API_KEY || '';
const GEMINI_KEY = rawKey.trim().replace(/^["']|["']$/g, '');

/**
 * CORREÇÃO AQUI: 
 * Mudamos para 'gemini-1.5-flash-latest' que é o alias mais seguro.
 * Se ainda der erro, troque por 'gemini-pro'.
 */
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;

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

receiver.app.get('/', (req, res) => res.status(200).send('🤖 Bot Gemini v1.5 está ONLINE!'));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});

// =================================================================
// 3. FUNÇÃO DE TRADUÇÃO (CHAMADA DIRETA)
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

    // Chamada HTTP para o Google
    const response = await axios.post(GEMINI_URL, {
      contents: [{
        parts: [{ text: promptText }]
      }]
    }, { 
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    // Validando resposta
    if (!response.data || !response.data.candidates || response.data.candidates.length === 0) {
        console.log("Resposta bruta do Gemini:", JSON.stringify(response.data));
        return null;
    }

    const candidate = response.data.candidates[0];
    
    // Proteção contra bloqueios de segurança (Hate speech, harassment, etc)
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
        console.error("Gemini bloqueou a resposta por segurança:", candidate.finishReason);
        return null;
    }

    if (!candidate.content || !candidate.content.parts) {
      throw new Error("Estrutura de resposta inesperada do Gemini");
    }

    let rawText = candidate.content.parts[0].text;

    // Limpeza de segurança (caso a IA mande blocos de código markdown)
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    return JSON.parse(rawText);

  } catch (error) {
    // Log detalhado para te ajudar a debugar se der erro de novo
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
  console.log(`🚀 Bot Gemini (v1.5-flash-latest) rodando na porta ${port}!`);
})();
