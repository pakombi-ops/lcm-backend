require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./systemPrompt');
const { searchBookContext } = require('./rag');
const { requireUser } = require('./auth');
const { detectCrisis, CRISIS_REPLY } = require('./safety');
const { createQuota } = require('./quota');
const { validateChatBody } = require('./chatValidation');
const { createClient } = require('@supabase/supabase-js');
const entitlementsRoutes = require('../routes/entitlements');
const accountRoutes = require('../routes/account');

const app = express();
app.set('trust proxy', 1); // Railway : IP réelle pour le rate limiting
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
const quota = createQuota(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));

// Réserve un message AVANT l'appel au modèle. Répond lui-même si refus. Retourne la réservation ou null.
async function reserveOrReply(req, res) {
  try {
    const r = await quota.reserve(req.user.id);
    if (r.ok) return r;
    if (r.reason === 'limit') res.status(402).json({ error: 'quota_exceeded', used: r.used, limit: r.limit });
    else res.status(429).json({ error: 'busy', message: 'Réessaie dans un instant.' });
  } catch (err) {
    console.error('quota:', err.message);
    res.status(503).json({ error: 'quota_unavailable' });
  }
  return null;
}

// Middlewares
// APRÈS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors()); // Gère les pre-flight requests mobiles
// 64 Ko suffisent largement : message ≤ 2000 caractères + 20 messages d'historique.
app.use(express.json({ limit: '64kb' }));
app.use('/api', entitlementsRoutes);
// Suppression de compte (DELETE /api/account) et tâche de conservation (Make).
app.use('/api', accountRoutes);

// Rate limiting
// 1) par IP, AVANT la vérification du jeton : limite aussi les appels sans compte.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CHAT_RATE_MAX) || 30,
  message: { error: 'Trop de messages. Attends une minute.' },
});
// 2) par compte (après requireUser) : un compte ne peut pas contourner la limite en changeant d'IP.
//    Compteurs en mémoire : remis à zéro à chaque redémarrage (une seule instance Railway).
const byUser = (req) => req.user.id;
const userMinuteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.CHAT_USER_RATE_MAX) || 8,
  keyGenerator: byUser,
  message: { error: 'Trop de messages. Attends une minute.' },
});
const userDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: Number(process.env.CHAT_USER_DAILY_MAX) || 150,
  keyGenerator: byUser,
  message: { error: 'daily_limit', message: 'Limite quotidienne atteinte. Reviens demain.' },
});
const chatGuards = [chatLimiter, requireUser, userMinuteLimiter, userDailyLimiter];

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Prince Johann IA est en ligne.',
    model: 'claude-opus-4-5',
  });
});

// POST /api/chat
app.post('/api/chat', chatGuards, async (req, res) => {
  const input = validateChatBody(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const { message, history } = input;

  if (detectCrisis(message)) {
    return res.json({ response: CRISIS_REPLY, safety: true });
  }

  const reservation = await reserveOrReply(req, res);
  if (!reservation) return;

  try {
    // 1. Recherche contextuelle RAG
    const ragContext = await searchBookContext(message);

    // 2. System prompt
    const systemPrompt = buildSystemPrompt(ragContext);

    // 3. Historique : déjà validé et réduit à 20 messages (validateChatBody)

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
        { role: 'user', content: message },
      ],
      stream: true,
    });

    // 6. Envoi token par token
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ token: event.delta.text })}\n\n`);
      }
      if (event.type === 'message_stop') {
        res.write(`data: ${JSON.stringify({ done: true, quota: { used: reservation.used, limit: reservation.limit, premium: reservation.premium } })}\n\n`);
        break;
      }
    }

    res.end();

  } catch (err) {
    console.error('Erreur:', err.message);
    if (!reservation.premium) await quota.refund(req.user.id);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: 'Erreur serveur.' })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});
app.post('/api/chat-simple', chatGuards, async (req, res) => {
  const input = validateChatBody(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const { message, history } = input;
  if (detectCrisis(message)) return res.json({ response: CRISIS_REPLY, safety: true });
  const reservation = await reserveOrReply(req, res);
  if (!reservation) return;
  try {
    const ragContext = await searchBookContext(message);
    const systemPrompt = buildSystemPrompt(ragContext);
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: message }],
    });
    res.json({
      response: response.content[0]?.text || '',
      quota: { used: reservation.used, limit: reservation.limit, premium: reservation.premium },
    });
  } catch (err) {
    console.error('Erreur:', err.message);
    if (!reservation.premium) await quota.refund(req.user.id);
    res.status(502).json({ error: 'provider_error' });
  }
});
// Démarrage
// Erreurs de lecture du corps (JSON invalide, corps > 64 Ko) : réponse JSON courte,
// sans la trace de pile qu'affiche le gestionnaire par défaut d'Express.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  console.error('Erreur non gérée:', err.message);
  res.status(500).json({ error: 'server_error' });
});

// Filet de sécurité : une promesse rejetée dans une route async (Express 4 ne les
// intercepte pas) ne doit plus arrêter tout le serveur. On journalise et on continue.
process.on('unhandledRejection', (reason) => {
  console.error('Promesse rejetée non gérée:', reason && reason.message ? reason.message : reason);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('\n🔥 Prince Johann IA — Serveur démarré');
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`🤖 Modèle : claude-opus-4-5`);
    console.log(`🔑 Clé Anthropic : ✅ configurée`);
    console.log(`📚 RAG : actif (mode mots-clés)`);
    console.log('\n✅ Prêt à recevoir des messages.\n');
  });
}

module.exports = app;
