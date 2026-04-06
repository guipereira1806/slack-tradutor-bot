/**
 * Slack Translator Bot - OpenAI Edition (Final Shield: Deduplication + File Support)
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
  openai: {
    apiKey: (process.env.OPENAI_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
    // Recomendo o gpt-4o-mini por ser muito rápido e barato para traduções
    modelName: 'gpt-4o-mini', 
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
// 2. SISTEMA ANTI-DUPLICIDADE
// =================================================================
const processedIds = new Set();

function isDuplicate(id) {
  if (processedIds.has(id)) return true;
  
  processedIds.add(id);
  setTimeout(() => processedIds.delete(id), 60000);
  return false;
}

// =================================================================
// 3. CAMADA DE SERVIÇO (OPENAI)
// =================================================================

class OpenAIService {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.url = 'https://api.openai.com/v1/chat/completions';
    this.modelName = config.modelName;
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
        model: this.modelName,
        // Força a OpenAI a retornar um JSON válido
        response_format: { type: "json_object" }, 
        messages: [
          { 
            role: "system", 
            content: "You are a helpful translation assistant. Always return valid JSON." 
          },
          { 
            role: "user", 
            content: prompt 
          }
        ]
      }, {
        timeout: this.timeout,
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}` // Autenticação via Bearer Token
        }
      });

      const rawText = response.data?.choices?.[0]?.message?.content;
      if (!rawText) throw new Error('Resposta vazia da IA.');

      return JSON.parse(rawText);

    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      console.error(`[OpenAI Error]: ${errMsg}`);
      return null;
    }
  }
}

const aiService = new OpenAIService(CONFIG.openai);

// =================================================================
// 4. APP SLACK
// =================================================================

const receiver = new ExpressReceiver({
  signingSecret: CONFIG.slack.signingSecret,
});

receiver.app.use((req, res, next) => {
  if (req.headers['x-slack-retry-num']) {
    console.log(`[Slack] Retry de Header detectado: ${req.headers['x-slack-retry-num']}`);
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
  res.status(200).send(`🤖 Bot Online | Modelo: ${CONFIG.openai.modelName}`);
});

app.message(async ({ message, say }) => {
  
  // Verifica se é uma mensagem duplicada (retry do Slack)
  if (isDuplicate(message.ts)) {
    console.log(`[Duplicidade] Mensagem ${message.ts} ignorada.`);
    return; 
  }

  // Verifica se é um subtipo 'proibido' (ex: entrar no canal), mas permite 'file_share'
  const isIgnoredSubtype = message.subtype && message.subtype !== 'file_share';

  // Se for thread, subtipo ignorado, bot ou sem texto -> sai da função
  if (message.thread_ts || isIgnoredSubtype || message.bot_id || !message.text) return;

  const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
  
  // Só traduz se houver texto suficiente
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
