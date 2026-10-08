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
// Servir les fichiers CSS et JavaScript utilisés par member.html et admin.html.
app.use('/assets', express.static(path.join(__dirname, 'assets')));

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
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get(['/member', '/member/'], page('member.html'));
app.get(['/admin', '/admin/'], page('admin.html'));
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
