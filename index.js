require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');

// Adicione este bloco no topo do seu arquivo para depuração
console.log('--- Verificando Variáveis de Ambiente ---');
console.log('SLACK_SIGNING_SECRET:', process.env.SLACK_SIGNING_SECRET ? 'Encontrada ✅' : 'Não encontrada ❌');
console.log('SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? 'Encontrada ✅' : 'Não encontrada ❌');
console.log('DEEPL_API_KEY:', process.env.DEEPL_API_KEY ? 'Encontrada ✅' : 'Não encontrada ❌');
console.log('-----------------------------------------');

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
// A chave é o idioma de origem, e o valor é um array com os idiomas de destino.
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

/**
 * Valida se a mensagem deve ser processada.
 * Ignora mensagens em threads ou com poucos caracteres.
 * @param {object} message O objeto da mensagem do Slack.
 * @returns {boolean} Verdadeiro se a mensagem for válida, falso caso contrário.
 */
const isValidMessage = (message) => {
  return !message.thread_ts &&
         message.text &&
         message.text.trim().length > MIN_MESSAGE_LENGTH;
};

/**
 * Lida com erros da API do DeepL e retorna uma mensagem amigável.
 * @param {object} error O objeto de erro.
 * @returns {string} Uma mensagem de erro específica.
 */
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

/**
 * Detecta o idioma de um texto usando a API do DeepL.
 * @param {string} text O texto a ser analisado.
 * @returns {Promise<string>} O código do idioma detectado (ex: 'EN', 'PT-BR').
 */
async function detectLanguage(text) {
  const response = await axios.post(
    DEEPL_API_URL,
    {
      auth_key: process.env.DEEPL_API_KEY,
      text: text,
      target_lang: 'EN', // DeepL exige um target_lang para detectar o source_lang
    },
    { timeout: 3000 }
  );

  const detectedLang = response.data.translations[0].detected_source_language;
  // Mapeia todas as variantes de PT (ex: PT-BR, PT-PT) para 'PT-BR'
  return detectedLang.startsWith('PT') ? 'PT-BR' : detectedLang;
}

/**
 * Traduz um texto para um idioma alvo usando a API do DeepL.
 * @param {string} text O texto original.
 * @param {string} targetLang O código do idioma alvo (ex: 'PT-BR', 'EN').
 * @returns {Promise<string>} O texto traduzido.
 */
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

/**
 * Formata as traduções em um bloco de mensagem do Slack.
 * @param {Array<string>} translations A lista de strings de tradução formatadas.
 * @param {string} sourceLang O idioma original.
 * @returns {object} Um objeto de bloco de mensagem do Slack.
 */
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
      console.log('Mensagem ignorada:', message.ts);
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
  await app.start(process.env.PORT || 3000);
  console.log('🚀 Tradutor do Slack está online!');
})();
