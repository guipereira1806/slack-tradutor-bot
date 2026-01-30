require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');
const crypto = require('crypto'); // Nativo do Node.js, usado para otimizar o cache

// =================================================================
// 1. CONFIGURAÇÕES INTELIGENTES
// =================================================================

// Detecta automaticamente se a chave é FREE (:fx) ou PRO
const isFreeKey = process.env.DEEPL_API_KEY ? process.env.DEEPL_API_KEY.endsWith(':fx') : false;
const DEEPL_API_URL = isFreeKey 
  ? 'https://api-free.deepl.com/v2/translate' 
  : 'https://api.deepl.com/v2/translate';

console.log(`🔧 Modo DeepL: ${isFreeKey ? 'FREE' : 'PRO'} | URL: ${DEEPL_API_URL}`);

const MIN_MESSAGE_LENGTH = 5;
const TTL_CACHE_MS = 15 * 60 * 1000; // 15 minutos

// Mapeamento de idiomas
const LANGUAGE_MAP = {
  EN: { emoji: '🇺🇸', name: 'Inglês' },
  ES: { emoji: '🇪🇸', name: 'Espanhol' },
  'PT-BR': { emoji: '🇧🇷', name: 'Português' }, // Padronizado para PT-BR
  PT: { emoji: '🇵🇹', name: 'Português' }       // DeepL às vezes retorna apenas PT
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

// Health Check para o Render não dormir/matar o app
receiver.app.get('/', (req, res) => res.status(200).send('🤖 Bot está ONLINE!'));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
  // removemos logLevel: debug para produção, mas pode reativar se precisar
});

// =================================================================
// 3. CORE: SERVIÇO DE TRADUÇÃO (Isolado e Robusto)
// =================================================================

/**
 * Gera um hash curto do texto para usar como chave de cache (economiza memória RAM)
 */
function generateCacheKey(text, targetLang) {
  return crypto.createHash('md5').update(`${text}-${targetLang}`).digest('hex');
}

/**
 * Lida com erros da API do DeepL de forma centralizada
 */
const getDeepLErrorMessage = (error) => {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    if (status === 456) return '⚠️ Cota do DeepL excedida.';
    if (status === 429) return '⚠️ Muitos pedidos (Rate Limit). Tente já.';
    if (status === 403) return '⚠️ Chave de API inválida (Verifique Free/Pro).';
    return `Erro DeepL (${status})`;
  }
  return 'Erro de conexão.';
};

/**
 * Realiza a chamada à API com proteção de emojis e tratamento de erros
 */
async function callDeeplAPI(text, targetLang) {
  try {
    // Estratégia de Placeholders para Emojis
    const emojiRegex = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;
    const foundEmojis = text.match(emojiRegex) || [];
    
    let textToSend = text;
    
    if (foundEmojis.length > 0) {
      let i = 0;
      textToSend = text.replace(emojiRegex, () => `<e${i++}>`); // Placeholder curto XML-like
    }

    // Chamada Axios
    const response = await axios.post(DEEPL_API_URL, {
      auth_key: process.env.DEEPL_API_KEY,
      text: [textToSend],
      target_lang: targetLang,
      preserve_formatting: "1", // Tenta manter estrutura original
    }, { timeout: 8000 }); // Timeout aumentado para evitar falhas em textos longos

    let translatedText = response.data.translations[0].text;
    const detectedSource = response.data.translations[0].detected_source_language;

    // Restaura Emojis
    if (foundEmojis.length > 0) {
      foundEmojis.forEach((emoji, index) => {
        const placeholder = `<e${index}>`;
        translatedText = translatedText.replace(placeholder, emoji);
        // Fallback: se o DeepL colocou espaço ou mudou o case da tag
        translatedText = translatedText.replace(`< e ${index} >`, emoji).replace(`<E${index}>`, emoji);
      });
    }

    return { text: translatedText, lang: detectedSource };

  } catch (error) {
    throw error; // Repassa o erro para ser tratado no loop principal
  }
}

/**
 * Função Wrapper com Cache
 */
async function getTranslation(text, targetLang) {
  const cacheKey = generateCacheKey(text, targetLang);
  const cached = translationCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < TTL_CACHE_MS) {
    return cached.translation;
  }

  const result = await callDeeplAPI(text, targetLang);
  
  // Salva no cache
  translationCache.set(cacheKey, { translation: result.text, timestamp: Date.now() });
  
  // Limpeza preventiva do cache se ficar muito grande (> 1000 itens)
  if (translationCache.size > 1000) translationCache.clear();

  return result;
}

// =================================================================
// 4. LISTENER DE MENSAGENS
// =================================================================

app.message(async ({ message, say }) => {
  // 1. FILTRO DE SEGURANÇA: Ignora threads, bots e mensagens sem texto
  if (message.thread_ts) return; 
  if (message.subtype === 'bot_message' || message.bot_id) return; // IGNORA OUTROS BOTS
  if (!message.text) return;

  const cleanText = message.text.replace(/<@[^>]+>|<#[^>]+>/g, '').trim();
  if (cleanText.length < MIN_MESSAGE_LENGTH) return;

  try {
    // 2. DETECÇÃO INICIAL (Usa EN como dummy para descobrir o idioma original)
    // Otimização: Se falhar aqui, nem tentamos o resto.
    let initialResult;
    try {
      initialResult = await callDeeplAPI(cleanText, 'EN');
    } catch (err) {
      console.error('Erro na detecção:', err.message);
      return; // Falha silenciosa na detecção para não spamar o canal com erro
    }

    const detectedLang = initialResult.lang;
    const sourceLang = detectedLang.startsWith('PT') ? 'PT-BR' : detectedLang;
    
    // Filtra para quais idiomas vamos traduzir
    const targets = (translationConfig[sourceLang] || (translationConfig['PT'] || [])).filter(t => t !== sourceLang);

    if (!targets || targets.length === 0) {
      return; // Nada a fazer
    }

    // 3. TRADUÇÃO PARALELA
    const translations = await Promise.all(
      targets.map(async (lang) => {
        try {
          // Se o destino for EN e já traduzimos na detecção, usamos aquele resultado (Cache implícito)
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

    // 4. MONTAGEM DA RESPOSTA (BLOCK KIT)
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🌍 Tradução', emoji: true }
      },
      { type: 'divider' }
    ];

    translations.forEach(t => {
      const info = LANGUAGE_MAP[t.lang] || { emoji: '🏳️', name: t.lang };
      // Se deu erro, colocamos em itálico, se não, normal
      const body = t.success ? t.text : `_${t.text}_`;
      
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${info.emoji} *${info.name}*:\n${body}` }
      });
    });

    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn', 
        text: `🔠 Original: ${LANGUAGE_MAP[sourceLang]?.emoji || ''} ${sourceLang} | _Bot by Render_`
      }]
    });

    await say({
      thread_ts: message.ts,
      blocks: blocks,
      text: `Tradução disponível` // Texto de fallback para notificações
    });

  } catch (error) {
    console.error('Erro crítico no handler:', error);
  }
});

// =================================================================
// 5. START
// =================================================================

(async () => {
  const port = process.env.PORT || 3000;
  await app.start({ port, host: '0.0.0.0' });
  console.log(`🚀 Tradutor v2.0 rodando na porta ${port}!`);
})();
