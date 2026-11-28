// Effacement des comptes : suppression demandée par le membre, et tâche
// quotidienne de conservation (6 mois sans connexion ni abonnement).
// Les deux passent par la même procédure (src/accountErasure.js).
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { requireUser, requireMakeSecret } = require('../src/auth');
const { callLms } = require('../src/lmsSync');
const brevo = require('../src/brevo');
const { createAccountErasure } = require('../src/accountErasure');
const { decideRetention } = require('../src/retention');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const transmissionPriceIds = () => (process.env.TRANSMISSION_PRICE_IDS || '')
  .split(',').map((id) => id.trim()).filter(Boolean);

const erasure = createAccountErasure({ supabase, stripe, callLms, brevo, transmissionPriceIds });

// Le code email doit avoir été saisi il y a moins de 5 minutes (nouvelle session).
const REAUTH_MAX_MS = 5 * 60 * 1000;
const CONFIRMATION_WORD = 'SUPPRIMER';
// Au plus N effacements par passage : limite les dégâts d'une erreur de règle.
const MAX_ERASURES_PER_RUN = 20;

const REFUSAL_STATUS = { founder_protected: 409, transmission_plan: 409, active_subscription: 409, not_found: 404 };

// DELETE /api/account   Corps : { confirm: "SUPPRIMER", eraseCommunityText?: boolean (vrai par défaut) }
// Désactivée (503) tant que ENABLE_ACCOUNT_DELETE ne vaut pas "true".
router.delete('/account', requireUser, async (req, res) => {
  if (process.env.ENABLE_ACCOUNT_DELETE !== 'true') return res.status(503).json({ error: 'delete_unavailable' });
  if (req.body?.confirm !== CONFIRMATION_WORD) return res.status(400).json({ error: 'confirmation_required' });

  const last = Date.parse(req.user.last_sign_in_at || '');
  if (!last || Date.now() - last > REAUTH_MAX_MS) return res.status(403).json({ error: 'reauth_required' });

  try {
    const result = await erasure.eraseAccount({
      userId: req.user.id,
      reason: 'user_request',
      eraseCommunityText: req.body?.eraseCommunityText !== false,
    });
    if (!result.ok) return res.status(REFUSAL_STATUS[result.code] || 409).json({ error: result.code });
    res.json({ deleted: true, canceledSubscriptions: result.canceledSubscriptions.length, pending: result.pending });
  } catch (err) {
    console.error('Erreur suppression de compte :', err.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

// POST /api/maintenance/retention-run   (scénario Make quotidien, x-make-secret)
// Corps : { dryRun?: boolean } — dryRun vaut vrai par défaut. Sans
// ENABLE_RETENTION_ERASURE="true", la tâche reste en simulation : aucun email,
// aucun effacement. Seule la mesure d'activité (refresh_last_seen) est écrite,
// pour que la simulation soit juste.
// La réponse ne contient que des identifiants de compte, jamais d'email.
router.post('/maintenance/retention-run', requireMakeSecret, async (req, res) => {
  const live = req.body?.dryRun === false && process.env.ENABLE_RETENTION_ERASURE === 'true';
  const report = { mode: live ? 'live' : 'dry_run', warned30: [], warned7: [], erased: [], refused: [], errors: [], skipped: 0, resumed: null };

  try {
    const { error: refreshError } = await supabase.rpc('refresh_last_seen');
    if (refreshError) throw new Error(`refresh_last_seen : ${refreshError.message}`);

    if (live) report.resumed = await erasure.resumePending();

    const { data: candidates, error } = await supabase.rpc('retention_candidates', { p_horizon: '31 days' });
    if (error) throw new Error(`retention_candidates : ${error.message}`);

    const now = new Date();
    for (const candidate of candidates || []) {
      const decision = decideRetention(candidate, now);
      const id = candidate.user_id;

      if (decision.action === 'warn30' || decision.action === 'warn7') {
        const list = decision.action === 'warn30' ? report.warned30 : report.warned7;
        if (!live) { list.push(id); continue; }
        const templateId = decision.action === 'warn30'
          ? process.env.BREVO_TEMPLATE_ERASURE_J30
          : process.env.BREVO_TEMPLATE_ERASURE_J7;
        const sent = await brevo.sendTemplate(templateId, candidate.email, {
          PRENOM: candidate.prenom || '',
          DATE_EFFACEMENT: decision.eraseOn.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }),
        });
        if (!sent.ok) { report.errors.push({ id, step: decision.action, error: sent.httpStatus || sent.error }); continue; }
        const column = decision.action === 'warn30' ? 'erasure_warn30_sent_at' : 'erasure_warn7_sent_at';
        const { error: markError } = await supabase.from('profiles').update({ [column]: now.toISOString() }).eq('id', id);
        if (markError) report.errors.push({ id, step: `${decision.action}_mark`, error: markError.message });
        list.push(id);
      } else if (decision.action === 'erase') {
        if (report.erased.length >= MAX_ERASURES_PER_RUN) { report.skipped += 1; continue; }
        if (!live) { report.erased.push(id); continue; }
        try {
          const result = await erasure.eraseAccount({ userId: id, reason: 'retention_expired', eraseCommunityText: true });
          if (result.ok) report.erased.push(id);
          else report.refused.push({ id, code: result.code });
        } catch (err) {
          report.errors.push({ id, step: 'erase', error: err.message.slice(0, 200) });
        }
      } else {
        report.skipped += 1;
      }
    }
    res.json(report);
  } catch (err) {
    console.error('Erreur retention-run :', err.message);
    res.status(500).json({ error: 'retention_failed', ...report });
  }
});

module.exports = router;
module.exports.erasure = erasure;
