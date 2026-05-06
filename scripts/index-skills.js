/**
 * index-skills.js — Indexation des skills Prince Johann IA
 * Utilise fetch natif pour Voyage AI (évite les bugs du SDK)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '../skills');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function embedBatch(texts) {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: texts,
      input_type: 'document',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage AI error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.data.map((d) => d.embedding);
}

function chunkSkillFile(skillName, content) {
  const chunks = [];
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  const description = frontmatterMatch
    ? (frontmatterMatch[1].match(/description:\s*>?\s*([\s\S]*?)(?=\n\w|\n---)/)?.[1] || '').trim()
    : '';

  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
  const sections = body.split(/\n(?=## )/);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    if (lines.length === 0) continue;
    const sectionTitle = lines[0].replace(/^#+\s*/, '').trim();
    const sectionContent = lines.slice(1).join('\n').trim();
    if (sectionContent.length < 50) continue;

    const chunkText = [
      `Skill: ${skillName}`,
      `Section: ${sectionTitle}`,
      description ? `Description: ${description.slice(0, 150)}` : '',
      '',
      sectionContent,
    ].filter(Boolean).join('\n');

    chunks.push({
      skill_name: skillName,
      section: sectionTitle,
      content: chunkText,
      metadata: { description: description.slice(0, 200), section_title: sectionTitle },
    });
  }

  if (chunks.length === 0) {
    chunks.push({
      skill_name: skillName,
      section: 'complet',
      content: `Skill: ${skillName}\n\n${body.trim()}`,
      metadata: { description: description.slice(0, 200), section_title: 'complet' },
    });
  }

  return chunks;
}

async function main() {
  console.log('🚀 Prince Johann IA — Indexation des skills\n');

  for (const key of ['VOYAGE_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
    if (!process.env[key]) {
      console.error(`❌ Variable manquante : ${key} — vérifie ton .env`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(SKILLS_DIR)) {
    console.error(`❌ Dossier skills/ introuvable : ${SKILLS_DIR}`);
    process.exit(1);
  }

  const skillDirs = fs.readdirSync(SKILLS_DIR).filter((d) =>
    fs.statSync(path.join(SKILLS_DIR, d)).isDirectory() && d.startsWith('skill-')
  );

  console.log(`📚 ${skillDirs.length} skills trouvées\n`);
  const allChunks = [];

  for (const skillDir of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf-8');
    const chunks = chunkSkillFile(skillDir, content);
    allChunks.push(...chunks);
    console.log(`  ✅ ${skillDir} → ${chunks.length} chunks`);
  }

  console.log(`\n📊 Total : ${allChunks.length} chunks\n`);

  console.log('🗑️  Nettoyage...');
  await supabase.from('skill_chunks').delete().neq('id', 0);

  const BATCH_SIZE = 20;
  console.log('🔢 Génération des embeddings...\n');

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const n = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(allChunks.length / BATCH_SIZE);
    process.stdout.write(`  Batch ${n}/${total}...`);

    const embeddings = await embedBatch(batch.map((c) => c.content));
    const rows = batch.map((chunk, idx) => ({
      skill_name: chunk.skill_name,
      section: chunk.section,
      content: chunk.content,
      embedding: embeddings[idx],
      metadata: chunk.metadata,
    }));

    const { error } = await supabase.from('skill_chunks').insert(rows);
    if (error) { console.error(`\n❌ ${error.message}`); process.exit(1); }

    process.stdout.write(' ✅\n');
    if (i + BATCH_SIZE < allChunks.length) await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`\n✨ ${allChunks.length} chunks indexés dans Supabase !\n`);
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
