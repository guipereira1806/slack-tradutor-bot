/**
 * Slack Translator Bot - Gemini Edition (Final Fix: Flash Latest)
 */

require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// =================================================================
// 1. CONFIGURAÇÃO (CENTRALIZADA)
// =================================================================

const CONFIG = {
  slack: {
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    botToken: process.env.SLACK_BOT_TOKEN,
    port: process.env.PORT || 3000,
  },
  gemini: {
    apiKey: (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
    
    // CORREÇÃO FINAL: Usando 'gemini-flash-latest'
    // Este modelo apareceu na sua lista de diagnóstico e tem cota gratuita.
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
// 2. CAMADA DE SERVIÇO (GEMINI VIA AXIOS)
// =================================================================

class GeminiService {
  constructor(config) {
    this.apiKey = config.apiKey;
    // Monta a URL dinamicamente baseada no modelo escolhido
    this.url = `https://generativelanguage.googleapis.com/${config.apiVersion}/models/${config.modelName}:generateContent?key=${this.apiKey}`;
    this.timeout = config.timeout;
  }

  cleanJsonString(text) {
    if (!text) return '{}';
    // Remove formatação Markdown que a IA as vezes coloca
    return text.replace(/```json/gi, '').replace(/```/g, '').trim();
  }

  async translate(text) {
    const prompt = `
      You are a translation engine.
      Strictly follow these rules:
      1. Detect source language of: "${text}".
      2. If source is PT/PT-BR -> Translate to EN and ES.
      3. If source is EN -> Translate to PT-BR and ES.
      4. If source is ES -> Translate to PT-BR and EN.
      
      Output format (Strict JSON only):
      {
        "sourceLang": "ISO_CODE",
        "translations": [
          { "lang": "ISO_CODE", "text": "Translated content" }
        ]
      }
    `;

    try {
      const response = await axios.post(this.url, {
        contents: [{ parts: [{ text: prompt }] }]
      }, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      const candidate = response.data?.candidates?.[0];
      
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        console.warn(`[Gemini] Bloqueio de segurança: ${candidate.finishReason}`);
        return null;
      }

      const rawText = candidate?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Resposta vazia da IA.');

      try {
        const cleanText = this.cleanJsonString(rawText);
        return JSON.parse(cleanText);
      } catch (parseError) {
        console.error(`[Gemini] Erro de Parse JSON. Texto recebido: ${rawText}`);
        return null;
      }

    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      const status = error.response?.status || 'Unknown';
      
      // Log detalhado para debug se necessário
      console.error(`[Gemini] Erro de API (${status}): ${errMsg}`);
      return null;
    }
  }
}

const aiService = new GeminiService(CONFIG.gemini);

// =================================================================
// 3. APP SLACK
// =================================================================

const receiver = new ExpressReceiver({
  signingSecret: CONFIG.slack.signingSecret,
});

receiver.app.get('/', (req, res) => {
  res.status(200).send(`🤖 Bot Online | Modelo: ${CONFIG.gemini.modelName}`);
});

const app = new App({
  token: CONFIG.slack.botToken,
  receiver: receiver,
});

app.message(async ({ message, say }) => {
  // Filtros de segurança e spam
  if (message.thread_ts) return; 
  if (message.subtype || message.bot_id) return;
  if (!message.text) return;

  const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
  if (cleanText.length < CONFIG.app.minMessageLength) return;

  try {
    const result = await aiService.translate(cleanText);

    if (!result || !result.translations || result.translations.length === 0) return;

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
    console.error('[App] Erro no handler:', error);
  }
});

// =================================================================
// 4. INICIALIZAÇÃO
// =================================================================

(async () => {
  try {
    await app.start({ port: CONFIG.slack.port, host: '0.0.0.0' });
    console.log(`🚀 Servidor rodando na porta ${CONFIG.slack.port}`);
    console.log(`🧠 Modelo Gemini ativo: ${CONFIG.gemini.modelName}`);
  } catch (error) {
    console.error('❌ Erro fatal:', error);
  }
})();
