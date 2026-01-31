/**
 * Slack Translator Bot - Gemini Edition (Final Shield: Deduplication)
 */

require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// =================================================================
// 1. CONFIGURAÇÃO
// =================================================================

const CONFIG = {
  slack: {
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    botToken: process.env.SLACK_BOT_TOKEN,
    port: process.env.PORT || 10000, 
  },
  gemini: {
    apiKey: (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
    modelName: 'gemini-flash-latest', 
    apiVersion: 'v1beta',
    timeout: 15000, 
  },
  app: {
    minMessageLength: 5,
  }
};

const LANGUAGE_MAP = {
  EN: { emoji: '🇺🇸', name: 'Inglês' },
  ES: { emoji: '🇪🇸', name: 'Espanhol' },
  'PT-BR': { emoji: '🇧🇷', name: 'Português' }
};

// =================================================================
// 2. SISTEMA ANTI-DUPLICIDADE (NOVO)
// =================================================================
// Armazena IDs de mensagens processadas recentemente para evitar repetição
const processedIds = new Set();

function isDuplicate(id) {
  if (processedIds.has(id)) return true;
  
  processedIds.add(id);
  // Limpa o ID da memória após 60 segundos (tempo suficiente para passar os retries do Slack)
  setTimeout(() => processedIds.delete(id), 60000);
  return false;
}

// =================================================================
// 3. CAMADA DE SERVIÇO (GEMINI)
// =================================================================

class GeminiService {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.url = `https://generativelanguage.googleapis.com/${config.apiVersion}/models/${config.modelName}:generateContent?key=${this.apiKey}`;
    this.timeout = config.timeout;
  }

  async translate(text) {
    const prompt = `
      Detect the source language of: "${text}".
      - If source is PT/PT-BR -> Translate to EN and ES.
      - If source is EN -> Translate to PT-BR and ES.
      - If source is ES -> Translate to PT-BR and EN.
      
      Output structure (JSON only):
      {
        "sourceLang": "ISO_CODE",
        "translations": [
          { "lang": "ISO_CODE", "text": "content" }
        ]
      }
    `;

    try {
      const response = await axios.post(this.url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          response_mime_type: "application/json"
        }
      }, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Resposta vazia da IA.');

      return JSON.parse(rawText);

    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      console.error(`[Gemini Error]: ${errMsg}`);
      return null;
    }
  }
}

const aiService = new GeminiService(CONFIG.gemini);

// =================================================================
// 4. APP SLACK
// =================================================================

const receiver = new ExpressReceiver({
  signingSecret: CONFIG.slack.signingSecret,
});

// Mantemos esse middleware como primeira linha de defesa
receiver.app.use((req, res, next) => {
  if (req.headers['x-slack-retry-num']) {
    console.log(`[Slack] Retry de Header detectado: ${req.headers['x-slack-retry-num']}`);
    // Se o cabeçalho chegar, respondemos OK para acalmar o Slack
    res.status(200).send('ok'); 
    return;
  }
  next();
});

const app = new App({
  token: CONFIG.slack.botToken,
  receiver: receiver,
});

receiver.app.get('/', (req, res) => {
  res.status(200).send(`🤖 Bot Online | Modelo: ${CONFIG.gemini.modelName}`);
});

app.message(async ({ message, say }) => {
  // Filtros Básicos
  if (message.thread_ts || message.subtype || message.bot_id || !message.text) return;
  
  // ===============================================================
  // FIX FINAL: TRAVA DE DUPLICIDADE POR ID
  // ===============================================================
  // O "ts" (timestamp) da mensagem é único. Se o Slack reenviar a mensagem (retry),
  // o "ts" será o mesmo. A gente checa se já processou esse "ts".
  if (isDuplicate(message.ts)) {
    console.log(`[Duplicidade] Mensagem ${message.ts} ignorada.`);
    return; 
  }

  const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
  if (cleanText.length < CONFIG.app.minMessageLength) return;

  try {
    const result = await aiService.translate(cleanText);

    if (!result || !result.translations) return;

    const sourceCode = (result.sourceLang === 'PT' ? 'PT-BR' : result.sourceLang).toUpperCase();
    const sourceInfo = LANGUAGE_MAP[sourceCode] || { emoji: '🌐', name: sourceCode };

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '✨ Tradução', emoji: true }
      },
      { type: 'divider' }
    ];

    result.translations.forEach(t => {
      const langCode = (t.lang === 'PT' ? 'PT-BR' : t.lang).toUpperCase();
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
        text: `🔠 Original: ${sourceInfo.emoji} ${sourceInfo.name}`
      }]
    });

    await say({
      thread_ts: message.ts,
      blocks: blocks,
      text: `Tradução disponível`
    });

  } catch (error) {
    console.error('[App] Erro:', error);
  }
});

// =================================================================
// 5. INICIALIZAÇÃO
// =================================================================

(async () => {
  try {
    await app.start(CONFIG.slack.port);
    console.log(`🚀 Servidor rodando na porta ${CONFIG.slack.port}`);
  } catch (error) {
    console.error('❌ Erro fatal:', error);
  }
})();
