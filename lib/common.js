// Shared helpers: login sessions, encrypted storage, and the read-only Garmin client.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { put, get } from '@vercel/blob';

export const DATA_PATH = 'garmin/data.enc';
const TOKEN_PATH = 'garmin/token.enc';
const GARMIN = 'https://personal.connectapi.garmin.com';
const TOKEN_MAX_AGE_MS = 20 * 3600 * 1000;

// ---------- sessions ----------

const COOKIE = 'gd_session';
const SESSION_DAYS = 90;

function sessionSig(exp) {
  // Includes the password hash so changing the password logs every device out.
  const pw = crypto.createHash('sha256').update(process.env.DASHBOARD_PASSWORD || '').digest('hex');
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${exp}.${pw}`).digest('hex');
}

export function sessionCookie() {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  return `${COOKIE}=${exp}.${sessionSig(exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function passwordMatches(input) {
  const want = process.env.DASHBOARD_PASSWORD;
  if (!want || typeof input !== 'string') return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(input.trim()), h(want));
}

export function isAuthed(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sessionSig(exp));
}

export function isCron(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && safeEqual(req.headers.authorization || '', `Bearer ${secret}`);
}

// ---------- encrypted private storage ----------

function dataKey() {
  return Buffer.from(process.env.DATA_KEY, 'hex');
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(obj))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(buf) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

export async function readStore(path) {
  try {
    const r = await get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return decrypt(Buffer.from(await new Response(r.stream).arrayBuffer()));
  } catch (err) {
    if (err?.name === 'BlobNotFoundError' || /not found/i.test(err?.message || '')) return null;
    throw err;
  }
}

export async function writeStore(path, obj) {
  await put(path, encrypt(obj), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/octet-stream',
  });
}

// ---------- Garmin (GET only, read-only) ----------

export class GarminKeyError extends Error {}
export class GarminTooBigError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let memToken = null;

async function accessToken(force = false) {
  if (!force && memToken && Date.now() - memToken.at < TOKEN_MAX_AGE_MS) return memToken.token;
  if (!force) {
    const saved = await readStore(TOKEN_PATH);
    if (saved && Date.now() - saved.at < TOKEN_MAX_AGE_MS) {
      memToken = saved;
      return saved.token;
    }
  }
  const key = (process.env.GARMIN_PERSONAL_API_KEY || '').trim();
  if (!key) throw new GarminKeyError('The Garmin API key is not set.');
  const res = await fetch(`${GARMIN}/personalapitoken-service/personal-api/personal-api-key/token`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${key}` },
  });
  if (!res.ok) {
    throw new GarminKeyError(`Garmin refused the API key (HTTP ${res.status}). It may be mistyped, deleted or expired.`);
  }
  let token = (await res.text()).trim();
  if (token.startsWith('"')) token = JSON.parse(token);
  memToken = { token, at: Date.now() };
  await writeStore(TOKEN_PATH, memToken);
  return token;
}

export async function garminGet(path) {
  let refreshed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await accessToken();
    const res = await fetch(GARMIN + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    await sleep(250);
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await accessToken(true);
      continue;
    }
    if ([429, 502, 503, 504].includes(res.status)) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (res.status === 500) throw new GarminTooBigError(path);
    if (res.status === 204 || res.status === 404) return null;
    throw new Error(`Garmin HTTP ${res.status} for ${path.split('?')[0]}`);
  }
  throw new Error(`Garmin kept failing for ${path.split('?')[0]}`);
}

// ---------- tiny response helpers ----------

export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
