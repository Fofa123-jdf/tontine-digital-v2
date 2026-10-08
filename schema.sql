-- Schéma dédié : n'interfère pas avec d'éventuelles anciennes tables de la base
CREATE SCHEMA IF NOT EXISTS td;
SET search_path TO td;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  birth_date DATE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  email TEXT,
  doc_type TEXT,
  doc_number TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','refused','suspended')),
  ref_code TEXT UNIQUE NOT NULL,
  referrer_id INT REFERENCES users(id),
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','reset')),
  code_hash TEXT NOT NULL,
  payload JSONB,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_phone_idx ON otp_codes(phone, created_at);
CREATE TABLE IF NOT EXISTS tontines (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount >= 500),
  frequency TEXT NOT NULL CHECK (frequency IN ('semaine','mois')),
  max_members INT NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','running','closed')),
  current_round INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tontine_members (
  tontine_id INT NOT NULL REFERENCES tontines(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tontine_id, user_id)
);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  tontine_id INT NOT NULL REFERENCES tontines(id),
  amount INT NOT NULL,
  fee INT NOT NULL DEFAULT 0,
  method TEXT NOT NULL CHECK (method IN ('wave','orange','mtn')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  provider_ref TEXT,
  checkout_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id, status);
CREATE TABLE IF NOT EXISTS referral_commissions (
  id SERIAL PRIMARY KEY,
  referrer_id INT NOT NULL REFERENCES users(id),
  referred_id INT NOT NULL REFERENCES users(id),
  payment_id INT UNIQUE NOT NULL REFERENCES payments(id),
  amount INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  tontine_id INT NOT NULL REFERENCES tontines(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings(key,value) VALUES
  ('commission_mode','first'),('platform_rate','0.01'),('referral_rate','0.02')
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  admin_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_token TEXT;
CREATE TABLE IF NOT EXISTS user_documents (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
