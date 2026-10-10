// Tontine Digital 1.0 — serveur complet dans un seul fichier (API + pages membre et admin)
'use strict';
const __nodeRequire = require;
const __defs = {};
const __cache = {};
__defs['db'] = function (module, exports, require) {
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});
// Toutes les tables vivent dans le schéma « td »
pool.on('connect', (c) => c.query('SET search_path TO td, public'));
const q = (text, params) => pool.query(text, params);
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
module.exports = { pool, q, tx };

};
__defs['sms'] = function (module, exports, require) {
// Envoi de SMS via Africa's Talking. Sans identifiants, le message est seulement écrit dans les logs.
async function sendSms(phone, text) {
  const { AT_USERNAME, AT_API_KEY, AT_SANDBOX, AT_SENDER } = process.env;
  if (!AT_USERNAME || !AT_API_KEY) {
    console.log(`[SMS non configuré] ${phone} : ${text}`);
    return false;
  }
  const base = AT_SANDBOX === 'false' ? 'https://api.africastalking.com' : 'https://api.sandbox.africastalking.com';
  const body = new URLSearchParams({ username: AT_USERNAME, to: '+225' + phone, message: text });
  if (AT_SENDER) body.set('from', AT_SENDER);
  const r = await fetch(base + '/version1/messaging', {
    method: 'POST',
    headers: { apiKey: AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('Envoi du SMS impossible (' + r.status + ')');
  return true;
}
module.exports = { sendSms };

};
__defs['auth'] = function (module, exports, require) {
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { q } = require('./db');

const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-a-changer');
if (!SECRET) throw new Error('JWT_SECRET manquant');

const err = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sign = (u) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '30d' });
const hashOtp = (phone, code) => crypto.createHmac('sha256', SECRET).update(phone + ':' + code).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('225')) d = d.slice(3);
  return /^\d{10}$/.test(d) ? d : null;
}

async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw err(401, 'Connexion requise');
    let id;
    try { ({ id } = jwt.verify(h.slice(7), SECRET)); } catch { throw err(401, 'Session expirée'); }
    const { rows } = await q('SELECT id,name,phone,role,status,ref_code,doc_type,doc_number FROM users WHERE id=$1', [id]);
    if (!rows[0]) throw err(401, 'Session invalide');
    if (['suspended', 'refused'].includes(rows[0].status)) throw err(403, 'Compte suspendu ou refusé');
    req.user = rows[0];
    next();
  } catch (e) { next(e); }
}
const active = (req, res, next) =>
  req.user.status === 'active' ? next() : next(err(403, "Compte en attente de validation par l'administrateur"));
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : next(err(403, 'Réservé aux administrateurs')));

module.exports = { err, wrap, sign, hashOtp, safeEq, normPhone, auth, active, admin };

};
__defs['payments'] = function (module, exports, require) {
const crypto = require('crypto');
const { q, tx } = require('./db');

async function getSettings() {
  const { rows } = await q('SELECT key,value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// Commission plateforme : sur la 1re cotisation seulement ('first') ou sur chacune ('each')
async function computeFee(userId, amount) {
  const s = await getSettings();
  let apply = s.commission_mode === 'each';
  if (!apply) {
    const { rows } = await q("SELECT 1 FROM payments WHERE user_id=$1 AND status='paid' LIMIT 1", [userId]);
    apply = !rows[0];
  }
  return apply ? Math.round(amount * Number(s.platform_rate)) : 0;
}

async function createCheckout({ method, amount, ref, phone }) {
  const mode = process.env.PAYMENT_MODE || 'mock';
  if (mode === 'mock') return { providerRef: 'mock-' + ref, checkoutUrl: null, mock: true };
  if (method === 'wave') {
    // À vérifier dans la documentation Wave (https://docs.wave.com) avant la mise en production
    const r = await fetch('https://api.wave.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WAVE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: String(amount),
        currency: 'XOF',
        client_reference: ref,
        success_url: process.env.PUBLIC_URL + '/member/?paid=1',
        error_url: process.env.PUBLIC_URL + '/member/?paid=0',
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Wave : ' + (d.message || r.status));
    return { providerRef: d.id, checkoutUrl: d.wave_launch_url };
  }
  if (method === 'orange') {
    // Orange Money Web Payment (Côte d'Ivoire) : à valider avec votre compte marchand Orange
    const basic = Buffer.from(process.env.ORANGE_CLIENT_ID + ':' + process.env.ORANGE_CLIENT_SECRET).toString('base64');
    const t = await fetch('https://api.orange.com/oauth/v3/token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const tok = (await t.json().catch(() => ({}))).access_token;
    if (!tok) throw new Error('Orange Money : authentification refusée');
    const r = await fetch('https://api.orange.com/orange-money-webpay/' + (process.env.ORANGE_ENV === 'dev' ? 'dev' : 'ci') + '/v1/webpayment', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_key: process.env.ORANGE_MERCHANT_KEY,
        currency: process.env.ORANGE_CURRENCY || 'XOF',
        order_id: ref, amount, lang: 'fr', reference: 'Tontine Digital',
        return_url: process.env.PUBLIC_URL + '/member/?paid=1',
        cancel_url: process.env.PUBLIC_URL + '/member/?paid=0',
        notif_url: process.env.PUBLIC_URL + '/webhooks/orange',
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.payment_url) throw new Error('Orange Money : ' + (d.message || r.status));
    return { providerRef: d.pay_token, checkoutUrl: d.payment_url, token: d.notif_token };
  }
  if (method === 'mtn') {
    // MTN MoMo Collection (requesttopay) : à valider avec votre compte MTN MoMo Developer
    const tok = await mtnToken();
    const id = crypto.randomUUID();
    const r = await fetch(mtnBase() + '/collection/v1_0/requesttopay', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'X-Reference-Id': id, 'X-Target-Environment': process.env.MTN_ENV || 'sandbox', 'Ocp-Apim-Subscription-Key': process.env.MTN_SUBSCRIPTION_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: String(amount), currency: process.env.MTN_CURRENCY || 'XOF', externalId: ref, payer: { partyIdType: 'MSISDN', partyId: '225' + phone }, payerMessage: 'Tontine Digital', payeeNote: ref }),
    });
    if (r.status !== 202) throw new Error('MTN MoMo : demande refusée (' + r.status + ')');
    return { providerRef: id, checkoutUrl: null };
  }
  throw new Error('Moyen de paiement inconnu (' + method + ')');
}

const mtnBase = () => process.env.MTN_BASE || 'https://sandbox.momodeveloper.mtn.com';
async function mtnToken() {
  const basic = Buffer.from(process.env.MTN_API_USER + ':' + process.env.MTN_API_KEY).toString('base64');
  const r = await fetch(mtnBase() + '/collection/token/', { method: 'POST', headers: { Authorization: 'Basic ' + basic, 'Ocp-Apim-Subscription-Key': process.env.MTN_SUBSCRIPTION_KEY } });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error('MTN MoMo : authentification refusée');
  return d.access_token;
}
// Wave et Orange confirment par webhook ; MTN se vérifie en interrogeant l'opérateur
async function refreshPayment(p) {
  if (p.status !== 'pending' || p.method !== 'mtn' || (process.env.PAYMENT_MODE || 'mock') === 'mock') return p.status;
  const tok = await mtnToken();
  const r = await fetch(mtnBase() + '/collection/v1_0/requesttopay/' + p.provider_ref, { headers: { Authorization: 'Bearer ' + tok, 'X-Target-Environment': process.env.MTN_ENV || 'sandbox', 'Ocp-Apim-Subscription-Key': process.env.MTN_SUBSCRIPTION_KEY } });
  const d = await r.json().catch(() => ({}));
  if (d.status === 'SUCCESSFUL') { await finalizePayment(p.id); return 'paid'; }
  if (d.status === 'FAILED') { await q("UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'", [p.id]); return 'failed'; }
  return 'pending';
}

// Marque un paiement comme payé (une seule fois) et crédite la commission de parrainage
async function finalizePayment(id) {
  return tx(async (c) => {
    const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!p || p.status === 'paid') return false;
    const first = !(await c.query("SELECT 1 FROM payments WHERE user_id=$1 AND status='paid' AND id<>$2 LIMIT 1", [p.user_id, id])).rows[0];
    await c.query("UPDATE payments SET status='paid', paid_at=now() WHERE id=$1", [id]);
    await c.query('INSERT INTO notifications(user_id,body) VALUES($1,$2)', [p.user_id, `Paiement de ${p.amount + p.fee} FCFA confirmé.`]);
    if (first) {
      const u = (await c.query('SELECT referrer_id FROM users WHERE id=$1', [p.user_id])).rows[0];
      if (u && u.referrer_id) {
        const rate = Number((await c.query("SELECT value FROM settings WHERE key='referral_rate'")).rows[0].value);
        const amt = Math.round(p.amount * rate);
        await c.query('INSERT INTO referral_commissions(referrer_id,referred_id,payment_id,amount) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [u.referrer_id, p.user_id, id, amt]);
        await c.query('INSERT INTO notifications(user_id,body) VALUES($1,$2)', [u.referrer_id, `Commission de parrainage : ${amt} FCFA.`]);
      }
    }
    return true;
  });
}
module.exports = { getSettings, computeFee, createCheckout, finalizePayment, refreshPayment };

};
__defs['routes_auth'] = function (module, exports, require) {
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { q, tx } = require('../db');
const { err, wrap, sign, hashOtp, safeEq, normPhone } = require('../auth');
const { sendSms } = require('../sms');

const r = express.Router();
const DOCS = ['CNI', 'Passeport', 'Carte consulaire', 'Autre'];

// Limite : 1 code / minute et 5 codes / heure par numéro
async function issueOtp(phone, purpose, payload) {
  const { rows } = await q("SELECT created_at FROM otp_codes WHERE phone=$1 AND created_at > now() - interval '1 hour' ORDER BY id DESC", [phone]);
  if (rows.length >= 5) throw err(429, 'Trop de demandes de code. Réessayez dans une heure.');
  if (rows[0] && Date.now() - new Date(rows[0].created_at).getTime() < 60000) throw err(429, 'Attendez une minute avant de redemander un code.');
  const code = String(crypto.randomInt(100000, 1000000));
  await q("INSERT INTO otp_codes(phone,purpose,code_hash,payload,expires_at) VALUES($1,$2,$3,$4, now() + interval '5 minutes')", [phone, purpose, hashOtp(phone, code), payload || null]);
  await sendSms(phone, `Tontine Digital : votre code est ${code} (valable 5 minutes).`);
  return code;
}

async function checkOtp(phone, code, purpose) {
  const { rows } = await q('SELECT * FROM otp_codes WHERE phone=$1 AND purpose=$2 AND used=false AND expires_at > now() ORDER BY id DESC LIMIT 1', [phone, purpose]);
  const o = rows[0];
  if (!o) throw err(400, 'Code expiré. Demandez un nouveau code.');
  if (o.attempts >= 3) throw err(429, 'Trop d’essais. Demandez un nouveau code.');
  await q('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1', [o.id]);
  if (!safeEq(o.code_hash, hashOtp(phone, String(code || '')))) throw err(400, 'Code incorrect.');
  return o;
}

const devOtp = (code) => (process.env.DEV_SHOW_OTP === 'true' ? { dev_otp: code } : {});

r.post('/register', wrap(async (req, res) => {
  const b = req.body || {};
  const phone = normPhone(b.phone);
  const name = String(b.name || '').trim();
  const age = (Date.now() - new Date(b.birth_date)) / 31557600000;
  if (name.length < 3) throw err(400, 'Nom complet requis');
  if (!(age >= 18)) throw err(400, 'Il faut avoir 18 ans minimum');
  if (!phone) throw err(400, 'Téléphone invalide (10 chiffres)');
  if (String(b.password || '').length < 8) throw err(400, 'Mot de passe : 8 caractères minimum');
  if (!DOCS.includes(b.doc_type) || !String(b.doc_number || '').trim()) throw err(400, 'Document : type et numéro requis');
  if (b.accept_terms !== true) throw err(400, 'Acceptez les conditions d’utilisation');
  if ((await q('SELECT 1 FROM users WHERE phone=$1', [phone])).rows[0]) throw err(409, 'Ce téléphone a déjà un compte');
  let referrer_id = null;
  if (b.referral_code) {
    const ref = (await q('SELECT id FROM users WHERE ref_code=$1', [String(b.referral_code).trim().toUpperCase()])).rows[0];
    if (!ref) throw err(400, 'Code parrain inconnu');
    referrer_id = ref.id;
  }
  const payload = {
    name, birth_date: b.birth_date, email: b.email ? String(b.email).trim() : null,
    doc_type: b.doc_type, doc_number: String(b.doc_number).trim(),
    password_hash: await bcrypt.hash(String(b.password), 10), referrer_id,
  };
  const code = await issueOtp(phone, 'register', payload);
  res.json({ ok: true, message: 'Code envoyé par SMS', ...devOtp(code) });
}));

r.post('/verify-otp', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) throw err(400, 'Téléphone invalide');
  const o = await checkOtp(phone, req.body.code, 'register');
  const p = o.payload;
  const user = await tx(async (c) => {
    if ((await c.query('SELECT 1 FROM users WHERE phone=$1', [phone])).rows[0]) throw err(409, 'Ce téléphone a déjà un compte');
    await c.query('UPDATE otp_codes SET used=true WHERE id=$1', [o.id]);
    let ref;
    do {
      ref = 'TD' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    } while ((await c.query('SELECT 1 FROM users WHERE ref_code=$1', [ref])).rows[0]);
    const u = (await c.query(
      `INSERT INTO users(name,birth_date,phone,email,doc_type,doc_number,password_hash,ref_code,referrer_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,phone,role,status,ref_code`,
      [p.name, p.birth_date, phone, p.email, p.doc_type, p.doc_number, p.password_hash, ref, p.referrer_id])).rows[0];
    await c.query('INSERT INTO notifications(user_id,body) VALUES($1,$2)', [u.id, 'Bienvenue ! Votre compte sera actif après validation par l’administrateur.']);
    return u;
  });
  res.status(201).json({ token: sign(user), user });
}));

