require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// =================================================================
// 1. CONFIGURAÇÕES GEMINI (BR / FREE TIER)
// =================================================================

const rawKey = process.env.GEMINI_API_KEY || '';
const GEMINI_KEY = rawKey.trim().replace(/^["']|["']$/g, '');

/**
 * CORREÇÃO PARA O BRASIL:
 * Usamos o nome exato "gemini-1.5-flash".
 * Removemos o sufixo "-latest" que causa o erro 404 na nossa região.
 */
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

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

receiver.app.get('/', (req, res) => res.status(200).send('🤖 Bot Gemini Flash (BR) está ONLINE!'));

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

    // Chamada HTTP para o Google
    const response = await axios.post(GEMINI_URL, {
      contents: [{
        parts: [{ text: promptText }]
      }]
    }, { 
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    // Se a resposta vier vazia ou quebrada
    if (!response.data || !response.data.candidates || response.data.candidates.length === 0) {
        console.log("Resposta vazia do Gemini. Verifique se a chave está ativa.");
        return null;
    }

    const candidate = response.data.candidates[0];
    
    // Proteção contra bloqueios de segurança
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
        console.error("Conteúdo bloqueado pela IA (Safety):", candidate.finishReason);
        return null;
    }

    if (!candidate.content || !candidate.content.parts) {
      throw new Error("Estrutura inválida recebida do Google");
    }

    let rawText = candidate.content.parts[0].text;

    // Limpeza para garantir JSON válido (remove ```json e espaços)
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    return JSON.parse(rawText);

  } catch (error) {
    if (error.response) {
        // Mostra o erro exato do Google nos logs
        console.error("Erro API Google:", JSON.stringify(error.response.data, null, 2));
    } else {
        console.error("Erro Interno:", error.message);
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
        text: `🔠 Original: ${sourceInfo.emoji} ${sourceInfo.name} | _via Gemini Flash_`
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
  console.log(`🚀 Bot Gemini (Brasil/Free) rodando na porta ${port}!`);
})();
