require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');

// =================================================================
// CONSTANTES E CONFIGURAÇÕES
// =================================================================

const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';
const MIN_MESSAGE_LENGTH = 5;

const LANGUAGE_MAP = {
  EN: { emoji: '🇺🇸', name: 'Inglês' },
  ES: { emoji: '🇪🇸', name: 'Espanhol' },
  'PT-BR': { emoji: '🇧🇷', name: 'Português (Brasil)' },
};

const translationConfig = {
  'PT-BR': ['EN', 'ES'],
  EN: ['PT-BR', 'ES'],
  ES: ['PT-BR', 'EN'],
};

const translationCache = new Map();
const TTL_CACHE_MS = 15 * 60 * 1000;

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
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: translations.join('\n\n'),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🔠 Idioma original detectado: ${LANGUAGE_MAP[sourceLang]?.emoji || ''} ${LANGUAGE_MAP[sourceLang]?.name || sourceLang}`,
        },
      ],
    },
  ];
}

// =================================================================
// LISTENER DE MENSAGENS DO SLACK
// =================================================================

app.message(async ({ message, say }) => {
  try {
    if (!isValidMessage(message)) {
      return;
    }
    const cleanText = message.text.trim();
    let sourceLang;
    try {
      sourceLang = await detectLanguage(cleanText);
    } catch (error) {
      await say({
        thread_ts: message.ts,
        text: `⚠️ Erro ao detectar o idioma: ${handleDeeplError(error)}`,
      });
      return;
    }
    const targetLangs = translationConfig[sourceLang] || [];
    if (targetLangs.length === 0) {
      await say({
        thread_ts: message.ts,
        text: `${LANGUAGE_MAP[sourceLang]?.emoji || '⚠️'} Idioma não suportado para tradução automática.`,
      });
      return;
    }
    const translations = await Promise.all(
      targetLangs.map(async (lang) => {
        try {
          const translated = await translateText(cleanText, lang);
          const langInfo = LANGUAGE_MAP[lang] || { emoji: '❓', name: lang };
          return `${langInfo.emoji} *${langInfo.name}*:\n${translated}`;
        } catch (error) {
          console.error(`Erro na tradução para ${lang}:`, error);
          const langInfo = LANGUAGE_MAP[lang] || { emoji: '❓', name: lang };
          return `${langInfo.emoji} *${langInfo.name}*:\n_Erro ao traduzir._`;
        }
      })
    );
    await say({
      thread_ts: message.ts,
      blocks: formatSlackBlocks(translations, sourceLang),
    });
  } catch (error) {
    console.error('Erro inesperado no processamento da mensagem:', error);
    await say({
      thread_ts: message.ts,
      text: `⚠️ Ocorreu um erro inesperado: ${error.message.substring(0, 50)}...`,
    });
  }
});

(async () => {
  await app.start({ port: process.env.PORT || 3000, host: '0.0.0.0' });
  console.log('🚀 Tradutor do Slack está online!');
})();
