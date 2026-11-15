// Filet de sécurité du coach : détection de détresse grave AVANT l'appel au modèle.
// PROPOSITION : le texte et la liste de mots sont à faire valider par Prince
// (et idéalement par un professionnel de la santé mentale). Numéros vérifiés le
// 12 nov. 2026 : 3114.fr (France), suicide.ca et 988.ca (Québec/Canada),
// preventionsuicide.be (Belgique), 143.ch (Suisse). Urgences : service-public.gouv.fr (15, 112),
// quebec.ca (911), 112.be, ch.diplomatie.gouv.fr (144). Détection par mots-clés : aucune garantie.
const CRISIS_PATTERNS = [
  /\bme suicider\b/i,
  /\bmettre fin à (mes|ma) (jours|vie)\b/i,
  /\ben finir (avec|pour) (la vie|tout)\b/i,
  /\bj'?ai envie de (mourir|me tuer|disparaître)\b/i,
  /\b(plus|pas) envie de vivre\b/i,
  /\bme tuer\b/i,
  /\bvouloir mourir\b/i,
  /\bidées? suicidaires?\b/i,
  /\bpenser? au suicide\b/i,
  /\bpasser à l'acte\b/i,
  /\bme faire du mal\b/i,
  /\bje veux (en finir|mourir)\b/i,
];

const CRISIS_REPLY = [
  "Ce que tu viens d'écrire est sérieux, et je ne vais pas te répondre avec un conseil de coaching. Tu n'as pas à porter ça seul, maintenant.",
  "Parle à quelqu'un tout de suite. Ces lignes sont gratuites, confidentielles et ouvertes 24 h sur 24 :",
  "- France : 3114",
  "- Québec : 1 866 APPELLE (1 866 277-3553), ou 9-8-8 partout au Canada (appel ou texto)",
  "- Belgique : 0800 32 123",
  "- Suisse : 143",
  "Si tu es en danger immédiat, appelle les urgences de ton pays (911 au Canada, 15 ou 112 en France, 112 en Belgique, 144 en Suisse) ou va à l'hôpital le plus proche.",
  "Si une personne de confiance est près de toi, dis-lui ce soir ce que tu m'as écrit.",
].join('\n');

function detectCrisis(text) {
  const t = String(text || '');
  return CRISIS_PATTERNS.some((re) => re.test(t));
}

module.exports = { detectCrisis, CRISIS_REPLY };
