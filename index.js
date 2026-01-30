require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');
const crypto = require('crypto'); // Nativo do Node.js

// =================================================================
// 1. CONFIGURAÇÕES INTELIGENTES E LIMPEZA DE CHAVE
// =================================================================

// 1. Pega a chave bruta e LIMPA sujeiras (espaços, aspas, quebras de linha)
const rawKey = process.env.DEEPL_API_KEY || '';
const DEEPL_KEY = rawKey.trim().replace(/^["']|["']$/g, '');

// 2. Detecta automaticamente se a chave é FREE (:fx) ou PRO
const isFreeKey = DEEPL_KEY.endsWith(':fx');

// 3. Define a URL correta
const DEEPL_API_URL = isFreeKey 
  ? 'https://api-free.deepl.com/v2/translate' 
  : 'https://api.deepl.com/v2/translate';

// Log de segurança para Debug (mostra só o final da chave para confirmar que carregou)
console.log(`🔧 Configuração DeepL:`);
console.log(`   - Modo: ${isFreeKey ? 'FREE (Conta Gratuita)' : 'PRO (Conta Paga)'}`);
console.log(`   - URL: ${DEEPL_API_URL}`);
console.log(`   - Chave carregada (final): ...${DEEPL_KEY.slice(-5)}`);

const MIN_MESSAGE_LENGTH = 5;
const TTL_CACHE_MS = 15 * 60 * 1000; // 15 minutos

// Mapeamento de idiomas
const LANGUAGE_MAP = {
  EN: { emoji: '🇺🇸', name: 'Inglês' },
  ES: { emoji: '🇪🇸', name: 'Espanhol' },
  'PT-BR': { emoji: '🇧🇷', name: 'Português' },
  PT: { emoji: '🇵🇹', name: 'Português' }
};

// Quem traduz para quem
const translationConfig = {
  'PT-BR': ['EN', 'ES'],
  'PT': ['EN', 'ES'],
  EN: ['PT-BR', 'ES'],
  ES: ['PT-BR', 'EN'],
};

// Cache na memória
const translationCache = new Map();

// =================================================================
// 2. INICIALIZAÇÃO SLACK (BOLT)
// =================================================================

const receiver = new ExpressReceiver({ 
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Health check para manter o Render feliz
receiver.app.get('/', (req, res) => res.status(200).send('🤖 Bot está ONLINE e pronto!'));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});

// =================================================================
// 3. SERVIÇO DE TRADUÇÃO (CORE)
// =================================================================

// Gera chave de hash curta para economizar memória RAM
function generateCacheKey(text, targetLang) {
  return crypto.createHash('md5').update(`${text}-${targetLang}`).digest('hex');
}

// Tratamento de erros amigável
const getDeepLErrorMessage = (error) => {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    if (status === 456) return '⚠️ Cota do DeepL excedida.';
    if (status === 429) return '⚠️ Muitos pedidos (Rate Limit). Aguarde um pouco.';
    if (status === 403) return '⚠️ Erro de Autenticação (Chave inválida).';
    return `Erro DeepL (${status})`;
  }
  return 'Erro de conexão.';
};

async function callDeeplAPI(text, targetLang) {
  try {
    // Tratamento de Emojis (substitui por placeholders <e0>)
    const emojiRegex = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;
    const foundEmojis = text.match(emojiRegex) || [];
    
    let textToSend = text;
    if (foundEmojis.length > 0) {
      let i = 0;
      textToSend = text.replace(emojiRegex, () => `<e${i++}>`);
    }

    // CHAMADA AXIOS (Usando a chave limpa DEEPL_KEY)
    const response = await axios.post(DEEPL_API_URL, {
      auth_key: DEEPL_KEY, // <--- Aqui usamos a chave sanitizada
      text: [textToSend],
      target_lang: targetLang,
      preserve_formatting: "1",
    }, { timeout: 10000 }); // Timeout seguro de 10s

    let translatedText = response.data.translations[0].text;
    const detectedSource = response.data.translations[0].detected_source_language;

    // Restaura Emojis
    if (foundEmojis.length > 0) {
      foundEmojis.forEach((emoji, index) => {
        const placeholder = `<e${index}>`;
        translatedText = translatedText.replace(placeholder, emoji);
        // Fallback caso a API coloque espaços na tag
        translatedText = translatedText.replace(`< e ${index} >`, emoji).replace(`<E${index}>`, emoji);
      });
    }

    return { text: translatedText, lang: detectedSource };

  } catch (error) {
    throw error;
  }
}

async function getTranslation(text, targetLang) {
  const cacheKey = generateCacheKey(text, targetLang);
  const cached = translationCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < TTL_CACHE_MS) {
    return cached.translation;
  }

  const result = await callDeeplAPI(text, targetLang);
  
  translationCache.set(cacheKey, { translation: result.text, timestamp: Date.now() });
  
  // Limpa cache se ficar gigante
  if (translationCache.size > 1000) translationCache.clear();

  return result;
}

// =================================================================
// 4. LISTENER DE MENSAGENS
// =================================================================

app.message(async ({ message, say }) => {
  // --- FILTROS DE SEGURANÇA ---
  if (message.thread_ts) return; // Ignora threads
  if (message.subtype === 'bot_message' || message.bot_id) return; // IGNORA OUTROS BOTS (Evita Loop)
  if (!message.text) return;

  const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
  if (cleanText.length < MIN_MESSAGE_LENGTH) return;

  try {
    // 1. DETECÇÃO (Chamada leve para descobrir idioma)
    let initialResult;
    try {
      initialResult = await callDeeplAPI(cleanText, 'EN');
    } catch (err) {
      // Se der erro aqui (ex: 403), loga no console mas não quebra o bot
      console.error(`[Erro Detecção] ${getDeepLErrorMessage(err)} | Detalhes: ${err.message}`);
      return; 
    }

    const detectedLang = initialResult.lang;
    const sourceLang = detectedLang.startsWith('PT') ? 'PT-BR' : detectedLang;
    
    // Define alvos
    const targets = (translationConfig[sourceLang] || (translationConfig['PT'] || [])).filter(t => t !== sourceLang);

    if (!targets || targets.length === 0) return;

    // 2. TRADUÇÃO PARALELA
    const translations = await Promise.all(
      targets.map(async (lang) => {
        try {
          if (lang === 'EN' && initialResult.lang !== 'EN') {
             return { lang, text: initialResult.text, success: true };
          }
          const res = await getTranslation(cleanText, lang);
          return { lang, text: res.text, success: true };
        } catch (error) {
          return { lang, text: getDeepLErrorMessage(error), success: false };
        }
      })
    );

    // 3. RESPOSTA VISUAL
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🌍 Tradução', emoji: true }
      },
      { type: 'divider' }
    ];

    translations.forEach(t => {
      const info = LANGUAGE_MAP[t.lang] || { emoji: '🏳️', name: t.lang };
      const body = t.success ? t.text : `_${t.text}_`; // Itálico se for erro
      
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${info.emoji} *${info.name}*:\n${body}` }
      });
    });

    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn', 
        text: `🔠 Original: ${LANGUAGE_MAP[sourceLang]?.emoji || ''} ${sourceLang}`
      }]
    });

    await say({
      thread_ts: message.ts,
      blocks: blocks,
      text: `Tradução disponível`
    });

  } catch (error) {
    console.error('Erro geral no handler:', error);
  }
});

// =================================================================
// 5. START SERVER
// =================================================================

(async () => {
  const port = process.env.PORT || 3000;
  await app.start({ port, host: '0.0.0.0' });
  console.log(`🚀 Tradutor Iniciado na porta ${port}!`);
})();
