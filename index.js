require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');

// =================================================================
// CONSTANTES E CONFIGURAÇÕES
// =================================================================

const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';
const MIN_MESSAGE_LENGTH = 5;

// Mapeamento de idiomas com emoji e nome
const LANGUAGE_MAP = {
  EN: { emoji: '🇺🇸', name: 'Inglês' },
  ES: { emoji: '🇪🇸', name: 'Espanhol' },
  'PT-BR': { emoji: '🇧🇷', name: 'Português (Brasil)' },
};

// Configuração de tradução: define para quais idiomas traduzir
const translationConfig = {
  'PT-BR': ['EN', 'ES'],
  EN: ['PT-BR', 'ES'],
  ES: ['PT-BR', 'EN'],
};

// Cache simples para evitar chamadas de API duplicadas para a mesma mensagem
const translationCache = new Map();
const TTL_CACHE_MS = 15 * 60 * 1000; // 15 minutos

// =================================================================
// INICIALIZAÇÃO DO APLICATIVO SLACK
// =================================================================

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// =================================================================
// FUNÇÕES AUXILIARES
// =================================================================

const isValidMessage = (message) => {
  return !message.thread_ts &&
         message.text &&
         message.text.trim().length > MIN_MESSAGE_LENGTH;
};

const handleDeeplError = (error) => {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    switch (status) {
      case 401: return 'Chave de API do DeepL inválida ou ausente.';
      case 429: return 'Limite de requisições excedido. Tente novamente mais tarde.';
      case 456: return 'Cota mensal de tradução excedida.';
      case 503: return 'Serviço DeepL indisponível. Tente novamente mais tarde.';
      default: return `Erro na API do DeepL: ${status}`;
    }
  }
  return `Erro de rede ou desconhecido: ${error.message}`;
};

async function detectLanguage(text) {
  const response = await axios.post(
    DEEPL_API_URL,
    {
      auth_key: process.env.DEEPL_API_KEY,
      text: text,
      target_lang: 'EN',
    },
    { timeout: 3000 }
  );

  const detectedLang = response.data.translations[0].detected_source_language;
  return detectedLang.startsWith('PT') ? 'PT-BR' : detectedLang;
}

async function translateText(text, targetLang) {
  const cacheKey = `${text}-${targetLang}`;
  const cachedResult = translationCache.get(cacheKey);

  if (cachedResult && Date.now() - cachedResult.timestamp < TTL_CACHE_MS) {
    return cachedResult.translation;
  }

  const response = await axios.post(
    DEEPL_API_URL,
    {
      auth_key: process.env.DEEPL_API_KEY,
      text: text,
      target_lang: targetLang,
    },
    { timeout: 3000 }
  );

  const translatedText = response.data.translations[0].text;
  translationCache.set(cacheKey, { translation: translatedText, timestamp: Date.now() });

  return translatedText;
}

function formatSlackBlocks(translations, sourceLang) {
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🌍 Traduções Automáticas',
        emoji: true,
      },
    },
    {
