import { passwordMatches, sessionCookie, clearCookie, sendJson } from '../lib/common.js';

export default async function handler(req, res) {
  if (req.method === 'DELETE') return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (!passwordMatches(body.password)) {
    await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
    return sendJson(res, 401, { error: 'Wrong password' });
  }
  return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie() });
}
