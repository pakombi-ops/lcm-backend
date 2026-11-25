// Validation du corps des routes du coach (/api/chat, /api/chat-simple).
// Toute valeur venant du client est vérifiée AVANT usage : un type inattendu
// (ex. {"message": 42}) faisait lever une exception hors du try, ce qui
// arrêtait le processus Node (rejet de promesse non géré).
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_ITEMS = 20; // seuls les 20 derniers messages sont envoyés au modèle
const MAX_HISTORY_ITEM_CHARS = 4000; // une réponse du coach (600 jetons) tient largement
const DEFAULT_HISTORY_MAX_CHARS = 12000; // plafond total de l'historique envoyé au modèle
const ROLES = ['user', 'assistant'];

// Retourne { ok: true, message, history } ou { ok: false, error }.
function validateChatBody(body) {
  const { message, conversationHistory = [] } = body && typeof body === 'object' ? body : {};

  if (typeof message !== 'string' || !message.trim()) return { ok: false, error: 'Message manquant.' };
  if (message.length > MAX_MESSAGE_CHARS) return { ok: false, error: 'Message trop long.' };
  if (!Array.isArray(conversationHistory)) return { ok: false, error: 'Historique invalide.' };

  // Les entrées mal formées sont ignorées ; une entrée trop longue est tronquée
  // plutôt que refusée, pour ne pas bloquer définitivement une conversation.
  const items = conversationHistory
    .filter((m) => m && typeof m === 'object' && ROLES.includes(m.role)
      && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY_ITEMS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_ITEM_CHARS) }));

  // Plafond TOTAL (coût par appel borné) : on garde les messages les plus récents
  // tant que leur somme tient dans le plafond, et on écarte les plus anciens.
  const maxTotal = historyMaxChars();
  const history = [];
  let total = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    total += items[i].content.length;
    if (total > maxTotal) break;
    history.unshift(items[i]);
  }

  return { ok: true, message: message.trim(), history };
}

// Variable Railway CHAT_HISTORY_MAX_CHARS (lue à chaque appel), 12 000 caractères par défaut.
function historyMaxChars() {
  const raw = String(process.env.CHAT_HISTORY_MAX_CHARS ?? '').trim();
  const v = Number(raw);
  // variable absente, vide ou invalide → défaut (une variable vide ne doit pas vider l'historique)
  return raw !== '' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_HISTORY_MAX_CHARS;
}

module.exports = {
  validateChatBody, historyMaxChars,
  MAX_MESSAGE_CHARS, MAX_HISTORY_ITEMS, MAX_HISTORY_ITEM_CHARS, DEFAULT_HISTORY_MAX_CHARS,
};
