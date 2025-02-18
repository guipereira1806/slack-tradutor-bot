require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Mapeamento completo de idiomas
const LANGUAGE_MAP = {
  EN: { emoji: '🇺🇸', name: 'Inglês' },
  ES: { emoji: '🇪🇸', name: 'Espanhol' },
  PT: { emoji: '🇧🇷', name: 'Português' }
};

// Validação de texto
const isValidMessage = (message) => {
  return !message.thread_ts && 
         message.text && 
         message.text.trim().length > 5; // Mínimo 5 caracteres
};

async function detectLanguage(text) {
  const response = await axios.post(
    'https://api-free.deepl.com/v2/translate',
    null,
    {
      params: {
        auth_key: process.env.DEEPL_API_KEY,
        text: text,
        target_lang: 'EN',
      },
      timeout: 3000
    }
  );
  return response.data.translations[0].detected_source_language;
}

async function translateText(text, targetLang) {
  const response = await axios.post(
    'https://api-free.deepl.com/v2/translate',
    null,
    {
      params: {
        auth_key: process.env.DEEPL_API_KEY,
        text: text,
        target_lang: targetLang,
      },
      timeout: 3000
    }
  );
  return response.data.translations[0].text;
}

app.message(async ({ message, say }) => {
  try {
    if (!isValidMessage(message)) {
      console.log('Mensagem ignorada:', message.ts);
      return;
    }

    const cleanText = message.text.trim();
    const sourceLang = await detectLanguage(cleanText);
    
    // Configuração dinâmica de traduções
    const translationConfig = {
      PT: ['EN', 'ES'],
      EN: ['PT', 'ES'],
      ES: ['PT', 'EN']
    };

    const targetLangs = translationConfig[sourceLang] || [];
    
    if (targetLangs.length === 0) {
      await say({
        thread_ts: message.ts,
        text: `${LANGUAGE_MAP[sourceLang]?.emoji || '⚠️'} Idioma não suportado para tradução automática`
      });
      return;
    }

    // Processamento das traduções
    const translations = await Promise.all(
      targetLangs.map(async (lang) => {
        const translated = await translateText(cleanText, lang);
        return `${LANGUAGE_MAP[lang].emoji} *${LANGUAGE_MAP[lang].name}*:\n${translated}`;
      })
    );

    // Montagem da mensagem formatada
    await say({
      thread_ts: message.ts,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🌍 Traduções Automáticas',
            emoji: true
          }
        },
        {
          type: 'divider'
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: translations.join('\n\n')
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `🔠 Idioma original detectado: ${LANGUAGE_MAP[sourceLang]?.emoji || ''} ${sourceLang}`
            }
          ]
        }
      ]
    });

  } catch (error) {
    console.error('Erro:', error);
    await say({
      thread_ts: message.ts,
      text: `⚠️ Erro na tradução: ${error.message.substring(0, 50)}...`
    });
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('🚀 Tradutor está online!');
})();
