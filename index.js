require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
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

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });

receiver.app.get('/', (req, res) => {
  res.status(200).send('Health check OK. Bot is running!');
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});

// =================================================================
// FUNÇÕES AUXILIARES
// =================================================================

const handleDeeplError = (error) => {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    switch (status) {
      case 400: return 'Requisição inválida para a API do DeepL (Bad Request).';
      case 403: return 'Chave de API do DeepL inválida ou sem permissão.';
      case 429: return 'Limite de requisições excedido. Tente novamente mais tarde.';
      case 456: return 'Cota mensal de tradução excedida.';
      case 503: return 'Serviço DeepL indisponível. Tente novamente mais tarde.';
      default: return `Erro na API do DeepL: ${status}`;
    }
  }
  return `Erro de rede ou desconhecido: ${error.message}`;
};

/**
 * NOVA FUNÇÃO: Centraliza a chamada à API DeepL, protegendo emojis da tradução.
 */
async function callDeeplAPI(text, targetLang) {
  // Regex para encontrar a maioria dos emojis Unicode
  const emojiRegex = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;

  // Envelopa os emojis com a tag <notranslate> para que o DeepL os ignore
  const textWithProtectedEmojis = text.replace(emojiRegex, '<notranslate>$&</notranslate>');

  const response = await axios.post(
    DEEPL_API_URL,
    {
      auth_key: process.env.DEEPL_API_KEY,
      text: [textWithProtectedEmojis],
      target_lang: targetLang,
      tag_handling: 'xml', // Habilita o manuseio de tags XML
    },
    { timeout: 5000 }
  );

  const translationResult = response.data.translations[0];

  // Remove as tags <notranslate> do texto final antes de retornar
  const cleanedText = translationResult.text.replace(/<\/?notranslate>/g, '');

  return {
    translatedText: cleanedText,
    detectedSourceLanguage: translationResult.detected_source_language,
  };
}


async function translateText(text, targetLang) {
  const cacheKey = `${text}-${targetLang}`;
  const cachedResult = translationCache.get(cacheKey);

  if (cachedResult && Date.now() - cachedResult.timestamp < TTL_CACHE_MS) {
    return cachedResult.translation;
  }
  
  // Usa a nova função centralizada para fazer a chamada
  const { translatedText } = await callDeeplAPI(text, targetLang);

  translationCache.set(cacheKey, { translation: translatedText, timestamp: Date.now() });
  return translatedText;
}

function formatSlackBlocks(translations, sourceLang) {
  const headerBlock = {
    type: 'header',
    text: { type: 'plain_text', text: '🌍 Traduções Automáticas', emoji: true },
  };
  const dividerBlock = { type: 'divider' };
  const translationBlocks = translations.map(translationText => ({
    type: 'section',
    text: { type: 'mrkdwn', text: translationText },
  }));
  const contextBlock = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `🔠 Idioma original detectado: ${LANGUAGE_MAP[sourceLang]?.emoji || ''} ${LANGUAGE_MAP[sourceLang]?.name || sourceLang}`,
      },
    ],
  };
  return [headerBlock, dividerBlock, ...translationBlocks, contextBlock];
}

// =================================================================
// LISTENER DE MENSAGENS DO SLACK
// =================================================================

app.message(async ({ message, say }) => {
  try {
    if (message.thread_ts || !message.text) return;
    const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
    if (cleanText.length < MIN_MESSAGE_LENGTH) return;

    let initialApiResult;
    try {
      // Usa a nova função centralizada para a chamada inicial também
      initialApiResult = await callDeeplAPI(cleanText, 'EN');
    } catch (error) {
      await say({
        thread_ts: message.ts,
        text: `⚠️ Erro ao contatar a API de tradução: ${handleDeeplError(error)}`,
      });
      return;
    }

    const detectedLang = initialApiResult.detectedSourceLanguage;
    const sourceLang = detectedLang.startsWith('PT') ? 'PT-BR' : detectedLang;
    const finalTargetLangs = (translationConfig[sourceLang] || []).filter(lang => lang !== sourceLang);

    if (finalTargetLangs.length === 0) {
      console.log(`Mensagem no idioma '${sourceLang}', nenhuma tradução necessária.`);
      return;
    }

    const translations = await Promise.all(
      finalTargetLangs.map(async (lang) => {
        try {
          const translated = await translateText(cleanText, lang);
          const langInfo = LANGUAGE_MAP[lang] || { emoji: '❓', name: lang };
          return `${langInfo.emoji} *${langInfo.name}*:\n${translated}`;
        } catch (error) {
          console.error(`Erro na tradução para ${lang}:`, error);
          const langInfo = LANGUAGE_MAP[lang] || { emoji: '❓', name: lang };
          return `${langInfo.emoji} *${langInfo.name}*:\n_${handleDeeplError(error)}_`;
        }
      })
    );
    
    await say({
      thread_ts: message.ts,
      blocks: formatSlackBlocks(translations, sourceLang),
      text: `Traduções para: ${cleanText.substring(0, 50)}...`
    });

  } catch (error) {
    console.error('Erro inesperado no processamento da mensagem:', error);
    await say({
      thread_ts: message.ts,
      text: `⚠️ Ocorreu um erro inesperado: ${error.message}`,
    });
  }
});

// =================================================================
// INICIALIZAÇÃO DO SERVIDOR
// =================================================================

(async () => {
  const port = process.env.PORT || 3000;
  await app.start({ port, host: '0.0.0.0' });
  console.log(`🚀 Tradutor do Slack está online na porta ${port}!`);
})();
