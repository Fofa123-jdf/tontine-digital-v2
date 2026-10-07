require('dotenv').config();
const express = require('express'), { Pool } = require('pg'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const helmet = require('helmet'), rl = require('express-rate-limit'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const { DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, PORT = 3000 } = process.env;
if (!DATABASE_URL || !JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Variables requises : DATABASE_URL et JWT_SECRET (32 caractères minimum).');
  process.exit(1);
}
const SCHEMA = process.env.DB_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]{0,40}$/.test(SCHEMA)) { console.error('DB_SCHEMA invalide.'); process.exit(1); }
const ssl = process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false };
const pool = new Pool({ connectionString: DATABASE_URL, ssl, options: '-c search_path=' + SCHEMA });
const METHODS = ['Wave', 'Orange Money', 'MTN MoMo'];

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '20kb' }));

const lim = (n, ms) => rl({ windowMs: ms, limit: n, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de tentatives, réessayez plus tard.' } });
app.use('/api', lim(300, 60000));
const authLim = lim(20, 15 * 60000);

const h = f => (q, s) => f(q, s).catch(e => { console.error(e); s.status(500).json({ error: 'Erreur serveur.' }); });
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
const phone = v => String(v || '').replace(/[^\d+]/g, '');
const sign = u => jwt.sign({ id: u.id, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
const note = (uid, body) => pool.query('INSERT INTO notifications(user_id,body) VALUES($1,$2)', [uid, body]);
const bad = (s, m, c = 400) => s.status(c).json({ error: m });

const auth = role => async (q, s, n) => {
  let d;
  try { d = jwt.verify((q.headers.authorization || '').slice(7), JWT_SECRET); } catch (e) { return bad(s, 'Session expirée, reconnectez-vous.', 401); }
  try {
    const u = (await pool.query('SELECT id,role,status FROM users WHERE id=$1', [d.id])).rows[0];
    if (!u || u.status !== 'Actif') return bad(s, 'Compte inactif.', 401);
    if (role && u.role !== role) return bad(s, 'Accès refusé.', 403);
    q.u = u; n();
  } catch (e) { console.error(e); bad(s, 'Erreur serveur.', 500); }
};

// ---------- Authentification ----------
app.post('/api/register', authLim, h(async (q, s) => {
  const { name, password, referral } = q.body || {}, p = phone(q.body && q.body.phone);
  if (!str(name, 2, 80) || !/^\+?\d{8,15}$/.test(p) || !str(password, 8, 100)) return bad(s, 'Nom, téléphone valide et mot de passe de 8 caractères minimum requis.');
  let ref = null;
  if (referral) ref = (await pool.query('SELECT id FROM users WHERE referral_code=$1', [String(referral).trim().toUpperCase()])).rows[0]?.id || null;
  const hash = await bcrypt.hash(password, 11), code = 'TD-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  try {
    const u = (await pool.query('INSERT INTO users(name,phone,password_hash,referral_code,referred_by) VALUES($1,$2,$3,$4,$5) RETURNING id,role', [name.trim(), p, hash, code, ref])).rows[0];
    if (ref) await note(ref, name.trim() + ' s\u2019est inscrit avec votre code parrain.');
    s.json({ token: sign(u), role: u.role });
  } catch (e) { if (e.code === '23505') return bad(s, 'Ce numéro est déjà inscrit.', 409); throw e; }
}));

app.post('/api/login', authLim, h(async (q, s) => {
  const { id, password } = q.body || {};
  if (!str(id, 3, 120) || !str(password, 1, 100)) return bad(s, 'Saisissez vos identifiants.');
  const x = id.trim();
  const u = (await pool.query('SELECT * FROM users WHERE phone=$1 OR email=lower($2)', [phone(x), x])).rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return bad(s, 'Identifiants incorrects.', 401);
  if (u.status !== 'Actif') return bad(s, 'Ce compte est désactivé.', 403);
  s.json({ token: sign(u), role: u.role });
}));

app.get('/api/config', (q, s) => s.json({ payInfo: process.env.PAY_INSTRUCTIONS || '' }));

// ---------- Compte ----------
app.get('/api/me', auth(), h(async (q, s) => s.json((await pool.query('SELECT id,name,phone,email,referral_code,role FROM users WHERE id=$1', [q.u.id])).rows[0])));

app.put('/api/me', auth(), h(async (q, s) => {
  const { name, email } = q.body || {}, p = phone(q.body && q.body.phone);
  if (!str(name, 2, 80) || (p && !/^\+?\d{8,15}$/.test(p)) || (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return bad(s, 'Informations invalides.');
  try {
    await pool.query('UPDATE users SET name=$1,phone=$2,email=$3 WHERE id=$4', [name.trim(), p || null, email ? email.trim().toLowerCase() : null, q.u.id]);
    s.json({ ok: true });
  } catch (e) { if (e.code === '23505') return bad(s, 'Ce téléphone ou cet email est déjà utilisé.', 409); throw e; }
}));

app.post('/api/me/password', auth(), authLim, h(async (q, s) => {
  const { old, neu } = q.body || {};
  if (!str(neu, 8, 100)) return bad(s, 'Le nouveau mot de passe doit contenir 8 caractères minimum.');
  const u = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [q.u.id])).rows[0];
  if (!(await bcrypt.compare(String(old || ''), u.password_hash))) return bad(s, 'Ancien mot de passe incorrect.', 401);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(neu, 11), q.u.id]);
  s.json({ ok: true });
}));

// ---------- Tontines ----------
app.get('/api/tontines', auth(), h(async (q, s) => s.json((await pool.query(
  `SELECT t.id,t.name,t.amount,t.max_members,to_char(t.next_date,'DD/MM/YYYY') next_date,
     (SELECT count(*)::int FROM memberships m WHERE m.tontine_id=t.id) members,
     EXISTS(SELECT 1 FROM memberships m WHERE m.tontine_id=t.id AND m.user_id=$1) joined
   FROM tontines t WHERE t.status='En cours' ORDER BY t.id DESC LIMIT 200`, [q.u.id])).rows)));

app.post('/api/tontines', auth(), h(async (q, s) => {
  const { name } = q.body || {}, amount = Number(q.body && q.body.amount), max = Number(q.body && q.body.max_members) || 10;
  if (!str(name, 3, 60) || !Number.isInteger(amount) || amount < 1000 || amount > 5000000 || !Number.isInteger(max) || max < 2 || max > 50) return bad(s, 'Nom (3 caractères min.), montant entre 1 000 et 5 000 000 FCFA, 2 à 50 membres.');
  const t = (await pool.query(`INSERT INTO tontines(name,amount,max_members,next_date,created_by) VALUES($1,$2,$3,current_date+30,$4) RETURNING id`, [name.trim(), amount, max, q.u.id])).rows[0];
  await pool.query('INSERT INTO memberships(tontine_id,user_id) VALUES($1,$2)', [t.id, q.u.id]);
  s.json({ id: t.id });
}));

app.post('/api/tontines/:id/join', auth(), h(async (q, s) => {
  const id = Number(q.params.id);
  if (!Number.isInteger(id)) return bad(s, 'Tontine introuvable.', 404);
  const t = (await pool.query(`SELECT max_members,status,(SELECT count(*)::int FROM memberships WHERE tontine_id=$1) n FROM tontines WHERE id=$1`, [id])).rows[0];
  if (!t || t.status !== 'En cours') return bad(s, 'Tontine introuvable.', 404);
  if (t.n >= t.max_members) return bad(s, 'Cette tontine est complète.', 409);
  await pool.query('INSERT INTO memberships(tontine_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, q.u.id]);
  s.json({ ok: true });
}));

const member = async (tid, uid) => Number.isInteger(tid) && (await pool.query('SELECT 1 FROM memberships WHERE tontine_id=$1 AND user_id=$2', [tid, uid])).rowCount > 0;

app.get('/api/tontines/:id/messages', auth(), h(async (q, s) => {
  const id = Number(q.params.id);
  if (!(await member(id, q.u.id))) return bad(s, 'Rejoignez cette tontine pour voir la discussion.', 403);
  s.json((await pool.query(`SELECT u.name who,(m.user_id=$2) mine,m.body FROM messages m JOIN users u ON u.id=m.user_id WHERE m.tontine_id=$1 ORDER BY m.id DESC LIMIT 100`, [id, q.u.id])).rows.reverse());
}));

app.post('/api/tontines/:id/messages', auth(), h(async (q, s) => {
  const id = Number(q.params.id), body = q.body && q.body.body;
  if (!str(body, 1, 500)) return bad(s, 'Message vide ou trop long (500 caractères max.).');
  if (!(await member(id, q.u.id))) return bad(s, 'Rejoignez cette tontine pour écrire.', 403);
  await pool.query('INSERT INTO messages(tontine_id,user_id,body) VALUES($1,$2,$3)', [id, q.u.id, body.trim()]);
  s.json({ ok: true });
}));

// ---------- Paiements (confirmation manuelle par l'administrateur) ----------
app.post('/api/payments', auth(), h(async (q, s) => {
  const { method } = q.body || {}, tid = Number(q.body && q.body.tontine_id), ref = String((q.body && q.body.reference) || '').trim();
  if (!METHODS.includes(method) || ref.length < 4 || ref.length > 40) return bad(s, 'Choisissez un moyen de paiement et saisissez la référence (4 à 40 caractères).');
  if (!(await member(tid, q.u.id))) return bad(s, 'Rejoignez d\u2019abord cette tontine.', 403);
  const t = (await pool.query(`SELECT name,amount FROM tontines WHERE id=$1 AND status='En cours'`, [tid])).rows[0];
  if (!t) return bad(s, 'Cette tontine n\u2019accepte plus de paiements.', 409);
  try { await pool.query('INSERT INTO payments(tontine_id,user_id,amount,method,reference) VALUES($1,$2,$3,$4,$5)', [tid, q.u.id, t.amount, method, ref]); }
  catch (e) { if (e.code === '23505') return bad(s, 'Cette référence a déjà été déclarée.', 409); throw e; }
  await note(q.u.id, 'Paiement de ' + t.amount.toLocaleString('fr-FR') + ' FCFA déclaré pour ' + t.name + ', en attente de confirmation.');
  s.json({ ok: true });
}));

app.get('/api/payments', auth(), h(async (q, s) => s.json((await pool.query(
  `SELECT p.id,t.name tontine,p.amount,p.method,p.status,to_char(p.created_at,'DD/MM/YYYY') date FROM payments p JOIN tontines t ON t.id=p.tontine_id WHERE p.user_id=$1 ORDER BY p.id DESC LIMIT 200`, [q.u.id])).rows)));

app.get('/api/notifications', auth(), h(async (q, s) => s.json((await pool.query(`SELECT body,to_char(created_at,'DD/MM/YYYY') date FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [q.u.id])).rows)));

app.get('/api/referrals', auth(), h(async (q, s) => s.json((await pool.query(`SELECT name,to_char(created_at,'DD/MM/YYYY') date FROM users WHERE referred_by=$1 ORDER BY id DESC LIMIT 100`, [q.u.id])).rows)));

// ---------- Administration ----------
const adm = auth('admin');
app.get('/api/admin/stats', adm, h(async (q, s) => s.json((await pool.query(
  `SELECT (SELECT count(*)::int FROM users WHERE role='member') members,(SELECT count(*)::int FROM tontines) tontines,
          (SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM payments WHERE status='Terminée') confirmed,
          (SELECT COALESCE(sum(amount),0)::float8 FROM payments WHERE status='Terminée') total`)).rows[0])));

app.get('/api/admin/members', adm, h(async (q, s) => s.json((await pool.query(`SELECT id,name,phone,email,status FROM users WHERE role='member' ORDER BY id DESC LIMIT 500`)).rows)));
app.get('/api/admin/tontines', adm, h(async (q, s) => s.json((await pool.query(`SELECT t.id,t.name,t.amount,t.status,(SELECT count(*)::int FROM memberships m WHERE m.tontine_id=t.id) members FROM tontines t ORDER BY t.id DESC LIMIT 500`)).rows)));
app.get('/api/admin/payments', adm, h(async (q, s) => s.json((await pool.query(
  `SELECT p.id,u.name who,t.name tontine,p.amount,p.method,p.reference,p.status,to_char(p.created_at,'DD/MM/YYYY') date FROM payments p JOIN users u ON u.id=p.user_id JOIN tontines t ON t.id=p.tontine_id ORDER BY p.id DESC LIMIT 500`)).rows)));
app.get('/api/admin/reports', adm, h(async (q, s) => s.json((await pool.query(
  `SELECT t.name,COALESCE(sum(p.amount) FILTER (WHERE p.status='Terminée'),0)::float8 total FROM tontines t LEFT JOIN payments p ON p.tontine_id=t.id GROUP BY t.id ORDER BY total DESC`)).rows)));

app.patch('/api/admin/payments/:id', adm, h(async (q, s) => {
  const st = q.body && q.body.status;
  if (!['Terminée', 'Rejetée'].includes(st) || !Number.isInteger(Number(q.params.id))) return bad(s, 'Requête invalide.');
  const p = (await pool.query(`UPDATE payments SET status=$1,confirmed_by=$2 WHERE id=$3 AND status='En cours' RETURNING user_id,amount`, [st, q.u.id, Number(q.params.id)])).rows[0];
  if (!p) return bad(s, 'Ce paiement a déjà été traité.', 409);
  await note(p.user_id, 'Votre paiement de ' + p.amount.toLocaleString('fr-FR') + ' FCFA a été ' + (st === 'Terminée' ? 'confirmé.' : 'rejeté. Vérifiez la référence et déclarez-le à nouveau.'));
  s.json({ ok: true });
}));

app.patch('/api/admin/members/:id', adm, h(async (q, s) => {
  const st = q.body && q.body.status;
  if (!['Actif', 'Inactif'].includes(st)) return bad(s, 'Requête invalide.');
  await pool.query(`UPDATE users SET status=$1 WHERE id=$2 AND role='member'`, [st, Number(q.params.id)]);
  s.json({ ok: true });
}));

app.patch('/api/admin/tontines/:id', adm, h(async (q, s) => {
  const st = q.body && q.body.status;
  if (!['En cours', 'Terminée'].includes(st)) return bad(s, 'Requête invalide.');
  await pool.query('UPDATE tontines SET status=$1 WHERE id=$2', [st, Number(q.params.id)]);
  s.json({ ok: true });
}));

// ---------- Pages ----------
app.get('/health', (q, s) => s.send('ok'));
app.use('/api', (q, s) => bad(s, 'Introuvable.', 404));
const send = f => (q, s) => s.sendFile(path.join(__dirname, f));
app.get(['/member', '/member/'], send('member.html'));
app.get(['/admin', '/admin/'], send('admin.html'));
app.get('/assets/style.css', send('style.css'));
app.get('/assets/app.js', send('app.js'));
app.get('/', (q, s) => s.send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tontine Digital 1.0</title><body style="font-family:system-ui;text-align:center;padding:40px"><h1>🌿 Tontine Digital 1.0</h1><p>Choisissez votre espace.</p><p><a href="/member/">Application Membre</a> · <a href="/admin/">Administration</a></p>'));

(async () => {
  if (SCHEMA !== 'public') { const boot = new Pool({ connectionString: DATABASE_URL, ssl }); await boot.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA); await boot.end(); }
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (ADMIN_EMAIL && ADMIN_PASSWORD && ADMIN_PASSWORD.length >= 8) {
    const e = ADMIN_EMAIL.trim().toLowerCase();
    if (!(await pool.query('SELECT 1 FROM users WHERE email=$1', [e])).rowCount)
      await pool.query(`INSERT INTO users(name,email,password_hash,role,referral_code) VALUES('Administrateur',$1,$2,'admin','TD-ADMIN')`, [e, await bcrypt.hash(ADMIN_PASSWORD, 11)]);
  }
  app.listen(PORT, () => console.log('Tontine Digital démarré sur le port ' + PORT));
})().catch(e => { console.error(e); process.exit(1); });
