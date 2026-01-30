/**
 * Slack Translator Bot - Gemini Edition
 * Author: Refactored by Google Staff Engineer Persona
 * Stack: Node.js, Slack Bolt, Axios (No extra deps)
 */

require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// =================================================================
// 1. CONFIGURATION & CONSTANTS (Single Source of Truth)
// =================================================================

const CONFIG = {
  slack: {
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    botToken: process.env.SLACK_BOT_TOKEN,
    port: process.env.PORT || 3000,
  },
  gemini: {
    apiKey: (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
    // Usando gemini-pro pois é a versão Stable (GA) disponível globalmente via REST
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
    timeout: 15000, // 15s timeout (LLMs podem ser lentos)
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
// 2. SERVICE LAYER: GEMINI API CLIENT
// =================================================================

class GeminiService {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.url = `${config.baseUrl}?key=${this.apiKey}`;
    this.timeout = config.timeout;
  }

  /**
   * Sanitiza a resposta da IA para garantir um JSON válido.
   * Remove blocos de código markdown (```json ... ```).
   */
  cleanJsonString(text) {
    if (!text) return '{}';
    // Remove marcadores de código Markdown e espaços extras
    return text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
  }

  async translate(text) {
    const prompt = `
      You are a high-precision translation engine.
      Strictly follow these rules:
      1. Detect the source language of the user text.
      2. If source is PT/PT-BR -> Translate to EN and ES.
      3. If source is EN -> Translate to PT-BR and ES.
      4. If source is ES -> Translate to PT-BR and EN.
      
      User text: "${text}"
      
      Output format (Strict JSON only, no polite phrases):
      {
        "sourceLang": "ISO_CODE",
        "translations": [
          { "lang": "ISO_CODE", "text": "Translated content" }
        ]
      }
    `;

    try {
      const response = await axios.post(this.url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1, // Baixa temperatura = Mais determinístico/Fiel
        }
      }, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      const candidate = response.data?.candidates?.[0];

      // Verificação de Segurança (Safety Settings trigger)
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        console.warn(`[Gemini] Bloqueio de segurança: ${candidate.finishReason}`);
        return null;
      }

      const rawText = candidate?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Resposta vazia da API.');

      // Parsing Defensivo
      try {
        const cleanText = this.cleanJsonString(rawText);
        return JSON.parse(cleanText);
      } catch (parseError) {
        console.error(`[Gemini] Erro de Parse JSON. Recebido: ${rawText}`);
        return null;
      }

    } catch (error) {
      const errMsg = error.response?.data?.error?.message || error.message;
      console.error(`[Gemini] Erro de API: ${errMsg}`);
      return null;
    }
  }
}

// Instância Singleton do Serviço
const aiService = new GeminiService(CONFIG.gemini);

// =================================================================
// 3. PRESENTATION LAYER: SLACK APP
// =================================================================

const receiver = new ExpressReceiver({
  signingSecret: CONFIG.slack.signingSecret,
});

// Health Check robusto
receiver.app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'Slack Translator Bot', model: 'gemini-pro' });
});

const app = new App({
  token: CONFIG.slack.botToken,
  receiver: receiver,
});

// =================================================================
// 4. CONTROLLER: MESSAGE HANDLER
// =================================================================

app.message(async ({ message, say }) => {
  // 4.1. Guard Clauses (Validações iniciais rápidas)
  if (message.thread_ts) return; // Ignora threads
  if (message.subtype || message.bot_id) return; // Ignora eventos de sistema e outros bots
  if (!message.text) return;

  // Limpeza básica do texto de entrada
  const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
  if (cleanText.length < CONFIG.app.minMessageLength) return;

  try {
    // 4.2. Chamada ao Serviço
    const result = await aiService.translate(cleanText);

    // Se falhou silenciosamente (por erro ou segurança), paramos aqui.
    if (!result || !result.translations || result.translations.length === 0) return;

    // 4.3. Lógica de Apresentação (UI)
    const sourceCode = (result.sourceLang === 'PT' ? 'PT-BR' : result.sourceLang).toUpperCase();
    const sourceInfo = LANGUAGE_MAP[sourceCode] || { emoji: '🌐', name: sourceCode };

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '✨ Tradução Inteligente', emoji: true }
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
        text: `🔠 Original: ${sourceInfo.emoji} ${sourceInfo.name} | _Gemini Pro_`
      }]
    });

    await say({
      thread_ts: message.ts,
      blocks: blocks,
      text: `Tradução disponível para: ${cleanText.substring(0, 20)}...`
    });

  } catch (error) {
    console.error('[App] Erro não tratado no handler:', error);
  }
});

// =================================================================
// 5. BOOTSTRAP
// =================================================================

(async () => {
  try {
    await app.start({ port: CONFIG.slack.port, host: '0.0.0.0' });
    console.log(`
      🚀 SERVER STARTED
      -----------------
      PORT:   ${CONFIG.slack.port}
      MODEL:  gemini-pro
      MODE:   Production Ready
    `);
  } catch (error) {
    console.error('❌ Falha fatal ao iniciar o servidor:', error);
    process.exit(1);
  }
})();
