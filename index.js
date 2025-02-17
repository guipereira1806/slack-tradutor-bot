require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Validador de texto
function isValidText(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

async function detectLanguage(text) {
  try {
    const response = await axios.post(
      'https://api-free.deepl.com/v2/translate',
      null,
      {
        params: {
          auth_key: process.env.DEEPL_API_KEY,
          text: text,
          target_lang: 'EN',
        },
        timeout: 5000
      }
    );
    return response.data.translations[0].detected_source_language;
  } catch (error) {
    console.error('Erro na detecção de idioma:', {
      status: error.response?.status,
      data: error.response?.data,
      texto: text.substring(0, 50)
    });
    throw error;
  }
}

async function translateText(text, targetLang) {
  try {
    const response = await axios.post(
      'https://api-free.deepl.com/v2/translate',
      null,
      {
        params: {
          auth_key: process.env.DEEPL_API_KEY,
          text: text,
          target_lang: targetLang,
        },
        timeout: 5000
      }
    );
    return response.data.translations[0].text;
  } catch (error) {
    console.error('Erro na tradução:', {
      idiomaAlvo: targetLang,
      status: error.response?.status,
      data: error.response?.data,
      texto: text.substring(0, 50)
    });
    throw error;
  }
}

app.message(async ({ message, say }) => {
  try {
    // Verificação em 4 etapas
    if (
      message.thread_ts ||
      !isValidText(message.text)
    ) {
      console.log('Mensagem ignorada:', {
        ts: message.ts,
        motivo: message.thread_ts ? 'thread' : 'texto inválido',
        tipo: message.subtype || 'mensagem regular',
        texto: message.text ? `${message.text.substring(0, 20)}...` : 'nulo'
      });
      return;
    }

    const cleanText = message.text.trim();
    console.log('Processando mensagem:', {
      ts: message.ts,
      user: message.user,
      texto: cleanText.substring(0, 50) + '...'
    });

    const sourceLang = await detectLanguage(cleanText);
    console.log('Idioma detectado:', sourceLang);

    const targetLanguages = {
      PT: ['EN', 'ES'],
      EN: ['PT', 'ES'],
      ES: ['PT', 'EN'],
      default: []
    };

    const languages = targetLanguages[sourceLang] || targetLanguages.default;
    
    if (languages.length === 0) {
      console.log('Idioma não suportado:', sourceLang);
      await say({
        thread_ts: message.ts,
        text: `Idioma ${sourceLang} não é suportado para tradução.`
      });
      return;
    }

    const translations = await Promise.all(
      languages.map(async (lang) => {
        const translated = await translateText(cleanText, lang);
        return `:${lang.toLowerCase()}: ${translated}`;
      })
    );

    await say({
      thread_ts: message.ts,
      text: translations.join('\n\n'),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Traduções:*\n' + translations.join('\n')
          }
        }
      ]
    });

    console.log('Tradução concluída:', {
      ts: message.ts,
      idiomaOrigem: sourceLang,
      idiomasDestino: languages
    });

  } catch (error) {
    console.error('Erro crítico:', {
      ts: message.ts,
      erro: error.message,
      stack: error.stack?.split('\n')[0],
      respostaAPI: error.response?.data
    });
    
    await say({
      thread_ts: message.ts,
      text: `:warning: Erro ao processar tradução. Detalhes: ${error.message.substring(0, 100)}...`
    });
  }
});

(async () => {
  try {
    await app.start(process.env.PORT || 3000);
    console.log('Bot online - Versão 2.1');
  } catch (error) {
    console.error('Falha na inicialização:', error);
    process.exit(1);
  }
})();
