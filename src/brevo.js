// Brevo, appelé directement par le backend (clé BREVO_API_KEY dans Railway).
// Ne lève jamais : renvoie { ok, httpStatus?, error? }.
const BASE_URL = 'https://api.brevo.com/v3';
const TIMEOUT_MS = 10000;

// Remplaçable dans les tests.
const deps = { fetch: (...args) => fetch(...args) };

async function brevoRequest(method, path, body) {
  const apiKey = process.env.BREVO_API_KEY || '';
  if (!apiKey) return { ok: false, error: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await deps.fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return { ok: response.status >= 200 && response.status < 300, httpStatus: response.status };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

// Efface le contact. Un contact inexistant (404) compte comme effacé.
async function deleteContact(email) {
  const result = await brevoRequest('DELETE', `/contacts/${encodeURIComponent(email)}`);
  if (result.httpStatus === 404) return { ok: true, httpStatus: 404, found: false };
  if (!result.ok) console.error(`[brevo] effacement du contact : ${result.httpStatus || result.error}`);
  return result;
}

// Email transactionnel à partir d'un modèle Brevo (identifiant numérique).
async function sendTemplate(templateId, email, params) {
  const id = Number(templateId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'template_not_configured' };
  const result = await brevoRequest('POST', '/smtp/email', { templateId: id, to: [{ email }], params });
  if (!result.ok) console.error(`[brevo] envoi du modèle ${id} : ${result.httpStatus || result.error}`);
  return result;
}

module.exports = { deleteContact, sendTemplate, deps };
