# LCM Backend — Prince Johann IA

## Installation et démarrage

```bash
npm install
cp .env.example .env
# Remplis ANTHROPIC_API_KEY dans .env
npm run dev
```

Le serveur démarre sur http://localhost:3001

## Tester l'IA immédiatement

```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Comment améliorer ma discipline ?"}'
```

## Connecter à l'app mobile

Dans `src/screens/coach/CoachScreen.tsx`, ligne BACKEND_URL :
- Réseau local : `http://192.168.X.X:3001` (IP de ton ordinateur)
- Production : `https://ton-domaine.com`

## Indexer le livre (RAG complet)

1. Place `LE_CODE_MASCULIN.docx` dans `/data/`
2. Configure SUPABASE_URL + SUPABASE_SERVICE_KEY + OPENAI_API_KEY
3. `curl -X POST http://localhost:3001/api/ingest-book`

## Variables d'environnement

| Variable | Requis | Description |
|---|---|---|
| ANTHROPIC_API_KEY | ✅ | Clé API Claude |
| SUPABASE_URL | ⚠️ optionnel | Pour RAG vectoriel |
| SUPABASE_SERVICE_KEY | ⚠️ optionnel | Pour RAG vectoriel |
| OPENAI_API_KEY | ⚠️ optionnel | Pour les embeddings |
| PORT | non | Port (défaut 3001) |
