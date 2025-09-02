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

const handleDeeplError = (error) => {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    switch (status) {
      case 400: return 'Requisição inválida para a API do DeepL (Bad Request). Verifique os parâmetros.';
      case 401:
      case 403: return 'Chave de API do DeepL inválida ou sem permissão.';
      case 429: return 'Limite de requisições excedido. Tente novamente mais tarde.';
      case 456: return 'Cota mensal de tradução excedida.';
      case 503: return 'Serviço DeepL indisponível. Tente novamente mais tarde.';
      default: return `Erro na API do DeepL: ${status}`;
    }
  }
  return `Erro de rede ou desconhecido: ${error.message}`;
};

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
      text: [text], // CORREÇÃO: O texto deve ser enviado como um array
      target_lang: targetLang,
    },
    { timeout: 5000 } // Aumentei um pouco o timeout para mais robustez
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
// LISTENER DE MENSAGENS DO SLACK (LÓGICA OTIMIZADA)
// =================================================================

app.message(async ({ message, say }) => {
  try {
    // --- Validações iniciais ---
    if (message.thread_ts || !message.text) return;
    const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
    if (cleanText.length < MIN_MESSAGE_LENGTH) return; // MELHORIA: Valida o tamanho mínimo

    // --- Passo 1: Otimização - Realiza a primeira tradução para detectar o idioma ---
    // Em vez de uma chamada só para detectar, já fazemos a primeira tradução e aproveitamos o resultado.
    const allPossibleSourceLangs = Object.keys(translationConfig);
    if (allPossibleSourceLangs.length === 0) return;

    // Pega o primeiro idioma alvo da configuração para usar como teste
    const firstTargetLang = translationConfig[allPossibleSourceLangs[0]][0];
    let firstTranslationResult;

    try {
      const response = await axios.post(
        DEEPL_API_URL,
        {
          auth_key: process.env.DEEPL_API_KEY,
          text: [cleanText], // CORREÇÃO: Envia o texto em um array
          target_lang: firstTargetLang,
        },
        { timeout: 5000 }
      );
      firstTranslationResult = response.data.translations[0];
    } catch (error) {
      await say({
        thread_ts: message.ts,
        text: `⚠️ Erro ao contatar a API de tradução: ${handleDeeplError(error)}`,
      });
      return;
    }

    // --- Passo 2: Extrai o idioma de origem e formata a primeira tradução ---
    const detectedLang = firstTranslationResult.detected_source_language;
    const sourceLang = detectedLang.startsWith('PT') ? 'PT-BR' : detectedLang;
    
    // Verifica se o idioma detectado está configurado para tradução
    const targetLangs = translationConfig[sourceLang];
    if (!targetLangs || targetLangs.length === 0) {
        // Opcional: pode enviar uma mensagem se o idioma não for suportado
        return;
    }
    
    const langInfoFirst = LANGUAGE_MAP[firstTargetLang] || { emoji: '❓', name: firstTargetLang };
    const firstFormattedTranslation = `${langInfoFirst.emoji} *${langInfoFirst.name}*:\n${firstTranslationResult.text}`;

    // --- Passo 3: Realiza as traduções restantes em paralelo ---
    const remainingTargetLangs = targetLangs.filter(lang => lang !== firstTargetLang);

    const remainingTranslations = await Promise.all(
      remainingTargetLangs.map(async (lang) => {
        try {
          // Reutiliza a função translateText que já tem o sistema de cache
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
    
    const allTranslations = [firstFormattedTranslation, ...remainingTranslations];

    // --- Passo 4: Envia a resposta formatada para o Slack ---
    await say({
      thread_ts: message.ts,
      blocks: formatSlackBlocks(allTranslations, sourceLang),
      text: `Traduções para: ${cleanText.substring(0, 50)}...` // Texto de fallback para notificações
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
