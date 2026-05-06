/**
 * rag.js — RAG vectoriel pour Prince Johann IA
 * Remplace le matching par mots-clés par une recherche sémantique
 * dans Supabase pgvector via Voyage AI embeddings.
 *
 * Interface identique à l'ancien rag.js :
 *   const { searchBookContext } = require('./rag');
 *   const context = await searchBookContext(query);  ← devient async
 */

const { createClient } = require('@supabase/supabase-js');

// Initialisation Supabase (utilise les variables d'env déjà sur Railway)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ──────────────────────────────────────────────────────
// Embedding via Voyage AI (fetch natif — pas de SDK)
// ──────────────────────────────────────────────────────
async function embedQuery(text) {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: [text],
      input_type: 'query',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage AI error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// ──────────────────────────────────────────────────────
// Recherche sémantique dans Supabase
// ──────────────────────────────────────────────────────
async function searchBookContext(query) {
  try {
    // 1. Générer l'embedding de la question
    const queryEmbedding = await embedQuery(query);

    // 2. Chercher les chunks les plus proches
    const { data, error } = await supabase.rpc('search_skills', {
      query_embedding: queryEmbedding,
      match_threshold: 0.60,
      match_count: 4,
      filter_skills: null,
    });

    if (error) throw new Error(`Supabase error: ${error.message}`);

    if (!data || data.length === 0) {
      return 'Réponds en te basant sur ta philosophie des 12 piliers du Code Masculin.';
    }

    // 3. Formater les chunks pour le system prompt
    // Dédupliquer par skill_name pour avoir de la variété
    const seen = new Set();
    const unique = data.filter((c) => {
      if (seen.has(c.skill_name)) return false;
      seen.add(c.skill_name);
      return true;
    });

    const context = unique
      .slice(0, 3)
      .map((c) => {
        // Extraire le contenu brut (sans la ligne "Skill: xxx\nSection: xxx\n...")
        const lines = c.content.split('\n');
        const contentStart = lines.findIndex((l) => l.trim() === '');
        const rawContent = contentStart >= 0
          ? lines.slice(contentStart + 1).join('\n').trim()
          : c.content;

        return `[${c.skill_name.replace('skill-', '').replace(/-/g, ' ')} — section : ${c.section}]\n${rawContent.slice(0, 800)}`;
      })
      .join('\n\n---\n\n');

    return context;

  } catch (err) {
    // Fallback silencieux : si le RAG échoue, Claude répond sans contexte
    console.error('[RAG] Erreur recherche sémantique:', err.message);
    return 'Réponds en te basant sur ta philosophie des 12 piliers du Code Masculin.';
  }
}

module.exports = { searchBookContext };