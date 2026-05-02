/**
 * Script d'indexation du livre Le Code Masculin dans Supabase pgvector
 *
 * USAGE :
 *   1. Place le fichier LE_CODE_MASCULIN.docx dans le dossier /data/
 *   2. Configure SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY dans .env
 *   3. Crée la table dans Supabase (SQL ci-dessous)
 *   4. POST /api/ingest-book (ou node src/ingest.js directement)
 *
 * SQL À EXÉCUTER DANS SUPABASE :
 * ─────────────────────────────────────────────────────────
 * create extension if not exists vector;
 *
 * create table book_chunks (
 *   id          bigserial primary key,
 *   content     text not null,
 *   pillar_id   int,
 *   chapter     text,
 *   page_start  int,
 *   embedding   vector(1536),
 *   created_at  timestamptz default now()
 * );
 *
 * create index on book_chunks
 *   using ivfflat (embedding vector_cosine_ops)
 *   with (lists = 100);
 *
 * create or replace function match_book_chunks(
 *   query_embedding vector(1536),
 *   match_threshold float,
 *   match_count int
 * )
 * returns table (id bigint, content text, pillar_id int, similarity float)
 * language sql stable as $$
 *   select id, content, pillar_id,
 *     1 - (embedding <=> query_embedding) as similarity
 *   from book_chunks
 *   where 1 - (embedding <=> query_embedding) > match_threshold
 *   order by similarity desc
 *   limit match_count;
 * $$;
 * ─────────────────────────────────────────────────────────
 */

import mammoth from 'mammoth';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOK_PATH = join(__dirname, '../data/LE_CODE_MASCULIN.docx');

const PILLAR_KEYWORDS = {
  1: ['force physique', 'corps', 'entraînement', 'physique', 'sport'],
  2: ['discipline', 'habitude', 'routine', 'engagement', 'volonté'],
  3: ['leadership', 'leader', 'guider', 'diriger'],
  4: ['vulnérabilité', 'ouverture', 'stratégique'],
  5: ['but', 'mission', 'purpose', 'sens', 'vocation'],
  6: ['honneur', 'parole', 'intégrité', 'promesse'],
  7: ['présence', 'attention', 'ici', 'maintenant', 'pleinement'],
  8: ['stoïcisme', 'stoïque', 'émotion', 'maîtrise', 'contrôle'],
  9: ['générosité', 'donner', 'partager'],
  10: ['courage', 'peur', 'oser', 'risque'],
  11: ['authenticité', 'authentique', 'masque', 'vrai'],
  12: ['héritage', 'transmettre', 'laisser', 'legacy'],
};

function detectPillar(text) {
  const lower = text.toLowerCase();
  for (const [pillarId, keywords] of Object.entries(PILLAR_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return parseInt(pillarId);
    }
  }
  return null;
}

function chunkText(text, chunkSize = 400) {
  const paragraphs = text
    .split('\n\n')
    .map(p => p.trim())
    .filter(p => p.length > 80);

  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    const wordCount = (current + ' ' + para).split(/\s+/).length;
    if (wordCount > chunkSize && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function getEmbedding(text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text.substring(0, 8000),
      model: 'text-embedding-3-small',
    }),
  });

  const data = await response.json();
  if (!data?.data?.[0]?.embedding) {
    throw new Error('Embedding API error: ' + JSON.stringify(data));
  }
  return data.data[0].embedding;
}

export async function ingestBook() {
  console.log('📚 Démarrage de l\'indexation du livre...');

  if (!existsSync(BOOK_PATH)) {
    throw new Error(`Fichier introuvable : ${BOOK_PATH}\nPlace le fichier LE_CODE_MASCULIN.docx dans /data/`);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Extraire le texte du .docx
  console.log('📄 Extraction du texte...');
  const { value: rawText } = await mammoth.extractRawText({ path: BOOK_PATH });
  console.log(`✅ ${rawText.length} caractères extraits`);

  // Découper en chunks
  const chunks = chunkText(rawText, 400);
  console.log(`✂️  ${chunks.length} chunks créés`);

  // Supprimer les anciens chunks
  await supabase.from('book_chunks').delete().neq('id', 0);
  console.log('🗑️  Anciens chunks supprimés');

  // Vectoriser et insérer
  let success = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const embedding = await getEmbedding(chunk);
      const pillarId = detectPillar(chunk);

      const { error } = await supabase.from('book_chunks').insert({
        content: chunk,
        embedding,
        pillar_id: pillarId,
      });

      if (error) throw error;
      success++;

      if (i % 10 === 0) {
        console.log(`⏳ Progression : ${i + 1}/${chunks.length} chunks indexés`);
      }

      // Pause pour éviter le rate limit
      await new Promise(r => setTimeout(r, 150));

    } catch (err) {
      console.error(`❌ Chunk ${i} échoué:`, err.message);
    }
  }

  console.log(`\n✅ Indexation terminée : ${success}/${chunks.length} chunks indexés`);
}

// Exécution directe : node src/ingest.js
if (process.argv[1].includes('ingest')) {
  ingestBook().catch(console.error);
}