r.post('/login', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  const u = phone ? (await q('SELECT * FROM users WHERE phone=$1', [phone])).rows[0] : null;
  if (!u) throw err(401, 'Téléphone ou mot de passe incorrect');
  if (u.locked_until && u.locked_until > new Date()) throw err(429, 'Trop d’essais. Réessayez dans 15 minutes.');
  if (!(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    const n = u.failed_logins + 1;
    await q('UPDATE users SET failed_logins=$1, locked_until=$2 WHERE id=$3', [n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60000) : null, u.id]);
    throw err(401, 'Téléphone ou mot de passe incorrect');
  }
  await q('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
  if (['suspended', 'refused'].includes(u.status)) throw err(403, 'Compte suspendu ou refusé');
  res.json({ token: sign(u), user: { id: u.id, name: u.name, phone: u.phone, role: u.role, status: u.status, ref_code: u.ref_code } });
}));

r.post('/forgot', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  let code;
  if (phone && (await q('SELECT 1 FROM users WHERE phone=$1', [phone])).rows[0]) code = await issueOtp(phone, 'reset');
  res.json({ ok: true, message: 'Si ce numéro a un compte, un code a été envoyé.', ...(code ? devOtp(code) : {}) });
}));

r.post('/reset', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) throw err(400, 'Téléphone invalide');
  if (String(req.body.new_password || '').length < 8) throw err(400, 'Mot de passe : 8 caractères minimum');
  const o = await checkOtp(phone, req.body.code, 'reset');
  await q('UPDATE otp_codes SET used=true WHERE id=$1', [o.id]);
  await q('UPDATE users SET password_hash=$1, failed_logins=0, locked_until=NULL WHERE phone=$2', [await bcrypt.hash(String(req.body.new_password), 10), phone]);
  res.json({ ok: true });
}));

module.exports = r;

};
__defs['routes_member'] = function (module, exports, require) {
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, tx } = require('../db');
const { err, wrap, auth, active, normPhone } = require('../auth');
const { computeFee, createCheckout, finalizePayment, refreshPayment } = require('../payments');

const r = express.Router();
r.use(auth);

async function membership(userId, tid) {
  const { rows } = await q('SELECT t.* FROM tontines t JOIN tontine_members m ON m.tontine_id=t.id WHERE t.id=$1 AND m.user_id=$2', [tid, userId]);
  if (!rows[0]) throw err(400, 'Vous ne faites pas partie de cette tontine');
  return rows[0];
}
function nextDue(freq) {
  const d = new Date();
  if (freq === 'mois') d.setUTCMonth(d.getUTCMonth() + 1, 1);
  else d.setUTCDate(d.getUTCDate() + (((Number(process.env.DUE_WEEKDAY || 5) - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

r.get('/me', wrap(async (req, res) => res.json({ user: req.user })));

r.post('/me/password', wrap(async (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (String(new_password || '').length < 8) throw err(400, 'Mot de passe : 8 caractères minimum');
  const { rows } = await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(String(old_password || ''), rows[0].password_hash))) throw err(400, 'Ancien mot de passe incorrect');
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(new_password), 10), req.user.id]);
  res.json({ ok: true });
}));

r.get('/tontines', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT t.id,t.name,t.amount,t.frequency,t.max_members,t.status,t.current_round,
            (SELECT count(*) FROM tontine_members WHERE tontine_id=t.id)::int AS members,
            EXISTS(SELECT 1 FROM tontine_members WHERE tontine_id=t.id AND user_id=$1) AS joined
     FROM tontines t WHERE t.status<>'closed' ORDER BY t.id`, [req.user.id]);
  res.json({ tontines: rows });
}));

r.post('/tontines/:id/join', active, wrap(async (req, res) => {
  const id = Number(req.params.id);
  await tx(async (c) => {
    const t = (await c.query('SELECT * FROM tontines WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!t) throw err(404, 'Tontine introuvable');
    if (t.status !== 'open') throw err(400, "Cette tontine n'accepte plus de nouveaux membres");
    const n = (await c.query('SELECT count(*)::int AS n FROM tontine_members WHERE tontine_id=$1', [id])).rows[0].n;
    if (n >= t.max_members) throw err(400, 'Tontine complète');
    await c.query('INSERT INTO tontine_members(tontine_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, req.user.id]);
  });
  res.json({ ok: true });
}));

r.get('/payments/quote', active, wrap(async (req, res) => {
  const t = await membership(req.user.id, Number(req.query.tontine_id));
  const fee = await computeFee(req.user.id, t.amount);
  res.json({ amount: t.amount, fee, total: t.amount + fee });
}));

r.get('/payments/:id', wrap(async (req, res) => {
  const p = (await q('SELECT * FROM payments WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.user.id])).rows[0];
  if (!p) throw err(404, 'Paiement introuvable');
  res.json({ status: await refreshPayment(p) });
}));

// Photo de la pièce d'identité (JPEG/PNG, 2 Mo max), visible uniquement par les administrateurs
r.post('/me/document', wrap(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).image || ''));
  if (!m) throw err(400, 'Image JPEG ou PNG requise');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) throw err(400, 'Image trop lourde (2 Mo maximum)');
  await q('INSERT INTO user_documents(user_id,mime,data) VALUES($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, created_at=now()', [req.user.id, m[1], buf]);
  res.json({ ok: true });
}));

r.post('/payments', active, wrap(async (req, res) => {
  const method = req.body.method;
  if (!['wave', 'orange', 'mtn'].includes(method)) throw err(400, 'Moyen de paiement invalide');
  const t = await membership(req.user.id, Number(req.body.tontine_id));
  const fee = await computeFee(req.user.id, t.amount);
  const id = (await q('INSERT INTO payments(user_id,tontine_id,amount,fee,method) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.user.id, t.id, t.amount, fee, method])).rows[0].id;
  try {
    const co = await createCheckout({ method, amount: t.amount + fee, ref: 'TD-' + id, phone: normPhone(req.body.payer_phone) || req.user.phone });
    await q('UPDATE payments SET provider_ref=$1, checkout_url=$2, provider_token=$3 WHERE id=$4', [co.providerRef, co.checkoutUrl, co.token || null, id]);
    res.status(201).json({ payment_id: id, status: 'pending', total: t.amount + fee, checkout_url: co.checkoutUrl, mock: !!co.mock });
  } catch (e) {
    await q("UPDATE payments SET status='failed' WHERE id=$1", [id]);
    throw err(502, e.message);
  }
}));

// Mode test uniquement (PAYMENT_MODE=mock) : confirme le paiement sans opérateur
r.post('/payments/:id/simulate', active, wrap(async (req, res) => {
  if ((process.env.PAYMENT_MODE || 'mock') !== 'mock') throw err(404, 'Introuvable');
  const p = (await q('SELECT id FROM payments WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.user.id])).rows[0];
  if (!p) throw err(404, 'Paiement introuvable');
  await finalizePayment(p.id);
  res.json({ ok: true });
}));

r.get('/payments', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT p.id,p.amount,p.fee,p.method,p.status,p.created_at,p.paid_at,t.name AS tontine
     FROM payments p JOIN tontines t ON t.id=p.tontine_id WHERE p.user_id=$1 ORDER BY p.id DESC LIMIT 100`, [req.user.id]);
  res.json({ payments: rows });
}));

