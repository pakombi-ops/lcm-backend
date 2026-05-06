/**
 * routes/chat.js
 * ==============
 * Route POST /chat — Prince Johann IA avec RAG
 * À ajouter dans ton serveur Express existant sur Railway
 */

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import VoyageAI from 'voyageai';

const router = express.Router();

// ─────────────────────────────────────────────────────
// Clients (utilisent les variables d'env Railway)
// ─────────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const voyage = new VoyageAI.default({
  apiKey: process.env.VOYAGE_API_KEY,
});

// ─────────────────────────────────────────────────────
// INTENT MAP — détection de la situation de l'homme
// ─────────────────────────────────────────────────────
const INTENT_MAP = [
  {
    name: 'crise',
    keywords: ['plus envie', 'pourquoi continuer', 'tout quitter', 'plus de sens',
               'vide', 'nul', 'effondré', 'séparé', 'licencié', 'burnout'],
    skills: ['skill-gestion-crise', 'skill-journal-stoicien'],
  },
  {
    name: 'journal_soir',
    keywords: ['journal', 'bilan', 'ce soir', 'avant de dormir', 'réfléchir'],
    skills: ['skill-journal-stoicien', 'skill-affirmations'],
  },
  {
    name: 'couple',
    keywords: ['femme', 'partenaire', 'couple', 'relation', 'dispute',
               'explosé', 'elle dit', 'désir', 'plus d\'amour'],
    skills: ['skill-coaching-couple', 'skill-pause-observe-choisis',
             'skill-cnv-conversation-difficile'],
  },
  {
    name: 'diagnostic',
    keywords: ['par où commencer', 'perdu', 'incomplet', 'tourner en rond',
               'sans direction', 'premier pas', 'démarrer', 'nouveau'],
    skills: ['skill-diagnostic-12-piliers', 'skill-plan-action-90-jours'],
  },
  {
    name: 'discipline',
    keywords: ['discipline', 'habitude', 'motivation', 'procrastination',
               'me lever', 'routine', 'tenir', 'engagement'],
    skills: ['skill-routine-matinale', 'skill-affirmations', 'skill-contrat-avec-soi'],
  },
  {
    name: 'emotion',
    keywords: ['explosé', 'colère', 'énervé', 'panique', 'peur', 'anxieux',
               'honte', 'frustré', 'perdu mon calme', 'réaction'],
    skills: ['skill-pause-observe-choisis', 'skill-journal-stoicien'],
  },
  {
    name: 'presence',
    keywords: ['présent', 'présence', 'distrait', 'téléphone', 'absent',
               'mes enfants', 'attention', 'ici'],
    skills: ['skill-routine-matinale', 'skill-journal-reflexion-pilier'],
  },
];

function detectIntent(message) {
  const lower = message.toLowerCase();
  const matched = [];
  for (const intent of INTENT_MAP) {
    const hits = intent.keywords.filter((kw) => lower.includes(kw));
    if (hits.length > 0) matched.push({ ...intent, score: hits.length });
  }
  matched.sort((a, b) => b.score - a.score);
  return matched.slice(0, 2);
}

// ─────────────────────────────────────────────────────
// SYSTEM PROMPT DE BASE — voix Prince Johann
// ─────────────────────────────────────────────────────
const BASE_SYSTEM = `Tu es Prince Johann IA — l'assistant du Code Masculin, créé par Prince Johann Akombi de Pilier Conscient.

RÈGLES ABSOLUES :
- Tutoiement SYSTÉMATIQUE — "tu", "toi", "ton" — jamais "vous"
- Langage direct, incarné, phrases courtes et percutantes
- Jamais : "alpha", "bêta", "red pill", coaching générique
- Jamais : "crois en toi", "sors de ta zone de confort"
- Tu parles comme un homme transformé qui transmet — pas comme un thérapeute

LEXIQUE :
- "les 12 Piliers" (pas "les étapes")
- "Le Code Masculin" (pas "le programme")
- "pilier" (pas "aspect")
- "centre" (pas "équilibre")

POSTURE :
- Écouter avant d'analyser
- Si détresse profonde → présence d'abord, solutions ensuite
- Maximum 3 paragraphes courts par réponse — pas de roman
- Terminer souvent par une question ou une invitation à l'action`;

// ─────────────────────────────────────────────────────
// RAG — Récupération des skills pertinentes
// ─────────────────────────────────────────────────────
async function retrieveSkills(message, prioritySkills = []) {
  try {
    // Embedding de la question
    const embedResponse = await voyage.embed({
      model: 'voyage-3',
      input: [message],
      input_type: 'query',
    });
    const queryEmbedding = embedResponse.data[0].embedding;

    // Recherche dans Supabase
    const { data } = await supabase.rpc('search_skills', {
      query_embedding: queryEmbedding,
      match_threshold: 0.62,
      match_count: 4,
      filter_skills: prioritySkills.length > 0 ? prioritySkills : null,
    });

    // Si peu de résultats avec filtre → élargir
    if (!data || data.length < 2) {
      const { data: broad } = await supabase.rpc('search_skills', {
        query_embedding: queryEmbedding,
        match_threshold: 0.58,
        match_count: 4,
        filter_skills: null,
      });
      return broad || [];
    }

    return data;
  } catch (err) {
    console.error('RAG retrieval error:', err.message);
    return []; // Fallback : répondre sans RAG
  }
}

// ─────────────────────────────────────────────────────
// POST /chat — Endpoint principal avec streaming SSE
// ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { messages, userId } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages requis' });
  }

  // Le dernier message de l'utilisateur
  const lastUserMessage = messages[messages.length - 1]?.content || '';

  // Détection d'intention
  const intents = detectIntent(lastUserMessage);
  const prioritySkills = [...new Set(intents.flatMap((i) => i.skills))];

  console.log(`[chat] userId=${userId} | intents=${intents.map(i => i.name).join(',')} | skills=${prioritySkills.join(',')}`);

  // Récupération RAG
  const chunks = await retrieveSkills(lastUserMessage, prioritySkills);
  const skillsContext = chunks
    .map((c) => `--- ${c.skill_name} (${c.section}) ---\n${c.content}`)
    .join('\n\n');

  // System prompt enrichi avec les skills
  const systemPrompt = skillsContext.length > 0
    ? `${BASE_SYSTEM}\n\n## SKILLS ACTIVES\n${skillsContext}`
    : BASE_SYSTEM;

  // ── Streaming SSE ──────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  try {
    // Formater les messages pour Claude (sans le message de bienvenue)
    const claudeMessages = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.content && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    // Appel Claude avec streaming
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: systemPrompt,
      messages: claudeMessages,
    });

    // Envoyer les tokens au fil de l'eau
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const token = event.delta.text;
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      }
    }

    // Fin du stream
    res.write(`data: ${JSON.stringify({ done: true, skills: chunks.map(c => c.skill_name) })}\n\n`);
    res.end();

  } catch (error) {
    console.error('[chat] Claude error:', error.message);
    res.write(`data: ${JSON.stringify({ error: 'Erreur de génération' })}\n\n`);
    res.end();
  }
});

export default router;
