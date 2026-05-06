require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./systemPrompt');
const { searchBookContext } = require('./rag');

const app = express();
const PORT = process.env.PORT || 3001;

// Vérification clé API au démarrage
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n❌ ANTHROPIC_API_KEY manquante dans .env');
  console.error('1. Ouvre le fichier .env');
  console.error('2. Ajoute : ANTHROPIC_API_KEY=sk-ant-ta-cle-ici');
  console.error('3. Relance : npm run dev\n');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Trop de messages. Attends une minute.' },
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Prince Johann IA est en ligne.',
    model: 'claude-opus-4-5',
  });
});

// POST /api/chat
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, conversationHistory = [] } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message manquant.' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message trop long.' });
  }

  try {
    // 1. Recherche contextuelle RAG
    const ragContext = await searchBookContext(message);

    // 2. System prompt
    const systemPrompt = buildSystemPrompt(ragContext);

    // 3. Historique (max 20 messages)
    const history = conversationHistory
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content }));

    // 4. Config SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // 5. Appel Claude en streaming
    const stream = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [
        ...history,
        { role: 'user', content: message.trim() },
      ],
      stream: true,
    });

    // 6. Envoi token par token
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ token: event.delta.text })}\n\n`);
      }
      if (event.type === 'message_stop') {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        break;
      }
    }

    res.end();

  } catch (err) {
    console.error('Erreur:', err.message);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: 'Erreur serveur.' })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});
app.post('/api/chat-simple', chatLimiter, async (req, res) => {
  const { message, conversationHistory = [] } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message manquant.' });
  try {
    const ragContext = await searchBookContext(message);
    const systemPrompt = buildSystemPrompt(ragContext);
    const history = conversationHistory.slice(-20).map(m => ({ role: m.role, content: m.content }));
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: message.trim() }],
    });
    res.json({ response: response.content[0]?.text || '' });
  } catch (err) {
    console.error('Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// Démarrage
app.listen(PORT, () => {
  console.log('\n🔥 Prince Johann IA — Serveur démarré');
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`🤖 Modèle : claude-opus-4-5`);
  console.log(`🔑 Clé Anthropic : ✅ configurée`);
  console.log(`📚 RAG : actif (mode mots-clés)`);
  console.log('\n✅ Prêt à recevoir des messages.\n');
});