r.get('/calendar', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT t.id,t.name,t.amount,t.frequency,t.status,t.current_round,
            (SELECT u.name FROM tontine_members m2 JOIN users u ON u.id=m2.user_id WHERE m2.tontine_id=t.id AND m2.position=t.current_round) AS beneficiary,
            m.position AS my_position
     FROM tontines t JOIN tontine_members m ON m.tontine_id=t.id AND m.user_id=$1 WHERE t.status<>'closed'`, [req.user.id]);
  res.json({ items: rows.map((t) => ({ ...t, next_due: nextDue(t.frequency) })) });
}));

r.get('/tontines/:id/messages', wrap(async (req, res) => {
  await membership(req.user.id, Number(req.params.id));
  const { rows } = await q('SELECT m.id,m.body,m.created_at,u.name AS author FROM messages m JOIN users u ON u.id=m.user_id WHERE m.tontine_id=$1 ORDER BY m.id DESC LIMIT 100', [Number(req.params.id)]);
  res.json({ messages: rows.reverse() });
}));

r.post('/tontines/:id/messages', active, wrap(async (req, res) => {
  await membership(req.user.id, Number(req.params.id));
  const body = String((req.body || {}).body || '').trim();
  if (!body || body.length > 500) throw err(400, 'Message de 1 à 500 caractères');
  await q('INSERT INTO messages(tontine_id,user_id,body) VALUES($1,$2,$3)', [Number(req.params.id), req.user.id, body]);
  res.status(201).json({ ok: true });
}));

r.get('/notifications', wrap(async (req, res) => {
  const { rows } = await q('SELECT id,body,read,created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]);
  res.json({ notifications: rows });
}));
r.post('/notifications/read', wrap(async (req, res) => {
  await q('UPDATE notifications SET read=true WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
}));

r.get('/referral', wrap(async (req, res) => {
  const s = (await q('SELECT count(*)::int AS referred, COALESCE(sum(amount),0)::int AS earned FROM referral_commissions WHERE referrer_id=$1', [req.user.id])).rows[0];
  const n = (await q('SELECT count(*)::int AS n FROM users WHERE referrer_id=$1', [req.user.id])).rows[0].n;
  res.json({ code: req.user.ref_code, referred: n, paid_referrals: s.referred, earned: s.earned });
}));

module.exports = r;

};
__defs['routes_admin'] = function (module, exports, require) {
const express = require('express');
const { q, tx } = require('../db');
const { err, wrap, auth, admin } = require('../auth');
const { getSettings } = require('../payments');

const r = express.Router();
r.use(auth, admin);
const audit = (adminId, action, target) => q('INSERT INTO audit_log(admin_id,action,target) VALUES($1,$2,$3)', [adminId, action, String(target)]);

r.get('/stats', wrap(async (req, res) => {
  const u = (await q("SELECT count(*)::int AS members, count(*) FILTER (WHERE status='pending')::int AS pending FROM users WHERE role='member'")).rows[0];
  const p = (await q("SELECT COALESCE(sum(amount),0)::int AS collected, COALESCE(sum(fee),0)::int AS fees FROM payments WHERE status='paid'")).rows[0];
  const t = (await q("SELECT count(*)::int AS tontines FROM tontines WHERE status<>'closed'")).rows[0];
  res.json({ ...u, ...p, ...t });
}));

r.get('/users', wrap(async (req, res) => {
  const st = req.query.status;
  const { rows } = await q(
    `SELECT id,name,phone,email,doc_type,doc_number,status,ref_code,referrer_id,created_at,
            EXISTS(SELECT 1 FROM user_documents d WHERE d.user_id=users.id) AS has_document FROM users
     WHERE role='member' AND ($1::text IS NULL OR status=$1) ORDER BY id DESC LIMIT 500`, [st || null]);
  res.json({ users: rows });
}));

r.post('/users/:id/status', wrap(async (req, res) => {
  const status = (req.body || {}).status;
  if (!['active', 'refused', 'suspended'].includes(status)) throw err(400, 'Statut invalide');
  const id = Number(req.params.id);
  const u = (await q("UPDATE users SET status=$1 WHERE id=$2 AND role='member' RETURNING id", [status, id])).rows[0];
  if (!u) throw err(404, 'Membre introuvable');
  const msg = { active: 'Votre compte est validé. Bienvenue !', refused: 'Votre inscription a été refusée.' + (req.body.reason ? ' Motif : ' + String(req.body.reason).slice(0, 200) : ''), suspended: 'Votre compte a été suspendu.' }[status];
  await q('INSERT INTO notifications(user_id,body) VALUES($1,$2)', [id, msg]);
  await audit(req.user.id, 'user_status:' + status, id);
  res.json({ ok: true });
}));

r.get('/users/:id/document', wrap(async (req, res) => {
  const d = (await q('SELECT mime,data FROM user_documents WHERE user_id=$1', [Number(req.params.id)])).rows[0];
  if (!d) throw err(404, 'Aucune photo');
  res.set('Cache-Control', 'no-store').type(d.mime).send(d.data);
}));

r.get('/tontines', wrap(async (req, res) => {
  const { rows } = await q("SELECT t.*, (SELECT count(*) FROM tontine_members WHERE tontine_id=t.id)::int AS members FROM tontines t ORDER BY id DESC");
  res.json({ tontines: rows });
}));

r.post('/tontines', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim(), amount = Number(b.amount), max = Number(b.max_members || 20);
  if (name.length < 3) throw err(400, 'Nom requis');
  if (!Number.isInteger(amount) || amount < 500) throw err(400, 'Montant minimum : 500 FCFA');
  if (!['semaine', 'mois'].includes(b.frequency)) throw err(400, 'Fréquence : semaine ou mois');
  if (!Number.isInteger(max) || max < 2 || max > 200) throw err(400, 'Nombre de membres : 2 à 200');
  const t = (await q('INSERT INTO tontines(name,amount,frequency,max_members) VALUES($1,$2,$3,$4) RETURNING *', [name, amount, b.frequency, max])).rows[0];
  await audit(req.user.id, 'tontine_create', t.id);
  res.status(201).json({ tontine: t });
}));

// Tirage au sort de l'ordre des bénéficiaires, puis démarrage de la tontine
r.post('/tontines/:id/draw', wrap(async (req, res) => {
  const id = Number(req.params.id);
  await tx(async (c) => {
    const t = (await c.query('SELECT * FROM tontines WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!t) throw err(404, 'Tontine introuvable');
    if (t.status !== 'open') throw err(400, 'Tirage déjà effectué');
    const n = (await c.query('SELECT count(*)::int AS n FROM tontine_members WHERE tontine_id=$1', [id])).rows[0].n;
    if (n < 2) throw err(400, 'Il faut au moins 2 membres');
    await c.query(`UPDATE tontine_members m SET position=s.rn FROM
      (SELECT user_id, row_number() OVER (ORDER BY random()) AS rn FROM tontine_members WHERE tontine_id=$1) s
      WHERE m.tontine_id=$1 AND m.user_id=s.user_id`, [id]);
    await c.query("UPDATE tontines SET status='running', current_round=1 WHERE id=$1", [id]);
  });
  await audit(req.user.id, 'tontine_draw', id);
  res.json({ ok: true });
}));

r.post('/tontines/:id/next-round', wrap(async (req, res) => {
  const id = Number(req.params.id);
  await tx(async (c) => {
    const t = (await c.query('SELECT * FROM tontines WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!t || t.status !== 'running') throw err(400, 'Tontine non démarrée');
    const n = (await c.query('SELECT count(*)::int AS n FROM tontine_members WHERE tontine_id=$1', [id])).rows[0].n;
    if (t.current_round >= n) await c.query("UPDATE tontines SET status='closed' WHERE id=$1", [id]);
    else await c.query('UPDATE tontines SET current_round=current_round+1 WHERE id=$1', [id]);
  });
  await audit(req.user.id, 'tontine_next_round', id);
  res.json({ ok: true });
}));

r.get('/payments', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT p.id,p.amount,p.fee,p.method,p.status,p.created_at,p.paid_at,u.name AS member,t.name AS tontine
     FROM payments p JOIN users u ON u.id=p.user_id JOIN tontines t ON t.id=p.tontine_id ORDER BY p.id DESC LIMIT 300`);
  res.json({ payments: rows });
}));

r.get('/settings', wrap(async (req, res) => res.json({ settings: await getSettings() })));
r.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const set = async (k, v) => q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, String(v)]);
  if (b.commission_mode !== undefined) {
    if (!['first', 'each'].includes(b.commission_mode)) throw err(400, 'commission_mode : first ou each');
    await set('commission_mode', b.commission_mode);
  }
  for (const k of ['platform_rate', 'referral_rate']) {
    if (b[k] !== undefined) {
      const v = Number(b[k]);
      if (!(v >= 0 && v <= 0.2)) throw err(400, k + ' doit être entre 0 et 0.2');
      await set(k, v);
    }
  }
  await audit(req.user.id, 'settings_update', JSON.stringify(b).slice(0, 200));
  res.json({ settings: await getSettings() });
}));

module.exports = r;

};
__defs['server'] = function (module, exports, require) {
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool, q } = require('./db');
const { wrap, normPhone } = require('./auth');
const { finalizePayment } = require('./payments');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : false }));

// Webhook Wave : corps brut nécessaire pour vérifier la signature (à vérifier dans la doc Wave)
app.post('/webhooks/wave', express.raw({ type: '*/*', limit: '100kb' }), wrap(async (req, res) => {
  const secret = process.env.WAVE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook non configuré' });
  const header = String(req.headers['wave-signature'] || '');
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const expected = crypto.createHmac('sha256', secret).update((parts.t || '') + req.body.toString('utf8')).digest('hex');
  const given = parts.v1 || '';
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return res.status(401).end();
  const ev = JSON.parse(req.body.toString('utf8'));
  if (ev.type === 'checkout.session.completed' && ev.data && /^TD-\d+$/.test(ev.data.client_reference || '')) {
    const id = Number(ev.data.client_reference.slice(3));
    const p = (await q('SELECT amount,fee FROM payments WHERE id=$1', [id])).rows[0];
    if (p && Number(ev.data.amount) === p.amount + p.fee) await finalizePayment(id);
  }
  res.json({ received: true });
}));

// Webhook Orange Money : le notif_token reçu à la création du paiement sert de secret
app.post('/webhooks/orange', express.json({ limit: '100kb' }), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.status === 'SUCCESS' && b.notif_token) {
    const p = (await q("SELECT id FROM payments WHERE provider_token=$1 AND method='orange' AND status='pending'", [String(b.notif_token)])).rows[0];
    if (p) await finalizePayment(p.id);
  }
  res.json({ received: true });
}));

