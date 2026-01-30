/**
 * Slack Translator Bot - Gemini Edition (Com Auto-Diagnóstico)
 * Status: Debugging & Production Mode
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
    // TENTATIVA: Vamos usar o flash-002 que é a versão numerada estável mais recente
    // Se falhar, o diagnóstico nos logs nos dirá qual usar.
    modelName: 'gemini-1.5-flash', 
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
// 2. DIAGNÓSTICO (O "PULO DO GATO")
// =================================================================

/**
 * Esta função roda ao iniciar e lista para você no console
 * EXATAMENTE quais modelos sua chave tem permissão para usar.
 */
async function runDiagnostic() {
  console.log('\n🔍 --- INICIANDO DIAGNÓSTICO DO GEMINI ---');
  const url = `https://generativelanguage.googleapis.com/${CONFIG.gemini.apiVersion}/models?key=${CONFIG.gemini.apiKey}`;
  
  try {
    const response = await axios.get(url);
    const models = response.data.models || [];
    
    console.log(`✅ Conexão com Google OK! Encontrei ${models.length} modelos disponíveis.`);
    console.log('📋 Lista de modelos compatíveis com sua chave:');
    
    // Filtra apenas os que geram texto
    const textModels = models
      .filter(m => m.supportedGenerationMethods.includes('generateContent'))
      .map(m => m.name.replace('models/', '')); // Remove o prefixo para facilitar leitura

    console.log(textModels.join(', '));
    console.log('-------------------------------------------\n');
    
    // Verifica se o modelo escolhido está na lista
    if (!textModels.includes(CONFIG.gemini.modelName)) {
      console.warn(`⚠️ AVISO CRÍTICO: O modelo configurado '${CONFIG.gemini.modelName}' NÃO está na lista acima.`);
      console.warn(`👉 Solução: Copie um nome da lista acima e atualize a variável CONFIG.gemini.modelName no código.`);
    } else {
      console.log(`🎉 O modelo configurado '${CONFIG.gemini.modelName}' é válido e está disponível!`);
    }

  } catch (error) {
    console.error('❌ FALHA NO DIAGNÓSTICO:', error.response ? error.response.data : error.message);
    if (error.response && error.response.status === 404) {
      console.error('💡 Dica: Verifique se sua chave API está correta e ativa no Google AI Studio.');
    }
  }
}

// =================================================================
// 3. CAMADA DE SERVIÇO (GEMINI)
// =================================================================

class GeminiService {
  constructor(config) {
    this.apiKey = config.apiKey;
    // Monta a URL dinamicamente
    this.url = `https://generativelanguage.googleapis.com/${config.apiVersion}/models/${config.modelName}:generateContent?key=${this.apiKey}`;
    this.timeout = config.timeout;
  }

  cleanJsonString(text) {
    if (!text) return '{}';
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
      console.error(`[Gemini] Erro de API (${error.response?.status || 'Unknown'}): ${errMsg}`);
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

receiver.app.get('/', (req, res) => {
  res.status(200).send('🤖 Bot está ONLINE. Verifique os logs para o Diagnóstico do Gemini.');
});

const app = new App({
  token: CONFIG.slack.botToken,
  receiver: receiver,
});

app.message(async ({ message, say }) => {
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
// 5. INICIALIZAÇÃO E EXECUÇÃO DO DIAGNÓSTICO
// =================================================================

(async () => {
  try {
    await app.start({ port: CONFIG.slack.port, host: '0.0.0.0' });
    console.log(`🚀 Servidor rodando na porta ${CONFIG.slack.port}`);
    
    // RODA O DIAGNÓSTICO ASSIM QUE O SERVIDOR SOBE
    await runDiagnostic();

  } catch (error) {
    console.error('❌ Erro fatal:', error);
  }
})();
