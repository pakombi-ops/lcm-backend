/**
 * Doubles de test pour lcm-backend, SANS modifier le code de production :
 * les modules `stripe` et `@supabase/supabase-js` sont remplacés dans le cache
 * de require() AVANT de charger routes/ ou src/. Tous les createClient() et
 * Stripe() du code renvoient alors les mêmes objets factices, que chaque test
 * réinitialise avec reset().
 */
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ------------------------------------------------------------------ Supabase
const supabaseState = {};

function resetSupabase({ tables = {}, authUsers = [], tokens = {} } = {}) {
  supabaseState.tables = JSON.parse(JSON.stringify(tables));
  supabaseState.authUsers = authUsers.map((u) => ({ ...u }));
  supabaseState.tokens = { ...tokens }; // jeton → utilisateur Supabase
  supabaseState.writes = [];
  supabaseState.rpcCalls = [];
  supabaseState.rpcHandlers = {}; // nom → async (params) => { data, error }
}

const rowsOf = (table) => (supabaseState.tables[table] = supabaseState.tables[table] || []);

function fromTable(table) {
  const filters = [];
  const matches = (row) => filters.every(([col, val]) => (val === null ? (row[col] ?? null) === null : row[col] === val));
  const query = {
    select() { return query; },
    eq(col, val) { filters.push([col, val]); return query; },
    is(col, val) { filters.push([col, val]); return query; },
    then(resolve, reject) {
      return Promise.resolve({ data: rowsOf(table).filter(matches).map((r) => ({ ...r })), error: null }).then(resolve, reject);
    },
    in() { return query; },
    order() { return query; },
    limit() { return query; },
    async maybeSingle() { return { data: rowsOf(table).find(matches) || null, error: null }; },
    async single() {
      const row = rowsOf(table).find(matches);
      return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } };
    },
    async upsert(row, opts) {
      supabaseState.writes.push({ table, op: 'upsert', row, opts });
      const key = (opts && opts.onConflict) || 'id';
      const existing = rowsOf(table).find((r) => r[key] === row[key]);
      if (existing) Object.assign(existing, row); else rowsOf(table).push({ ...row });
      return { data: null, error: null };
    },
    async insert(row) {
      supabaseState.writes.push({ table, op: 'insert', row });
      rowsOf(table).push({ ...row });
      return { data: null, error: null };
    },
    delete() {
      const dfilters = [];
      const chain = {
        eq(col, val) { dfilters.push([col, val]); return chain; },
        then(resolve, reject) {
          const keep = rowsOf(table).filter((r) => !dfilters.every(([c, v]) => r[c] === v));
          supabaseState.writes.push({ table, op: 'delete', filter: dfilters });
          supabaseState.tables[table] = keep;
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
    update(payload) {
      const ufilters = [];
      const chain = {
        eq(col, val) { ufilters.push([col, val]); return chain; },
        select() { return chain; },
        then(resolve, reject) {
          const hit = rowsOf(table).filter((r) => ufilters.every(([c, v]) => r[c] === v));
          supabaseState.writes.push({ table, op: 'update', row: payload, filter: ufilters });
          hit.forEach((r) => Object.assign(r, payload));
          return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return query;
}

const fakeSupabase = {
  auth: {
    async getUser(token) {
      const user = supabaseState.tokens[token];
      return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
    },
    admin: {
      async getUserById(id) {
        const user = supabaseState.authUsers.find((u) => u.id === id);
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'not found' } };
      },
      async createUser({ email }) {
        const user = { id: `new-${supabaseState.authUsers.length + 1}`, email };
        supabaseState.authUsers.push(user);
        supabaseState.writes.push({ table: 'auth.users', op: 'create', row: { email } });
        return { data: { user }, error: null };
      },
    },
  },
  async rpc(name, params) {
    supabaseState.rpcCalls.push({ name, params });
    if (supabaseState.rpcHandlers[name]) return supabaseState.rpcHandlers[name](params);
    if (name === 'get_user_id_by_email') {
      const user = supabaseState.authUsers.find((u) => u.email === params.p_email);
      return { data: user ? user.id : null, error: null };
    }
    return { data: null, error: { message: `rpc inconnue ${name}` } };
  },
  from: fromTable,
};

// ------------------------------------------------------------------ Stripe
const stripeState = {};

function resetStripe({ customers = [], subscriptions = {} } = {}) {
  stripeState.customers = customers;
  stripeState.subscriptions = subscriptions;
  stripeState.calls = [];
  stripeState.portalError = null;
}

const fakeStripe = {
  customers: {
    async retrieve(id) {
      stripeState.calls.push({ fn: 'customers.retrieve', id });
      const customer = stripeState.customers.find((c) => c.id === id);
      if (!customer) {
        const err = new Error(`No such customer: '${id}'`);
        err.code = 'resource_missing';
        throw err;
      }
      return customer;
    },
    async list(params) {
      stripeState.calls.push({ fn: 'customers.list', params });
      return { data: stripeState.customers.filter((c) => c.email === params.email).slice(0, params.limit || 10) };
    },
  },
  billingPortal: {
    sessions: {
      async create(params) {
        stripeState.calls.push({ fn: 'billingPortal.sessions.create', params });
        if (stripeState.portalError) throw stripeState.portalError;
        return { url: `https://billing.stripe.test/session/${params.customer}` };
      },
    },
  },
  subscriptions: {
    async list(params) {
      stripeState.calls.push({ fn: 'subscriptions.list', params });
      return { data: stripeState.subscriptions[params.customer] || [] };
    },
    async cancel(id, params) {
      stripeState.calls.push({ fn: 'subscriptions.cancel', id, params });
      for (const subs of Object.values(stripeState.subscriptions)) {
        const sub = subs.find((s) => s.id === id);
        if (sub) { sub.status = 'canceled'; return { ...sub }; }
      }
      const err = new Error(`No such subscription: '${id}'`);
      err.code = 'resource_missing';
      throw err;
    },
    async retrieve(id) {
      stripeState.calls.push({ fn: 'subscriptions.retrieve', id });
      for (const [customer, subs] of Object.entries(stripeState.subscriptions)) {
        const sub = subs.find((s) => s.id === id);
        if (sub) return { customer, ...sub };
      }
      const err = new Error(`No such subscription: '${id}'`);
      err.code = 'resource_missing';
      throw err;
    },
  },
};

// ------------------------------------------------------------------ remplacement des modules
function mockModule(request, exports) {
  const resolved = require.resolve(request, { paths: [ROOT] });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let installed = false;
function installFakes() {
  if (installed) return;
  installed = true;
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://supabase.test';
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'service-key-test';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';
  mockModule('@supabase/supabase-js', { createClient: () => fakeSupabase });
  mockModule('stripe', Object.assign(() => fakeStripe, { default: () => fakeStripe }));
  resetSupabase();
  resetStripe();
}

module.exports = {
  installFakes,
  resetSupabase,
  resetStripe,
  supabaseState,
  stripeState,
  fakeSupabase,
  fakeStripe,
};