app.use('/api/me/document', express.json({ limit: '3mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth', rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }), require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/member'));

app.get('/health', wrap(async (req, res) => { await q('SELECT 1'); res.json({ ok: true }); }));
const PAGES = {
  member: "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"><meta name=\"theme-color\" content=\"#0b4fa8\"><title>Tontine Digital 1.0</title>\n\n<style>\n:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);--bg:#effaf3;--card:#fff;--tx:#14312a;--mu:#5f7a70;--g:#0a9b6e;--gd:#066b4c;--gold:#f5b92e;--bd:#d6eadf;--ok:#dcf5e8;--okt:#066b4c;--sh:0 6px 18px rgba(8,100,70,.12)}\nhtml{scroll-padding-top:env(safe-area-inset-top,0px)}\n@media(prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){--bg:#0d1a15;--card:#16251e;--tx:#e6f3ed;--mu:#9bb8ab;--bd:#254036;--ok:#14382b;--okt:#8fe8c4;--sh:none}}\n:root[data-theme=\"dark\"]{--bg:#0d1a15;--card:#16251e;--tx:#e6f3ed;--mu:#9bb8ab;--bd:#254036;--ok:#14382b;--okt:#8fe8c4;--sh:none}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 Nunito,system-ui,-apple-system,'Segoe UI',sans-serif;padding-bottom:100px}\n#app{max-width:560px;margin:auto;padding:0 14px}\n.top{display:flex;justify-content:space-between;align-items:center;padding:14px 0;gap:8px}\n.logo{display:flex;align-items:center;gap:8px;font-size:17px;font-weight:800}\n.lg{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,var(--g),var(--gd));color:var(--gold);display:grid;place-items:center}\n.i{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}\n.sw{display:flex;background:var(--card);border-radius:999px;padding:3px;box-shadow:var(--sh)}\n.sw button{border:0;background:none;color:var(--mu);padding:6px 14px;border-radius:999px;font:700 13px Nunito,sans-serif;cursor:pointer}\n.sw .on,.tabs .on{background:var(--g);color:#fff}\n.tabs{display:flex;background:var(--bg);border-radius:12px;padding:3px;margin-bottom:10px}.tabs button{flex:1;border:0;background:none;color:var(--mu);padding:9px;border-radius:10px;font:700 14px Nunito,sans-serif;cursor:pointer}\n.hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#0a9b6e,#066b4c);color:#fff;border-radius:24px;padding:20px;min-height:160px;margin:6px 0 14px;box-shadow:var(--sh)}\n.hero h2{margin:4px 0;font-size:25px;font-weight:800;max-width:62%}.hero p{margin:2px 0;max-width:62%;opacity:.92}\n.art{position:absolute;right:-6px;bottom:0;width:48%}\n.c{background:var(--card);border-radius:18px;padding:16px;margin:12px 0;box-shadow:var(--sh);overflow-wrap:anywhere}\nh3{margin:0 0 6px;font-size:19px;font-weight:800}\ninput,select{width:100%;padding:12px;margin:5px 0;border:2px solid var(--bd);border-radius:12px;background:var(--bg);color:var(--tx);font:inherit}\ninput:focus,select:focus{outline:none;border-color:var(--g)}\n.b{width:100%;padding:13px;margin-top:8px;border:0;border-radius:14px;background:linear-gradient(135deg,var(--g),var(--gd));color:#fff;font:800 15px Nunito,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(8,100,70,.3)}\n.l{background:none;border:0;color:var(--g);padding:8px;font:800 14px Nunito,sans-serif;cursor:pointer}\n.mu{color:var(--mu);margin:4px 0}small.mu{font-size:12px}\n.msg{background:var(--ok);color:var(--okt);padding:12px;border-radius:14px;margin:8px 0;font-weight:700}.w{background:#fff1c9;color:#6b4e00}\n.g{display:grid;grid-template-columns:1fr 1fr;gap:12px}.g .c{margin:0}.g .c b{font-size:18px}\n.tile{background:var(--card);border:0;border-radius:18px;padding:16px 10px;font:800 14px Nunito,sans-serif;color:var(--tx);cursor:pointer;box-shadow:var(--sh);display:flex;flex-direction:column;align-items:center;gap:10px}\n.ic{width:50px;height:50px;border-radius:50%;display:grid;place-items:center;color:#fff}.ic .i{width:26px;height:26px}\nnav{position:fixed;bottom:calc(8px + env(safe-area-inset-bottom,0px));left:8px;right:8px;max-width:544px;margin:0 auto;display:flex;background:var(--card);border-radius:24px;box-shadow:0 8px 28px rgba(8,100,70,.22);padding:6px}\nnav button{flex:1;border:0;background:none;color:var(--mu);padding:7px 0;border-radius:18px;font:700 11px Nunito,sans-serif;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer}\nnav br{display:none}nav .on{background:var(--ok);color:var(--g)}\n.ok{color:var(--g);font-weight:800}.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--bd)}.row:last-child{border:0}\n.ck{display:flex;gap:8px;align-items:center;margin:8px 0}.ck input{width:auto}\n.wel{position:fixed;inset:0;z-index:5;overflow:auto;display:flex;padding:calc(20px + env(safe-area-inset-top,0px)) 20px 24px;background:radial-gradient(circle at 50% 28%,#1b6fd6 0%,#0b4fa8 42%,#052a63 100%);color:#fff;text-align:center}\n.wt{font:800 56px/.95 'Baloo 2','Arial Rounded MT Bold','Trebuchet MS',system-ui,sans-serif;transform:skewX(-8deg);text-shadow:0 4px 0 rgba(0,0,0,.25)}\n.wt2{display:flex;justify-content:center;align-items:center;gap:10px;transform:skewX(-8deg)}.wt2 span{font:800 50px/1 'Baloo 2','Arial Rounded MT Bold','Trebuchet MS',system-ui,sans-serif;color:#fbbf24;text-shadow:0 4px 0 rgba(0,0,0,.25)}.wt2 i{font:800 18px Nunito,sans-serif;font-style:normal;background:#16a34a;padding:2px 10px;border-radius:8px;margin-top:12px}\n.wtag{font-size:18px;font-weight:700;margin:12px 0 8px}.wbar{display:flex;gap:6px;justify-content:center}.wbar b{width:56px;height:4px;border-radius:2px}\n.wcap{font-size:12px;font-weight:700;letter-spacing:.12em;color:#d4e6ff;margin:10px 0 22px}\n.bg,.bo{width:100%;height:54px;margin-top:12px;border-radius:18px;font:800 17px Nunito,sans-serif;cursor:pointer}.bg{border:0;background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#0b2a5c;box-shadow:0 8px 20px rgba(245,158,11,.4)}.bo{border:2px solid rgba(255,255,255,.7);background:rgba(255,255,255,.08);color:#fff}\nbody{background:radial-gradient(circle at 50% 18%,#1b6fd6 0%,#0b4fa8 45%,#052a63 100%);background-attachment:fixed;min-height:100vh}\n#app{position:relative;z-index:1}\n.logo{color:#fff}\n#app>.l{color:#dbeafe}\n.bgart{position:fixed;inset:0;z-index:0;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:.13}\n.bgart svg{width:min(130vw,640px)!important;max-width:none!important;height:auto!important}\n</style></head><body><svg width=\"0\" height=\"0\" style=\"position:absolute\" aria-hidden=\"true\"><defs>\n<symbol id=\"i-home\" viewBox=\"0 0 24 24\"><path d=\"M3 11l9-8 9 8\"/><path d=\"M5 10v10h14V10\"/><path d=\"M10 20v-6h4v6\"/></symbol>\n<symbol id=\"i-users\" viewBox=\"0 0 24 24\"><circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6\"/><circle cx=\"17.5\" cy=\"9\" r=\"2.5\"/><path d=\"M17 14c2.8 0 4.5 1.8 4.5 4.5\"/></symbol>\n<symbol id=\"i-card\" viewBox=\"0 0 24 24\"><rect x=\"2.5\" y=\"5\" width=\"19\" height=\"14\" rx=\"3\"/><path d=\"M2.5 10h19M6.5 15h3\"/></symbol>\n<symbol id=\"i-history\" viewBox=\"0 0 24 24\"><path d=\"M3 12a9 9 0 1 0 3-6.7\"/><path d=\"M3 4v4h4M12 8v4l3 2\"/></symbol>\n<symbol id=\"i-user\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7\"/></symbol>\n<symbol id=\"i-chart\" viewBox=\"0 0 24 24\"><path d=\"M4 20V11M10 20V4M16 20v-6M22 20H2\"/></symbol>\n<symbol id=\"i-bank\" viewBox=\"0 0 24 24\"><path d=\"M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18\"/></symbol>\n<symbol id=\"i-gift\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"9\" width=\"18\" height=\"4\" rx=\"1\"/><path d=\"M5 13v8h14v-8M12 9v12M12 9c-2-4-6-3-5 0M12 9c2-4 6-3 5 0\"/></symbol>\n<symbol id=\"i-coin\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7.5v9M9.5 10h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4\"/></symbol>\n<symbol id=\"i-grid\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"2\"/></symbol>\n<symbol id=\"i-calendar\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"3\"/><path d=\"M3 10h18M8 3v4M16 3v4\"/></symbol>\n<symbol id=\"i-chat\" viewBox=\"0 0 24 24\"><path d=\"M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z\"/></symbol>\n<symbol id=\"i-bell\" viewBox=\"0 0 24 24\"><path d=\"M6 17V11a6 6 0 0112 0v6l1.5 2h-15z\"/><path d=\"M10 21h4\"/></symbol>\n<symbol id=\"i-settings\" viewBox=\"0 0 24 24\"><path d=\"M4 7h10M18 7h2M4 17h2M10 17h10\"/><circle cx=\"16\" cy=\"7\" r=\"2\"/><circle cx=\"8\" cy=\"17\" r=\"2\"/></symbol>\n</defs></svg><div id=\"app\"><div style=\"margin:16px;padding:16px;border-radius:12px;background:#0b4fa8;color:#fff;font-family:sans-serif\">Chargement…</div></div>\n<script>\n(function(){function show(m){var a=document.getElementById('app');if(a)a.innerHTML='<div style=\"margin:16px;padding:16px;border-radius:12px;background:#0b4fa8;color:#fff;font-family:sans-serif\"><h2 style=\"margin:0 0 8px\">Erreur d\\u2019affichage</h2><p style=\"margin:0;word-break:break-word\">'+String(m).replace(/</g,'&lt;')+'</p></div>'}\nwindow.addEventListener('error',function(e){show(e.message||e.error)});\nwindow.addEventListener('unhandledrejection',function(e){show(e.reason&&e.reason.message||e.reason)});})();\n</script>\n\n<script>\nconst TREE=`<svg viewBox=\"0 0 340 330\" style=\"width:100%;max-width:340px;height:auto\" role=\"img\" aria-label=\"Un arbre qui produit des pièces, porté par une main, entouré de membres de la communauté et d'un téléphone\">\n<defs>\n<linearGradient id=\"gd\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#fde68a\"/><stop offset=\"1\" stop-color=\"#f59e0b\"/></linearGradient>\n<g id=\"coin\"><circle r=\"11\" fill=\"url(#gd)\" stroke=\"#b45309\" stroke-width=\"2\"/><circle r=\"7.5\" fill=\"none\" stroke=\"#b45309\" stroke-width=\"1.2\" opacity=\".7\"/><text y=\"4\" text-anchor=\"middle\" font-size=\"11\" font-weight=\"800\" fill=\"#b45309\" font-family=\"Baloo 2,sans-serif\">F</text></g>\n<g id=\"spark\"><path d=\"M0-9L2.4-2.4 9 0 2.4 2.4 0 9-2.4 2.4-9 0-2.4-2.4z\" fill=\"#fde68a\"/></g>\n</defs>\n<circle cx=\"170\" cy=\"165\" r=\"158\" fill=\"#06306b\" opacity=\".55\" stroke=\"#f7b500\" stroke-width=\"6\"/>\n<use href=\"#spark\" x=\"62\" y=\"78\"/><use href=\"#spark\" x=\"118\" y=\"34\" transform=\"translate(0 0)\"/><use href=\"#spark\" x=\"296\" y=\"170\"/>\n<path d=\"M52 238C70 302 270 302 288 238 262 268 230 276 170 276 110 276 78 268 52 238z\" fill=\"#fbbf24\"/>\n<path d=\"M150 258C154 222 150 196 140 168L200 168C190 196 186 222 190 258z\" fill=\"#92400e\"/>\n<g stroke=\"#92400e\" stroke-width=\"9\" stroke-linecap=\"round\" fill=\"none\"><path d=\"M168 196L122 150\"/><path d=\"M172 196L220 148\"/><path d=\"M170 178V128\"/></g>\n<circle cx=\"170\" cy=\"96\" r=\"46\" fill=\"#1f9d4a\"/><circle cx=\"122\" cy=\"124\" r=\"34\" fill=\"#2dbb55\"/><circle cx=\"218\" cy=\"124\" r=\"34\" fill=\"#1d9a45\"/><circle cx=\"148\" cy=\"72\" r=\"31\" fill=\"#34c759\"/><circle cx=\"196\" cy=\"70\" r=\"31\" fill=\"#2dbb55\"/><circle cx=\"170\" cy=\"130\" r=\"34\" fill=\"#25a84f\"/>\n<circle cx=\"140\" cy=\"62\" r=\"10\" fill=\"#6ee7a0\" opacity=\".5\"/>\n<use href=\"#coin\" transform=\"translate(140 92) scale(1.15)\"/><use href=\"#coin\" transform=\"translate(198 80) scale(1.15)\"/><use href=\"#coin\" transform=\"translate(170 118) scale(1.25)\"/><use href=\"#coin\" transform=\"translate(112 128)\"/><use href=\"#coin\" transform=\"translate(228 128)\"/><use href=\"#coin\" transform=\"translate(166 50)\"/><use href=\"#coin\" transform=\"translate(212 108)\"/>\n<use href=\"#coin\" transform=\"translate(104 178) scale(.9)\"/><use href=\"#coin\" transform=\"translate(238 186) scale(.9)\"/><use href=\"#coin\" transform=\"translate(206 214) scale(.8)\"/>\n<g fill=\"url(#gd)\" stroke=\"#b45309\" stroke-width=\"2\"><ellipse cx=\"170\" cy=\"266\" rx=\"32\" ry=\"8\"/><ellipse cx=\"170\" cy=\"258\" rx=\"32\" ry=\"8\"/><ellipse cx=\"170\" cy=\"250\" rx=\"32\" ry=\"8\"/></g>\n<circle cx=\"58\" cy=\"152\" r=\"17\" fill=\"#2fb344\"/><path d=\"M28 238c0-36 12-54 30-54s30 18 30 54z\" fill=\"#2fb344\"/>\n<circle cx=\"282\" cy=\"152\" r=\"17\" fill=\"#3b82f6\"/><path d=\"M252 238c0-36 12-54 30-54s30 18 30 54z\" fill=\"#3b82f6\"/>\n<g transform=\"rotate(14 292 92)\"><rect x=\"268\" y=\"52\" width=\"46\" height=\"80\" rx=\"9\" fill=\"#0b3a8f\" stroke=\"#9cc4ff\" stroke-width=\"3\"/><circle cx=\"291\" cy=\"94\" r=\"13\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2.5\"/><path d=\"M285 94l5 5 9-10\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>\n</svg>`;\nconst ART=`<svg class=\"art\" viewBox=\"0 0 130 100\" aria-hidden=\"true\"><circle cx=\"100\" cy=\"24\" r=\"22\" fill=\"#f5b92e\" opacity=\".25\"/><circle cx=\"100\" cy=\"24\" r=\"15\" fill=\"#f5b92e\"/><ellipse cx=\"62\" cy=\"93\" rx=\"34\" ry=\"5\" fill=\"#000\" opacity=\".15\"/><circle cx=\"30\" cy=\"50\" r=\"9\" fill=\"#fff\"/><path d=\"M14 84c0-13 7-19 16-19s16 6 16 19z\" fill=\"#fff\"/><circle cx=\"62\" cy=\"40\" r=\"10\" fill=\"#ffd56b\"/><path d=\"M44 86c0-15 8-22 18-22s18 7 18 22z\" fill=\"#ffd56b\"/><circle cx=\"96\" cy=\"54\" r=\"9\" fill=\"#ffb27a\"/><path d=\"M80 86c0-13 7-19 16-19s16 6 16 19z\" fill=\"#ffb27a\"/></svg>`;\nwindow.API_BASE = window.API_BASE || '';\nconst API = window.API_BASE + '/api', $ = (i) => document.getElementById(i), V = (i) => ($(i).value || '').trim();\nconst f = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';\nconst esc = (s) => String(s == null ? '' : s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\nconst I = (n) => `<svg class=\"i\"><use href=\"#i-${n}\"/></svg>`;\nconst day = (x) => new Date(x).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });\nconst NM = [['menu', 'grid', 'Menu'], ['tont', 'users', 'Tontines'], ['pay', 'card', 'Cotiser'], ['hist', 'history', 'Historique'], ['prof', 'user', 'Profil']];\nconst REF = new URLSearchParams(location.search).get('ref') || '';\nconst LOGO = `<div class=\"logo\"><span class=\"lg\">${I('coin')}</span>Tontine Digital</div>`;\nlet T = null, U = null, view = 'home', tab = 'menu', msg = '', draft = null, docFile = null, phone0 = '', devotp = '', ct = 0;\ntry { T = localStorage.getItem('td_t'); } catch (e) {}\n\nasync function api(p, o) {\n  o = o || {};\n  const h = { 'Content-Type': 'application/json' };\n  if (T) h.Authorization = 'Bearer ' + T;\n  let r;\n  try { r = await fetch(API + p, { method: o.m || 'GET', headers: h, body: o.b ? JSON.stringify(o.b) : undefined }); }\n  catch (e) { throw new Error('Connexion impossible. Vérifiez votre réseau.'); }\n  let d = {};\n  try { d = await r.json(); } catch (e) {}\n  if (!r.ok) { if (r.status == 401 && T && p != '/auth/login') out(); throw new Error(d.error || 'Erreur (' + r.status + ')'); }\n  return d;\n}\nfunction setT(t) { T = t; try { localStorage.setItem('td_t', t); } catch (e) {} }\nfunction out() { T = null; U = null; try { localStorage.removeItem('td_t'); } catch (e) {} view = 'home'; R(); }\nfunction er(m) { const e = $('err'); if (e) { e.textContent = m; e.hidden = false; e.scrollIntoView({ block: 'nearest' }); } }\nasync function wait(fn) { try { await fn(); } catch (e) { er(e.message); } }\nfunction go(t) { tab = t; R(); }\nfunction img(file) {\n  return new Promise((ok, ko) => {\n    const i = new Image(), u = URL.createObjectURL(file);\n    i.onload = () => {\n      const k = Math.min(1, 1200 / Math.max(i.width, i.height)), c = document.createElement('canvas');\n      c.width = Math.round(i.width * k); c.height = Math.round(i.height * k);\n      c.getContext('2d').drawImage(i, 0, 0, c.width, c.height);\n      URL.revokeObjectURL(u); ok(c.toDataURL('image/jpeg', 0.8));\n    };\n    i.onerror = () => ko(new Error('Image illisible'));\n    i.src = u;\n  });\n}\n\nfunction W() {\n  return `<div class=\"wel\"><div style=\"max-width:380px;width:100%;margin:auto\">${TREE}<div class=\"wt\">Tontine</div><div class=\"wt2\"><span>Digital</span><i>1.0</i></div><p class=\"wtag\">Ensemble pour un meilleur avenir</p><div class=\"wbar\"><b style=\"background:#fbbf24\"></b><b style=\"background:#22c55e\"></b><b style=\"background:#3b82f6\"></b></div><p class=\"wcap\">ÉPARGNE • SOLIDARITÉ • PROSPÉRITÉ</p><button class=\"bg\" onclick=\"view='up';R()\">Créer mon compte</button><button class=\"bo\" onclick=\"view='in';R()\">Se connecter</button></div></div>`;\n}\nfunction AU() {\n  const back = `<button class=\"l\" onclick=\"view='home';R()\">← Accueil</button>`;\n  const test = devotp ? `<p class=\"mu\">Code de test : <b>${esc(devotp)}</b></p>` : '';\n  if (view == 'otp') return `<div class=\"c\"><h3>Vérification du numéro</h3><p class=\"mu\">Un code a été envoyé par SMS au ${esc(draft.phone)}.</p>${test}<input id=\"oc\" inputmode=\"numeric\" placeholder=\"Code à 6 chiffres\"><button class=\"b\" onclick=\"wait(chk)\">Valider le code</button><button class=\"l\" onclick=\"view='up';R()\">Modifier mes informations</button></div>`;\n  if (view == 'forgot') return `<div class=\"c\">${back}<h3>Mot de passe oublié</h3><input id=\"t\" inputmode=\"tel\" placeholder=\"Téléphone\"><button class=\"b\" onclick=\"wait(forgot)\">Recevoir un code</button></div>`;\n  if (view == 'reset') return `<div class=\"c\"><h3>Nouveau mot de passe</h3>${test}<input id=\"oc\" inputmode=\"numeric\" placeholder=\"Code reçu par SMS\"><input id=\"p\" type=\"password\" placeholder=\"Nouveau mot de passe (8 caractères min.)\"><button class=\"b\" onclick=\"wait(reset)\">Changer le mot de passe</button></div>`;\n  const up = view == 'up';\n  return `<div class=\"c\">${back}<div class=\"tabs\"><button class=\"${up ? '' : 'on'}\" onclick=\"view='in';R()\">Connexion</button><button class=\"${up ? 'on' : ''}\" onclick=\"view='up';R()\">Inscription</button></div>` + (up\n    ? `<input id=\"n\" placeholder=\"Nom complet\"><input id=\"d\" type=\"date\" title=\"Date de naissance\"><input id=\"t\" inputmode=\"tel\" placeholder=\"Téléphone (10 chiffres)\"><input id=\"e\" type=\"email\" placeholder=\"Email (facultatif)\"><select id=\"dt\"><option>CNI</option><option>Passeport</option><option>Carte consulaire</option><option>Autre</option></select><input id=\"dn\" placeholder=\"Numéro du document\"><label class=\"mu\">Photo du document (recommandé)<input id=\"df\" type=\"file\" accept=\"image/*\"></label><input id=\"r\" placeholder=\"Code parrain (facultatif)\" value=\"${esc(REF)}\"><input id=\"p\" type=\"password\" placeholder=\"Mot de passe (8 caractères min.)\"><label class=\"ck\"><input id=\"cg\" type=\"checkbox\"> J'accepte les conditions d'utilisation</label><button class=\"b\" onclick=\"wait(reg)\">Recevoir le code SMS</button>`\n    : `<input id=\"t\" inputmode=\"tel\" placeholder=\"Téléphone\"><input id=\"p\" type=\"password\" placeholder=\"Mot de passe\"><button class=\"b\" onclick=\"wait(log)\">Se connecter</button><button class=\"l\" onclick=\"view='forgot';R()\">Mot de passe oublié ?</button>`) + `</div>`;\n}\nasync function reg() {\n  const b = { name: V('n'), birth_date: V('d'), phone: V('t'), email: V('e') || undefined, doc_type: V('dt'), doc_number: V('dn'), password: $('p').value, referral_code: V('r') || undefined, accept_terms: $('cg').checked };\n  docFile = $('df').files[0] || null;\n  const d = await api('/auth/register', { m: 'POST', b });\n  draft = { phone: b.phone }; devotp = d.dev_otp || ''; view = 'otp'; R();\n}\nasync function chk() {\n  const d = await api('/auth/verify-otp', { m: 'POST', b: { phone: draft.phone, code: V('oc') } });\n  setT(d.token); U = d.user; devotp = ''; tab = 'menu';\n  if (docFile) { try { await api('/me/document', { m: 'POST', b: { image: await img(docFile) } }); } catch (e) {} docFile = null; }\n  msg = \"Compte créé. Il sera actif après validation par l'administrateur.\"; R();\n}\nasync function log() { const d = await api('/auth/login', { m: 'POST', b: { phone: V('t'), password: $('p').value } }); setT(d.token); U = d.user; tab = 'menu'; R(); }\nasync function forgot() { const d = await api('/auth/forgot', { m: 'POST', b: { phone: V('t') } }); phone0 = V('t'); devotp = d.dev_otp || ''; view = 'reset'; msg = d.message; R(); }\nasync function reset() { await api('/auth/reset', { m: 'POST', b: { phone: phone0, code: V('oc'), new_password: $('p').value } }); devotp = ''; view = 'in'; msg = 'Mot de passe modifié. Connectez-vous.'; R(); }\n\nasync function join(id) { await api('/tontines/' + id + '/join', { m: 'POST' }); msg = 'Vous avez rejoint la tontine.'; R(); }\nasync function quote() { const d = await api('/payments/quote?tontine_id=' + $('pt').value); $('qq').textContent = `Cotisation ${f(d.amount)} + commission ${f(d.fee)} = ${f(d.total)}`; }\nasync function pay() {\n  er('Création du paiement…');\n  const d = await api('/payments', { m: 'POST', b: { tontine_id: +$('pt').value, method: $('pm').value, payer_phone: V('pp') } });\n  if (d.checkout_url) { location.href = d.checkout_url; return; }\n  if (d.mock) { await api('/payments/' + d.payment_id + '/simulate', { m: 'POST' }); msg = 'Paiement confirmé (mode test) : ' + f(d.total); tab = 'hist'; return R(); }\n  er('Confirmez le paiement sur votre téléphone…');\n  for (let i = 0; i < 30; i++) {\n    await new Promise((r) => setTimeout(r, 3000));\n    const s = (await api('/payments/' + d.payment_id)).status;\n    if (s == 'paid') { msg = 'Paiement confirmé : ' + f(d.total); tab = 'hist'; return R(); }\n    if (s == 'failed') throw new Error('Paiement refusé ou annulé.');\n  }\n  msg = 'Paiement en attente de confirmation. Consultez votre historique.'; tab = 'hist'; R();\n}\nasync function send(id) { const v = V('cm'); if (!v) return; await api('/tontines/' + id + '/messages', { m: 'POST', b: { body: v } }); R(); }\nasync function chp() { await api('/me/password', { m: 'POST', b: { old_password: $('op').value, new_password: $('np').value } }); msg = 'Mot de passe modifié.'; R(); }\nasync function upDoc() { const fl = $('df').files[0]; if (!fl) throw new Error('Choisissez une photo.'); await api('/me/document', { m: 'POST', b: { image: await img(fl) } }); msg = 'Photo envoyée.'; R(); }\n\nasync function P() {\n  let b = '';\n  if (U.status != 'active') b += `<div class=\"msg w\">Compte ${U.status == 'pending' ? 'en attente de validation par l’administrateur' : 'non actif'}. Vous pourrez rejoindre une tontine et cotiser après validation.</div>`;\n  if (tab == 'menu') {\n    const [py, tt] = await Promise.all([api('/payments'), api('/tontines')]);\n    const tot = py.payments.filter((x) => x.status == 'paid').reduce((a, x) => a + x.amount, 0), nt = tt.tontines.filter((x) => x.joined).length;\n    const tiles = [['tont', 'users', '#0a8a62', 'Mes tontines'], ['pay', 'card', '#b87500', 'Cotiser'], ['hist', 'history', '#d9480f', 'Historique'], ['cal', 'calendar', '#6741d9', 'Calendrier'], ['parr', 'gift', '#0b7f8f', 'Parrainage'], ['chat', 'chat', '#1971c2', 'Discussion'], ['notif', 'bell', '#c2255c', 'Notifications'], ['prof', 'settings', '#495057', 'Paramètres']];\n    b += `<div class=\"hero\"><p>Bonjour ${esc(U.name.split(' ')[0])}</p><h2>${f(tot)}</h2><p>épargnés dans ${nt} tontine(s)</p>${ART}</div><div class=\"g\">${tiles.map((n) => `<button class=\"tile\" onclick=\"go('${n[0]}')\"><span class=\"ic\" style=\"background:${n[2]}\">${I(n[1])}</span>${n[3]}</button>`).join('')}</div>`;\n  }\n  if (tab == 'tont') b += (await api('/tontines')).tontines.map((x) => `<div class=\"c\"><b>${esc(x.name)}</b><p class=\"mu\">${f(x.amount)} par ${x.frequency == 'mois' ? 'mois' : 'semaine'} · ${x.members}/${x.max_members} membre(s)${x.status == 'running' ? ' · en cours' : ''}</p>${x.joined ? '<span class=\"ok\">Inscrit</span>' : x.status == 'open' ? `<button class=\"b\" onclick=\"wait(()=>join(${x.id}))\">Rejoindre</button>` : '<span class=\"mu\">Inscriptions closes</span>'}</div>`).join('') || '<div class=\"c\">Aucune tontine ouverte pour le moment.</div>';\n  if (tab == 'pay') {\n    const mine = (await api('/tontines')).tontines.filter((x) => x.joined);\n    b += mine.length ? `<div class=\"c\"><h3>Cotiser</h3><select id=\"pt\" onchange=\"wait(quote)\">${mine.map((x) => `<option value=\"${x.id}\">${esc(x.name)} — ${f(x.amount)}</option>`).join('')}</select><select id=\"pm\"><option value=\"wave\">Wave CI</option><option value=\"orange\">Orange Money CI</option><option value=\"mtn\">MTN MoMo</option></select><input id=\"pp\" inputmode=\"tel\" placeholder=\"Numéro qui paie (10 chiffres)\" value=\"${esc(U.phone)}\"><p id=\"qq\" class=\"mu\"></p><button class=\"b\" onclick=\"wait(pay)\">Payer</button></div>` : `<div class=\"c\">Rejoignez d'abord une tontine pour cotiser.</div>`;\n  }\n  if (tab == 'hist') { const h = (await api('/payments')).payments; b += `<div class=\"c\"><h3>Historique</h3>${h.map((x) => `<div class=\"row\"><span>${esc(x.tontine)}<br><small class=\"mu\">${new Date(x.created_at).toLocaleString('fr-FR')} · ${esc(x.method)} · ${{ paid: 'payé', pending: 'en attente', failed: 'échoué' }[x.status]}</small></span><b>${f(x.amount + x.fee)}</b></div>`).join('') || '<p class=\"mu\">Aucune cotisation pour le moment.</p>'}</div>`; }\n  if (tab == 'cal') { const it = (await api('/calendar')).items; b += `<div class=\"c\"><h3>Calendrier</h3>${it.map((x) => `<div class=\"row\"><span>${esc(x.name)}<br><small class=\"mu\">${x.beneficiary ? 'Bénéficiaire du tour : ' + esc(x.beneficiary) : 'Tirage non effectué'}${x.my_position ? ' · mon tour : n°' + x.my_position : ''}</small></span><b>${day(x.next_due)}</b></div>`).join('') || '<p class=\"mu\">Rejoignez une tontine pour voir vos échéances.</p>'}</div>`; }\n  if (tab == 'chat') {\n    const mine = (await api('/tontines')).tontines.filter((x) => x.joined);\n    if (!mine.length) b += `<div class=\"c\">Rejoignez une tontine pour discuter avec le groupe.</div>`;\n    else {\n      const id = mine.some((x) => x.id == ct) ? ct : mine[0].id, ms = (await api('/tontines/' + id + '/messages')).messages;\n      b += `<div class=\"c\"><h3>Discussion</h3><select onchange=\"ct=+this.value;R()\">${mine.map((x) => `<option value=\"${x.id}\" ${x.id == id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>${ms.map((m) => `<div class=\"row\"><span><b>${esc(m.author)}</b><br>${esc(m.body)}<br><small class=\"mu\">${new Date(m.created_at).toLocaleString('fr-FR')}</small></span></div>`).join('') || '<p class=\"mu\">Aucun message. Lancez la discussion !</p>'}<input id=\"cm\" maxlength=\"500\" placeholder=\"Votre message\"><button class=\"b\" onclick=\"wait(()=>send(${id}))\">Envoyer</button></div>`;\n    }\n  }\n  if (tab == 'notif') { const n = (await api('/notifications')).notifications; api('/notifications/read', { m: 'POST' }).catch(() => {}); b += `<div class=\"c\"><h3>Notifications</h3>${n.map((x) => `<div class=\"row\"><span>${esc(x.body)}<br><small class=\"mu\">${new Date(x.created_at).toLocaleString('fr-FR')}</small></span></div>`).join('') || '<p class=\"mu\">Aucune notification.</p>'}</div>`; }\n  if (tab == 'parr') { const d = await api('/referral'); b += `<div class=\"hero\"><p>Mon code parrain</p><h2>${esc(d.code)}</h2><p>Partagez-le avec vos proches</p>${ART}</div><div class=\"c\"><p>Filleuls directs : <b>${d.referred}</b></p><p>Commission gagnée : <b>${f(d.earned)}</b></p><small class=\"mu\">2 % de la première cotisation de chaque filleul.</small><button class=\"b\" onclick=\"navigator.clipboard&&navigator.clipboard.writeText(location.origin+'/member/?ref=${esc(d.code)}');er('Lien copié.')\">Copier mon lien d'invitation</button></div>`; }\n  if (tab == 'prof') b += `<div class=\"c\"><h3>${esc(U.name)}</h3><p class=\"mu\">${esc(U.phone)} · ${esc(U.doc_type || '')} ${esc(U.doc_number || '')}</p><p>Statut : <b>${{ active: 'actif', pending: 'en attente', refused: 'refusé', suspended: 'suspendu' }[U.status]}</b></p></div><div class=\"c\"><h3>Pièce d'identité</h3><p class=\"mu\">Photo de votre document (JPEG ou PNG).</p><input id=\"df\" type=\"file\" accept=\"image/*\"><button class=\"b\" onclick=\"wait(upDoc)\">Envoyer la photo</button></div><div class=\"c\"><h3>Paramètres</h3><input id=\"op\" type=\"password\" placeholder=\"Ancien mot de passe\"><input id=\"np\" type=\"password\" placeholder=\"Nouveau mot de passe (8 caractères min.)\"><button class=\"b\" onclick=\"wait(chp)\">Changer le mot de passe</button></div><button class=\"b\" onclick=\"out()\">Se déconnecter</button>`;\n  return b;\n}\nasync function R() {\n  const m = msg; msg = '';\n  if (T) { try { U = (await api('/me')).user; } catch (e) { if (!T) return; } }\n  const banner = `<div id=\"err\" class=\"msg\" ${m ? '' : 'hidden'}>${esc(m)}</div>`;\n  if (!T || !U) { $('app').innerHTML = view == 'home' ? W() : `<div class=\"top\">${LOGO}</div>${banner}${AU()}`; return; }\n  let b; try { b = await P(); } catch (e) { b = `<div class=\"msg w\">${esc(e.message)}</div>`; }\n  const nav = `<nav>${NM.map((n) => `<button class=\"${tab == n[0] ? 'on' : ''}\" onclick=\"go('${n[0]}')\">${I(n[1])}<br>${n[2]}</button>`).join('')}</nav>`;\n  $('app').innerHTML = `<div class=\"top\">${LOGO}</div>${banner}${tab == 'menu' ? '' : `<button class=\"l\" onclick=\"go('menu')\">← Retour au menu</button>`}${b}${nav}`;\n  if ($('qq')) wait(quote);\n  window.scrollTo(0, 0);\n}\ndocument.body.insertAdjacentHTML('afterbegin', '<div class=\"bgart\" aria-hidden=\"true\">' + TREE + '</div>');\n(function () {\n  const p = new URLSearchParams(location.search);\n  if (p.get('paid') == '1') { msg = 'Paiement en cours de confirmation.'; tab = 'hist'; }\n  if (p.get('paid') == '0') msg = 'Paiement annulé.';\n  if (REF && !T) view = 'up';\n  R();\n})();\n</script></body></html>\n",
  admin: "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"><meta name=\"robots\" content=\"noindex\"><title>Tontine Digital — Administration</title>\n\n<style>\n:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);--bg:#effaf3;--card:#fff;--tx:#14312a;--mu:#5f7a70;--g:#0a9b6e;--gd:#066b4c;--gold:#f5b92e;--bd:#d6eadf;--ok:#dcf5e8;--okt:#066b4c;--sh:0 6px 18px rgba(8,100,70,.12)}\nhtml{scroll-padding-top:env(safe-area-inset-top,0px)}\n@media(prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){--bg:#0d1a15;--card:#16251e;--tx:#e6f3ed;--mu:#9bb8ab;--bd:#254036;--ok:#14382b;--okt:#8fe8c4;--sh:none}}\n:root[data-theme=\"dark\"]{--bg:#0d1a15;--card:#16251e;--tx:#e6f3ed;--mu:#9bb8ab;--bd:#254036;--ok:#14382b;--okt:#8fe8c4;--sh:none}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 Nunito,system-ui,-apple-system,'Segoe UI',sans-serif;padding-bottom:100px}\n#app{max-width:560px;margin:auto;padding:0 14px}\n.top{display:flex;justify-content:space-between;align-items:center;padding:14px 0;gap:8px}\n.logo{display:flex;align-items:center;gap:8px;font-size:17px;font-weight:800}\n.lg{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,var(--g),var(--gd));color:var(--gold);display:grid;place-items:center}\n.i{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}\n.sw{display:flex;background:var(--card);border-radius:999px;padding:3px;box-shadow:var(--sh)}\n.sw button{border:0;background:none;color:var(--mu);padding:6px 14px;border-radius:999px;font:700 13px Nunito,sans-serif;cursor:pointer}\n.sw .on,.tabs .on{background:var(--g);color:#fff}\n.tabs{display:flex;background:var(--bg);border-radius:12px;padding:3px;margin-bottom:10px}.tabs button{flex:1;border:0;background:none;color:var(--mu);padding:9px;border-radius:10px;font:700 14px Nunito,sans-serif;cursor:pointer}\n.hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#0a9b6e,#066b4c);color:#fff;border-radius:24px;padding:20px;min-height:160px;margin:6px 0 14px;box-shadow:var(--sh)}\n.hero h2{margin:4px 0;font-size:25px;font-weight:800;max-width:62%}.hero p{margin:2px 0;max-width:62%;opacity:.92}\n.art{position:absolute;right:-6px;bottom:0;width:48%}\n.c{background:var(--card);border-radius:18px;padding:16px;margin:12px 0;box-shadow:var(--sh);overflow-wrap:anywhere}\nh3{margin:0 0 6px;font-size:19px;font-weight:800}\ninput,select{width:100%;padding:12px;margin:5px 0;border:2px solid var(--bd);border-radius:12px;background:var(--bg);color:var(--tx);font:inherit}\ninput:focus,select:focus{outline:none;border-color:var(--g)}\n.b{width:100%;padding:13px;margin-top:8px;border:0;border-radius:14px;background:linear-gradient(135deg,var(--g),var(--gd));color:#fff;font:800 15px Nunito,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(8,100,70,.3)}\n.l{background:none;border:0;color:var(--g);padding:8px;font:800 14px Nunito,sans-serif;cursor:pointer}\n.mu{color:var(--mu);margin:4px 0}small.mu{font-size:12px}\n.msg{background:var(--ok);color:var(--okt);padding:12px;border-radius:14px;margin:8px 0;font-weight:700}.w{background:#fff1c9;color:#6b4e00}\n.g{display:grid;grid-template-columns:1fr 1fr;gap:12px}.g .c{margin:0}.g .c b{font-size:18px}\n.tile{background:var(--card);border:0;border-radius:18px;padding:16px 10px;font:800 14px Nunito,sans-serif;color:var(--tx);cursor:pointer;box-shadow:var(--sh);display:flex;flex-direction:column;align-items:center;gap:10px}\n.ic{width:50px;height:50px;border-radius:50%;display:grid;place-items:center;color:#fff}.ic .i{width:26px;height:26px}\nnav{position:fixed;bottom:calc(8px + env(safe-area-inset-bottom,0px));left:8px;right:8px;max-width:544px;margin:0 auto;display:flex;background:var(--card);border-radius:24px;box-shadow:0 8px 28px rgba(8,100,70,.22);padding:6px}\nnav button{flex:1;border:0;background:none;color:var(--mu);padding:7px 0;border-radius:18px;font:700 11px Nunito,sans-serif;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer}\nnav br{display:none}nav .on{background:var(--ok);color:var(--g)}\n.ok{color:var(--g);font-weight:800}.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--bd)}.row:last-child{border:0}\n.ck{display:flex;gap:8px;align-items:center;margin:8px 0}.ck input{width:auto}\n.wel{position:fixed;inset:0;z-index:5;overflow:auto;display:flex;padding:calc(20px + env(safe-area-inset-top,0px)) 20px 24px;background:radial-gradient(circle at 50% 28%,#1b6fd6 0%,#0b4fa8 42%,#052a63 100%);color:#fff;text-align:center}\n.wt{font:800 56px/.95 'Baloo 2','Arial Rounded MT Bold','Trebuchet MS',system-ui,sans-serif;transform:skewX(-8deg);text-shadow:0 4px 0 rgba(0,0,0,.25)}\n.wt2{display:flex;justify-content:center;align-items:center;gap:10px;transform:skewX(-8deg)}.wt2 span{font:800 50px/1 'Baloo 2','Arial Rounded MT Bold','Trebuchet MS',system-ui,sans-serif;color:#fbbf24;text-shadow:0 4px 0 rgba(0,0,0,.25)}.wt2 i{font:800 18px Nunito,sans-serif;font-style:normal;background:#16a34a;padding:2px 10px;border-radius:8px;margin-top:12px}\n.wtag{font-size:18px;font-weight:700;margin:12px 0 8px}.wbar{display:flex;gap:6px;justify-content:center}.wbar b{width:56px;height:4px;border-radius:2px}\n.wcap{font-size:12px;font-weight:700;letter-spacing:.12em;color:#d4e6ff;margin:10px 0 22px}\n.bg,.bo{width:100%;height:54px;margin-top:12px;border-radius:18px;font:800 17px Nunito,sans-serif;cursor:pointer}.bg{border:0;background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#0b2a5c;box-shadow:0 8px 20px rgba(245,158,11,.4)}.bo{border:2px solid rgba(255,255,255,.7);background:rgba(255,255,255,.08);color:#fff}\nbody{background:radial-gradient(circle at 50% 18%,#1b6fd6 0%,#0b4fa8 45%,#052a63 100%);background-attachment:fixed;min-height:100vh}\n#app{position:relative;z-index:1}\n.logo{color:#fff}\n.bgart{position:fixed;inset:0;z-index:0;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:.13}\n.bgart svg{width:min(130vw,640px)!important;max-width:none!important;height:auto!important}\n</style><style>#app{max-width:760px}</style></head><body><svg width=\"0\" height=\"0\" style=\"position:absolute\" aria-hidden=\"true\"><defs>\n<symbol id=\"i-home\" viewBox=\"0 0 24 24\"><path d=\"M3 11l9-8 9 8\"/><path d=\"M5 10v10h14V10\"/><path d=\"M10 20v-6h4v6\"/></symbol>\n<symbol id=\"i-users\" viewBox=\"0 0 24 24\"><circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6\"/><circle cx=\"17.5\" cy=\"9\" r=\"2.5\"/><path d=\"M17 14c2.8 0 4.5 1.8 4.5 4.5\"/></symbol>\n<symbol id=\"i-card\" viewBox=\"0 0 24 24\"><rect x=\"2.5\" y=\"5\" width=\"19\" height=\"14\" rx=\"3\"/><path d=\"M2.5 10h19M6.5 15h3\"/></symbol>\n<symbol id=\"i-history\" viewBox=\"0 0 24 24\"><path d=\"M3 12a9 9 0 1 0 3-6.7\"/><path d=\"M3 4v4h4M12 8v4l3 2\"/></symbol>\n<symbol id=\"i-user\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7\"/></symbol>\n<symbol id=\"i-chart\" viewBox=\"0 0 24 24\"><path d=\"M4 20V11M10 20V4M16 20v-6M22 20H2\"/></symbol>\n<symbol id=\"i-bank\" viewBox=\"0 0 24 24\"><path d=\"M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18\"/></symbol>\n<symbol id=\"i-gift\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"9\" width=\"18\" height=\"4\" rx=\"1\"/><path d=\"M5 13v8h14v-8M12 9v12M12 9c-2-4-6-3-5 0M12 9c2-4 6-3 5 0\"/></symbol>\n<symbol id=\"i-coin\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7.5v9M9.5 10h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4\"/></symbol>\n<symbol id=\"i-grid\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"2\"/></symbol>\n<symbol id=\"i-calendar\" viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"3\"/><path d=\"M3 10h18M8 3v4M16 3v4\"/></symbol>\n<symbol id=\"i-chat\" viewBox=\"0 0 24 24\"><path d=\"M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z\"/></symbol>\n<symbol id=\"i-bell\" viewBox=\"0 0 24 24\"><path d=\"M6 17V11a6 6 0 0112 0v6l1.5 2h-15z\"/><path d=\"M10 21h4\"/></symbol>\n<symbol id=\"i-settings\" viewBox=\"0 0 24 24\"><path d=\"M4 7h10M18 7h2M4 17h2M10 17h10\"/><circle cx=\"16\" cy=\"7\" r=\"2\"/><circle cx=\"8\" cy=\"17\" r=\"2\"/></symbol>\n</defs></svg><div id=\"app\"><div style=\"margin:16px;padding:16px;border-radius:12px;background:#0b4fa8;color:#fff;font-family:sans-serif\">Chargement…</div></div>\n<script>\n(function(){function show(m){var a=document.getElementById('app');if(a)a.innerHTML='<div style=\"margin:16px;padding:16px;border-radius:12px;background:#0b4fa8;color:#fff;font-family:sans-serif\"><h2 style=\"margin:0 0 8px\">Erreur d\\u2019affichage</h2><p style=\"margin:0;word-break:break-word\">'+String(m).replace(/</g,'&lt;')+'</p></div>'}\nwindow.addEventListener('error',function(e){show(e.message||e.error)});\nwindow.addEventListener('unhandledrejection',function(e){show(e.reason&&e.reason.message||e.reason)});})();\n</script>\n\n<div id=\"ov\" class=\"wel\" style=\"display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(5,20,50,.92)\"></div>\n<script>\nconst TREE=`<svg viewBox=\"0 0 340 330\" style=\"width:100%;max-width:340px;height:auto\" role=\"img\" aria-label=\"Un arbre qui produit des pièces, porté par une main, entouré de membres de la communauté et d'un téléphone\">\n<defs>\n<linearGradient id=\"gd\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#fde68a\"/><stop offset=\"1\" stop-color=\"#f59e0b\"/></linearGradient>\n<g id=\"coin\"><circle r=\"11\" fill=\"url(#gd)\" stroke=\"#b45309\" stroke-width=\"2\"/><circle r=\"7.5\" fill=\"none\" stroke=\"#b45309\" stroke-width=\"1.2\" opacity=\".7\"/><text y=\"4\" text-anchor=\"middle\" font-size=\"11\" font-weight=\"800\" fill=\"#b45309\" font-family=\"Baloo 2,sans-serif\">F</text></g>\n<g id=\"spark\"><path d=\"M0-9L2.4-2.4 9 0 2.4 2.4 0 9-2.4 2.4-9 0-2.4-2.4z\" fill=\"#fde68a\"/></g>\n</defs>\n<circle cx=\"170\" cy=\"165\" r=\"158\" fill=\"#06306b\" opacity=\".55\" stroke=\"#f7b500\" stroke-width=\"6\"/>\n<use href=\"#spark\" x=\"62\" y=\"78\"/><use href=\"#spark\" x=\"118\" y=\"34\" transform=\"translate(0 0)\"/><use href=\"#spark\" x=\"296\" y=\"170\"/>\n<path d=\"M52 238C70 302 270 302 288 238 262 268 230 276 170 276 110 276 78 268 52 238z\" fill=\"#fbbf24\"/>\n<path d=\"M150 258C154 222 150 196 140 168L200 168C190 196 186 222 190 258z\" fill=\"#92400e\"/>\n<g stroke=\"#92400e\" stroke-width=\"9\" stroke-linecap=\"round\" fill=\"none\"><path d=\"M168 196L122 150\"/><path d=\"M172 196L220 148\"/><path d=\"M170 178V128\"/></g>\n<circle cx=\"170\" cy=\"96\" r=\"46\" fill=\"#1f9d4a\"/><circle cx=\"122\" cy=\"124\" r=\"34\" fill=\"#2dbb55\"/><circle cx=\"218\" cy=\"124\" r=\"34\" fill=\"#1d9a45\"/><circle cx=\"148\" cy=\"72\" r=\"31\" fill=\"#34c759\"/><circle cx=\"196\" cy=\"70\" r=\"31\" fill=\"#2dbb55\"/><circle cx=\"170\" cy=\"130\" r=\"34\" fill=\"#25a84f\"/>\n<circle cx=\"140\" cy=\"62\" r=\"10\" fill=\"#6ee7a0\" opacity=\".5\"/>\n<use href=\"#coin\" transform=\"translate(140 92) scale(1.15)\"/><use href=\"#coin\" transform=\"translate(198 80) scale(1.15)\"/><use href=\"#coin\" transform=\"translate(170 118) scale(1.25)\"/><use href=\"#coin\" transform=\"translate(112 128)\"/><use href=\"#coin\" transform=\"translate(228 128)\"/><use href=\"#coin\" transform=\"translate(166 50)\"/><use href=\"#coin\" transform=\"translate(212 108)\"/>\n<use href=\"#coin\" transform=\"translate(104 178) scale(.9)\"/><use href=\"#coin\" transform=\"translate(238 186) scale(.9)\"/><use href=\"#coin\" transform=\"translate(206 214) scale(.8)\"/>\n<g fill=\"url(#gd)\" stroke=\"#b45309\" stroke-width=\"2\"><ellipse cx=\"170\" cy=\"266\" rx=\"32\" ry=\"8\"/><ellipse cx=\"170\" cy=\"258\" rx=\"32\" ry=\"8\"/><ellipse cx=\"170\" cy=\"250\" rx=\"32\" ry=\"8\"/></g>\n<circle cx=\"58\" cy=\"152\" r=\"17\" fill=\"#2fb344\"/><path d=\"M28 238c0-36 12-54 30-54s30 18 30 54z\" fill=\"#2fb344\"/>\n<circle cx=\"282\" cy=\"152\" r=\"17\" fill=\"#3b82f6\"/><path d=\"M252 238c0-36 12-54 30-54s30 18 30 54z\" fill=\"#3b82f6\"/>\n<g transform=\"rotate(14 292 92)\"><rect x=\"268\" y=\"52\" width=\"46\" height=\"80\" rx=\"9\" fill=\"#0b3a8f\" stroke=\"#9cc4ff\" stroke-width=\"3\"/><circle cx=\"291\" cy=\"94\" r=\"13\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2.5\"/><path d=\"M285 94l5 5 9-10\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>\n</svg>`;\nwindow.API_BASE = window.API_BASE || '';\ndocument.body.insertAdjacentHTML('afterbegin', '<div class=\"bgart\" aria-hidden=\"true\">' + TREE + '</div>');\nconst API = window.API_BASE + '/api', $ = (i) => document.getElementById(i), V = (i) => ($(i).value || '').trim();\nconst f = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';\nconst esc = (s) => String(s == null ? '' : s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\nconst I = (n) => `<svg class=\"i\"><use href=\"#i-${n}\"/></svg>`;\nconst NA = [['dash', 'chart', 'Tableau'], ['mem', 'users', 'Membres'], ['tont', 'bank', 'Tontines'], ['pay', 'card', 'Paiements'], ['set', 'settings', 'Réglages']];\nconst ST = { pending: 'en attente', active: 'actif', refused: 'refusé', suspended: 'suspendu' };\nlet T = null, tab = 'dash', msg = '';\ntry { T = localStorage.getItem('td_admin'); } catch (e) {}\nasync function api(p, o) {\n  o = o || {};\n  const h = { 'Content-Type': 'application/json' };\n  if (T) h.Authorization = 'Bearer ' + T;\n  let r;\n  try { r = await fetch(API + p, { method: o.m || 'GET', headers: h, body: o.b ? JSON.stringify(o.b) : undefined }); }\n  catch (e) { throw new Error('Connexion impossible.'); }\n  let d = {};\n  try { d = await r.json(); } catch (e) {}\n  if (!r.ok) { if (r.status == 401 && T && p != '/auth/login') out(); throw new Error(d.error || 'Erreur (' + r.status + ')'); }\n  return d;\n}\nfunction er(m) { const e = $('err'); if (e) { e.textContent = m; e.hidden = false; } }\nasync function wait(fn) { try { await fn(); } catch (e) { er(e.message); } }\nfunction out() { T = null; try { localStorage.removeItem('td_admin'); } catch (e) {} R(); }\nfunction go(t) { tab = t; R(); }\nasync function log() {\n  const d = await api('/auth/login', { m: 'POST', b: { phone: V('t'), password: $('p').value } });\n  if (d.user.role != 'admin') throw new Error('Accès réservé aux administrateurs.');\n  T = d.token; try { localStorage.setItem('td_admin', T); } catch (e) {} R();\n}\nasync function setSt(id, st) { let reason; if (st == 'refused') reason = prompt('Motif du refus (envoyé au membre) :') || undefined; await api('/admin/users/' + id + '/status', { m: 'POST', b: { status: st, reason } }); R(); }\nasync function doc(id) {\n  const r = await fetch(API + '/admin/users/' + id + '/document', { headers: { Authorization: 'Bearer ' + T } });\n  if (!r.ok) throw new Error('Aucune photo pour ce membre.');\n  const u = URL.createObjectURL(await r.blob()), o = $('ov');\n  o.innerHTML = `<img src=\"${u}\" alt=\"Pièce d'identité\" style=\"max-width:100%;max-height:78vh;border-radius:12px\"><button class=\"bo\" style=\"max-width:240px\" onclick=\"$('ov').style.display='none'\">Fermer</button>`;\n  o.style.display = 'flex';\n}\nasync function addT() { await api('/admin/tontines', { m: 'POST', b: { name: V('tn'), amount: +V('ta'), frequency: V('tf'), max_members: +V('tm') || 20 } }); R(); }\nasync function act(id, a) { if (a == 'draw' && !confirm('Tirer au sort l’ordre des bénéficiaires et démarrer la tontine ?')) return; await api('/admin/tontines/' + id + '/' + a, { m: 'POST' }); R(); }\nasync function saveSet() { await api('/admin/settings', { m: 'PUT', b: { commission_mode: V('cm'), platform_rate: +V('pr') / 100, referral_rate: +V('rr') / 100 } }); msg = 'Réglages enregistrés.'; R(); }\nconst userRow = (u, acts) => `<div class=\"row\"><span><b>${esc(u.name)}</b><br><small class=\"mu\">${esc(u.phone)} · ${esc(u.doc_type || '')} ${esc(u.doc_number || '')} · ${ST[u.status]}${u.has_document ? '' : ' · sans photo'}</small></span><span>${u.has_document ? `<button class=\"l\" onclick=\"wait(()=>doc(${u.id}))\">Pièce</button>` : ''}${acts}</span></div>`;\nasync function P() {\n  if (tab == 'dash') {\n    const [s, u] = await Promise.all([api('/admin/stats'), api('/admin/users?status=pending')]);\n    return `<div class=\"g\"><div class=\"c\"><b>${s.members}</b><p class=\"mu\">Membres</p></div><div class=\"c\"><b>${s.pending}</b><p class=\"mu\">À valider</p></div><div class=\"c\"><b>${f(s.collected)}</b><p class=\"mu\">Collecté</p></div><div class=\"c\"><b>${f(s.fees)}</b><p class=\"mu\">Commissions</p></div></div><div class=\"c\"><h3>Inscriptions à valider</h3>${u.users.map((x) => userRow(x, `<button class=\"l\" onclick=\"wait(()=>setSt(${x.id},'active'))\">Valider</button><button class=\"l\" onclick=\"wait(()=>setSt(${x.id},'refused'))\">Refuser</button>`)).join('') || '<p class=\"mu\">Aucune inscription en attente.</p>'}</div>`;\n  }\n  if (tab == 'mem') return `<div class=\"c\"><h3>Membres</h3>${(await api('/admin/users')).users.map((x) => userRow(x, x.status == 'active' ? `<button class=\"l\" onclick=\"wait(()=>setSt(${x.id},'suspended'))\">Suspendre</button>` : `<button class=\"l\" onclick=\"wait(()=>setSt(${x.id},'active'))\">Activer</button>`)).join('') || '<p class=\"mu\">Aucun membre.</p>'}</div>`;\n  if (tab == 'tont') return `<div class=\"c\"><h3>Créer une tontine</h3><input id=\"tn\" placeholder=\"Nom\"><input id=\"ta\" type=\"number\" inputmode=\"numeric\" placeholder=\"Cotisation (FCFA, 500 minimum)\"><select id=\"tf\"><option value=\"semaine\">Chaque semaine</option><option value=\"mois\">Chaque mois</option></select><input id=\"tm\" type=\"number\" placeholder=\"Nombre maximum de membres (20 par défaut)\"><button class=\"b\" onclick=\"wait(addT)\">Créer la tontine</button></div>` + (await api('/admin/tontines')).tontines.map((x) => `<div class=\"c\"><b>${esc(x.name)}</b><p class=\"mu\">${f(x.amount)} par ${x.frequency} · ${x.members}/${x.max_members} membre(s) · ${{ open: 'ouverte', running: 'tour ' + x.current_round, closed: 'terminée' }[x.status]}</p>${x.status == 'open' ? `<button class=\"b\" onclick=\"wait(()=>act(${x.id},'draw'))\">Tirer l'ordre et démarrer</button>` : ''}${x.status == 'running' ? `<button class=\"b\" onclick=\"wait(()=>act(${x.id},'next-round'))\">Passer au tour suivant</button>` : ''}</div>`).join('');\n  if (tab == 'pay') return `<div class=\"c\"><h3>Paiements</h3>${(await api('/admin/payments')).payments.map((x) => `<div class=\"row\"><span>${esc(x.member)} — ${esc(x.tontine)}<br><small class=\"mu\">${new Date(x.created_at).toLocaleString('fr-FR')} · ${esc(x.method)} · ${{ paid: 'payé', pending: 'en attente', failed: 'échoué' }[x.status]}</small></span><b>${f(x.amount + x.fee)}</b></div>`).join('') || '<p class=\"mu\">Aucun paiement.</p>'}</div>`;\n  const s = (await api('/admin/settings')).settings;\n  return `<div class=\"c\"><h3>Commissions</h3><label class=\"mu\">Commission plateforme appliquée</label><select id=\"cm\"><option value=\"first\" ${s.commission_mode == 'first' ? 'selected' : ''}>À la première cotisation seulement</option><option value=\"each\" ${s.commission_mode == 'each' ? 'selected' : ''}>À chaque cotisation</option></select><label class=\"mu\">Taux plateforme (%)</label><input id=\"pr\" type=\"number\" step=\"0.1\" value=\"${+s.platform_rate * 100}\"><label class=\"mu\">Taux de parrainage (%)</label><input id=\"rr\" type=\"number\" step=\"0.1\" value=\"${+s.referral_rate * 100}\"><button class=\"b\" onclick=\"wait(saveSet)\">Enregistrer</button></div><button class=\"b\" onclick=\"out()\">Se déconnecter</button>`;\n}\nasync function R() {\n  const m = msg; msg = '';\n  const banner = `<div id=\"err\" class=\"msg\" ${m ? '' : 'hidden'}>${esc(m)}</div>`;\n  const top = `<div class=\"top\"><div class=\"logo\"><span class=\"lg\">${I('coin')}</span>Administration</div></div>`;\n  if (!T) { $('app').innerHTML = `${top}${banner}<div class=\"c\"><h3>Connexion administrateur</h3><input id=\"t\" inputmode=\"tel\" placeholder=\"Téléphone\"><input id=\"p\" type=\"password\" placeholder=\"Mot de passe\"><button class=\"b\" onclick=\"wait(log)\">Se connecter</button></div>`; return; }\n  let b; try { b = await P(); } catch (e) { b = `<div class=\"msg w\">${esc(e.message)}</div>`; }\n  $('app').innerHTML = `${top}${banner}${b}<nav>${NA.map((n) => `<button class=\"${tab == n[0] ? 'on' : ''}\" onclick=\"go('${n[0]}')\">${I(n[1])}<br>${n[2]}</button>`).join('')}</nav>`;\n}\nR();\n</script></body></html>\n",
};
const page = (name) => (req, res) => res.type('html').send(PAGES[name]);
app.get('/ping', (req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tontine Digital</title><body style="font-family:sans-serif;padding:24px"><h1>Tontine Digital 1.0</h1><p>Le serveur répond.</p><p id="js">JavaScript : non actif</p><p>Page membre : ${PAGES.member.length} caractères · Administration : ${PAGES.admin.length} caractères</p><p><a href="/member/">Espace membre</a> · <a href="/admin/">Administration</a> · <a href="/health">État</a></p><script>document.getElementById('js').textContent='JavaScript : actif ✔'</script></body>`));
app.get(['/member', '/member/'], page('member'));
app.get(['/admin', '/admin/'], page('admin'));
app.get('/', (req, res) => res.redirect('/member/'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Route introuvable' }));
app.use((e, req, res, next) => {
  if (!e.status || e.status >= 500) console.error(e);
  res.status(e.status || 500).json({ error: e.status && e.status < 500 ? e.message : 'Erreur interne du serveur' });
});

async function ensureAdmin() {
  const phone = normPhone(process.env.ADMIN_PHONE), pw = process.env.ADMIN_PASSWORD;
  if (!phone || !pw) return;
  if ((await q('SELECT 1 FROM users WHERE phone=$1', [phone])).rows[0]) return;
  await q(
    "INSERT INTO users(name,birth_date,phone,password_hash,role,status,ref_code) VALUES($1,'1990-01-01',$2,$3,'admin','active','TDADMIN')",
    [process.env.ADMIN_NAME || 'Administrateur', phone, await bcrypt.hash(pw, 10)]);
  console.log('Compte administrateur créé.');
}

const port = process.env.PORT || 3000;
(async () => {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    console.log('Base de données prête.');
  } catch (e) {
    console.error('Migration échouée :', e.message);
    process.exit(1);
  }
  await ensureAdmin().catch((e) => console.error('Admin :', e.message));
  app.listen(port, () => console.log('API Tontine Digital sur le port ' + port));
})();

};
function __key(n) { const p = n.replace(/^(\.\.?\/)+/, ''); return p.startsWith('routes/') ? 'routes_' + p.slice(7) : p; }
function __load(n) {
  const k = __key(n);
  if (__cache[k]) return __cache[k].exports;
  const m = { exports: {} };
  __cache[k] = m;
  __defs[k](m, m.exports, (x) => (x.startsWith('.') ? __load(x) : __nodeRequire(x)));
  return m.exports;
}
__load('./server');
