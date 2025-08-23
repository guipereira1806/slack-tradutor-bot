require('dotenv').config();
const { App } = require('@slack/bolt');

// --- Bloco de depuração para verificar as variáveis de ambiente ---
console.log('--- Verificando Variáveis de Ambiente ---');
console.log('SLACK_SIGNING_SECRET:', process.env.SLACK_SIGNING_SECRET ? 'Encontrada ✅' : 'Não encontrada ❌');
console.log('SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? 'Encontrada ✅' : 'Não encontrada ❌');
console.log('DEEPL_API_KEY:', process.env.DEEPL_API_KEY ? 'Encontrada ✅' : 'Não encontrada ❌');
console.log('-----------------------------------------');

// --- Inicialização da App Bolt (apenas o essencial) ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// --- Lógica de inicialização do servidor ---
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('🚀 Tradutor minimalista está online!');
})();
