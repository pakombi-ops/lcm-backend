/**
 * Charge src/index.js avec des doubles : Supabase et Stripe (fakes.js),
 * Anthropic (aucun appel réseau) et le RAG (pas d'appel à Voyage).
 * Les limites sont lues à l'import : fixer process.env AVANT d'appeler loadChatApp().
 */
const path = require('path');
const { installFakes } = require('./fakes');

const anthropicCalls = [];
const anthropicState = { fail: false, reply: 'Réponse du coach' };

class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async (params) => {
        anthropicCalls.push(params);
        if (anthropicState.fail) throw new Error('fournisseur indisponible');
        return { content: [{ type: 'text', text: anthropicState.reply }] };
      },
    };
  }
}

function mockPath(file, exports) {
  const resolved = require.resolve(file);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function loadChatApp() {
  installFakes();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  mockPath('@anthropic-ai/sdk', Object.assign(FakeAnthropic, { default: FakeAnthropic }));
  mockPath(path.join(__dirname, '..', '..', 'src', 'rag.js'), { searchBookContext: async () => '' });
  return require('../../src/index.js');
}

module.exports = { loadChatApp, anthropicCalls, anthropicState };
