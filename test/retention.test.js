const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideRetention, DAY_MS } = require('../src/retention');

const NOW = new Date('2027-06-01T12:00:00Z');
const at = (days) => new Date(NOW.getTime() + days * DAY_MS).toISOString();
// Effacement prévu à NOW + eraseInDays jours (6 mois après la dernière activité).
const cand = (eraseInDays, extra = {}) => ({
  user_id: 'u1', email: 'homme@exemple.fr', prenom: 'Jean',
  last_activity_at: at(eraseInDays - 183), erase_after: at(eraseInDays),
  warn30_sent_at: null, warn7_sent_at: null, ...extra,
});

test('rien avant J-30', () => {
  assert.equal(decideRetention(cand(31), NOW).action, 'wait');
});

test('J-30 : premier avertissement, date annoncée = date prévue', () => {
  const d = decideRetention(cand(30), NOW);
  assert.equal(d.action, 'warn30');
  assert.equal(d.eraseOn.toISOString(), at(30));
});

test('date déjà dépassée sans avertissement : J-30 d’abord, effacement repoussé à +30 jours', () => {
  const d = decideRetention(cand(-10), NOW);
  assert.equal(d.action, 'warn30');
  assert.equal(d.eraseOn.toISOString(), at(30));
});

test('J-30 envoyé : J-7 seulement à 7 jours de la date prévue', () => {
  assert.equal(decideRetention(cand(8, { warn30_sent_at: at(-22) }), NOW).action, 'wait');
  const d = decideRetention(cand(7, { warn30_sent_at: at(-23) }), NOW);
  assert.equal(d.action, 'warn7');
  assert.equal(d.eraseOn.toISOString(), at(7));
});

test('jamais moins de 30 jours entre le premier avertissement et l’effacement', () => {
  // Date prévue dépassée, J-30 envoyé il y a 10 jours : J-7 attend.
  assert.equal(decideRetention(cand(-5, { warn30_sent_at: at(-10) }), NOW).action, 'wait');
  assert.equal(decideRetention(cand(-5, { warn30_sent_at: at(-23) }), NOW).action, 'warn7');
});

test('effacement : seulement 7 jours après J-7 et 30 jours après J-30', () => {
  assert.equal(decideRetention(cand(-1, { warn30_sent_at: at(-31), warn7_sent_at: at(-6) }), NOW).action, 'wait');
  assert.equal(decideRetention(cand(-1, { warn30_sent_at: at(-31), warn7_sent_at: at(-7) }), NOW).action, 'erase');
  assert.equal(decideRetention(cand(-1, { warn30_sent_at: at(-29), warn7_sent_at: at(-8) }), NOW).action, 'wait');
});

test('avertissements envoyés AVANT une nouvelle activité : ils ne comptent plus', () => {
  const c = cand(30, { warn30_sent_at: at(-200), warn7_sent_at: at(-190) });
  assert.equal(decideRetention(c, NOW).action, 'warn30');
});

test('sans email : jamais d’avertissement, donc jamais d’effacement', () => {
  const c = cand(-100, { email: null, warn30_sent_at: at(-60), warn7_sent_at: at(-40) });
  assert.deepEqual(decideRetention(c, NOW), { action: 'skip', reason: 'no_email' });
});

test('dates invalides : rien', () => {
  assert.equal(decideRetention(cand(0, { erase_after: 'x' }), NOW).action, 'skip');
});
