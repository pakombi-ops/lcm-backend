// LA procédure d'effacement d'un compte, commune à la suppression demandée par le
// membre (reason 'user_request') et à la fin de la conservation de 6 mois
// ('retention_expired').
//
// Ordre :
//   1. refus si compte fondateur ;
//   2. Stripe, relu en direct : paiement de La Transmission en cours → refus ;
//      abonnement app en cours → résilié immédiatement (user_request) ou refus
//      (retention_expired : le membre s'est réabonné) ;
//   3. journal account_erasures (avec l'email, utile aux étapes externes) ;
//   4. Supabase : public.erase_user_data, une transaction (tables personnelles,
//      communauté anonymisée, compte auth) ;
//   5. WordPress : compte et inscriptions LifterLMS (/pc-lms/v1/delete-user) ;
//   6. Brevo : contact ;
//   7. journal terminé, email effacé.
// Les données Stripe sont gardées (obligations comptables).
//
// Les étapes 5 et 6 peuvent échouer sans bloquer : elles restent « à faire » dans
// le journal et resumePending (tâche quotidienne) les relance. Chaque étape peut
// être rejouée sans effet de bord.

const crypto = require('crypto');

// Abonnements qui engagent encore des paiements (canceled et incomplete_expired sont terminés).
const RUNNING_STATUSES = ['trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete'];

class ErasureRefused extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function createAccountErasure({ supabase, stripe, callLms, brevo, now = () => new Date(), transmissionPriceIds = () => [] }) {
  const isTransmission = (sub) => {
    const ids = transmissionPriceIds();
    return (sub?.items?.data || []).some((item) => ids.includes(item?.price?.id));
  };

  async function readAccount(userId) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles').select('is_founder, email').eq('id', userId).maybeSingle();
    if (profileError) throw profileError;

    const { data: entitlement, error: entError } = await supabase
      .from('entitlements').select('stripe_customer_id').eq('supabase_user_id', userId).maybeSingle();
    if (entError) throw entError;

    const { data: authData } = await supabase.auth.admin.getUserById(userId);
    const email = (authData?.user?.email || profile?.email || '').trim().toLowerCase() || null;

    return { profile, email, customerId: entitlement?.stripe_customer_id || null };
  }

  // Étape 2. Renvoie les abonnements résiliés. Une erreur Stripe arrête tout
  // AVANT d'effacer quoi que ce soit.
  async function settleStripe(customerId, reason) {
    if (typeof customerId !== 'string' || !customerId.startsWith('cus_')) return [];
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    const running = subs.data.filter((s) => RUNNING_STATUSES.includes(s.status));
    if (running.some(isTransmission)) throw new ErasureRefused('transmission_plan');
    if (!running.length) return [];
    if (reason !== 'user_request') throw new ErasureRefused('active_subscription');

    const canceled = [];
    for (const sub of running) {
      // Résiliation immédiate, sans remboursement (pas de prorata).
      await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false });
      canceled.push(sub.id);
    }
    return canceled;
  }

  async function openJournal({ userId, reason, eraseCommunityText, email }) {
    const { data: open, error: readError } = await supabase
      .from('account_erasures').select('*').eq('user_id', userId).is('completed_at', null).maybeSingle();
    if (readError) throw readError;
    if (open) return open;

    const row = {
      id: crypto.randomUUID(),
      user_id: userId,
      reason,
      erase_community_text: eraseCommunityText,
      email,
      requested_at: now().toISOString(),
      attempts: 0,
    };
    const { error } = await supabase.from('account_erasures').insert(row);
    if (error) throw error;
    return row;
  }

  async function updateJournal(id, fields) {
    const { error } = await supabase.from('account_erasures').update(fields).eq('id', id);
    if (error) console.error(`[erasure] journal ${id} : ${error.message}`);
  }

  async function eraseSupabase(journal) {
    const { data, error } = await supabase.rpc('erase_user_data', {
      p_user_id: journal.user_id,
      p_erase_community_text: journal.erase_community_text,
    });
    if (error) {
      if (/founder_protected/.test(error.message || '')) throw new ErasureRefused('founder_protected');
      throw new Error(`erase_user_data : ${error.message}`);
    }
    await updateJournal(journal.id, { supabase_erased_at: now().toISOString() });
    return data;
  }

  // Étapes 5 à 7. Ne lève jamais.
  async function runExternalSteps(journal) {
    const pending = [];
    const errors = [];
    const fields = { attempts: (journal.attempts || 0) + 1 };

    if (!journal.wordpress_done_at) {
      const wp = journal.email ? await callLms('delete-user', journal.email) : { ok: true, found: false };
      if (wp.ok) fields.wordpress_done_at = now().toISOString();
      else { pending.push('wordpress'); errors.push(`wordpress:${wp.httpStatus || wp.error}`); }
    }
    if (!journal.brevo_done_at) {
      const br = journal.email ? await brevo.deleteContact(journal.email) : { ok: true };
      if (br.ok) fields.brevo_done_at = now().toISOString();
      else { pending.push('brevo'); errors.push(`brevo:${br.httpStatus || br.error}`); }
    }

    fields.last_error = errors.length ? errors.join(', ') : null;
    if (!pending.length) {
      fields.completed_at = now().toISOString();
      fields.email = null; // l'email ne sert plus : il ne reste que la preuve d'effacement
    }
    await updateJournal(journal.id, fields);
    return pending;
  }

  /**
   * @returns {{ ok: true, canceledSubscriptions: string[], pending: string[], counts: object }
   *         | { ok: false, code: 'founder_protected' | 'transmission_plan' | 'active_subscription' | 'not_found' }}
   * Lève sur une erreur technique avant l'effacement Supabase (rien n'est alors effacé).
   */
  async function eraseAccount({ userId, reason, eraseCommunityText = true }) {
    if (!['user_request', 'retention_expired'].includes(reason)) throw new Error(`raison invalide : ${reason}`);
    try {
      const account = await readAccount(userId);
      if (!account.profile && !account.email) return { ok: false, code: 'not_found' };
      if (account.profile?.is_founder) return { ok: false, code: 'founder_protected' };

      const canceledSubscriptions = await settleStripe(account.customerId, reason);
      const journal = await openJournal({ userId, reason, eraseCommunityText: eraseCommunityText !== false, email: account.email });
      const counts = journal.supabase_erased_at ? null : await eraseSupabase(journal);
      const pending = await runExternalSteps(journal);
      return { ok: true, canceledSubscriptions, pending, counts };
    } catch (err) {
      if (err instanceof ErasureRefused) return { ok: false, code: err.code };
      throw err;
    }
  }

  // Tâche quotidienne : termine les effacements restés incomplets.
  async function resumePending() {
    const { data, error } = await supabase.from('account_erasures').select('*').is('completed_at', null);
    if (error) throw error;
    const report = { resumed: 0, completed: 0, stillPending: 0 };
    for (const journal of data || []) {
      report.resumed += 1;
      try {
        if (!journal.supabase_erased_at) await eraseSupabase(journal);
        const pending = await runExternalSteps(journal);
        if (pending.length) report.stillPending += 1; else report.completed += 1;
      } catch (err) {
        report.stillPending += 1;
        await updateJournal(journal.id, { attempts: (journal.attempts || 0) + 1, last_error: String(err.code || err.message).slice(0, 200) });
      }
    }
    return report;
  }

  return { eraseAccount, resumePending };
}

module.exports = { createAccountErasure, RUNNING_STATUSES };
