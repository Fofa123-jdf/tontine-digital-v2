CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'Actif',
  referral_code TEXT UNIQUE NOT NULL,
  referred_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tontines(
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount >= 1000),
  max_members INT NOT NULL DEFAULT 10,
  next_date DATE,
  status TEXT NOT NULL DEFAULT 'En cours',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships(
  tontine_id INT REFERENCES tontines(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tontine_id, user_id)
);
CREATE TABLE IF NOT EXISTS payments(
  id SERIAL PRIMARY KEY,
  tontine_id INT NOT NULL REFERENCES tontines(id),
  user_id INT NOT NULL REFERENCES users(id),
  amount INT NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'En cours',
  confirmed_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (method, reference)
);
CREATE TABLE IF NOT EXISTS messages(
  id SERIAL PRIMARY KEY,
  tontine_id INT NOT NULL REFERENCES tontines(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications(
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_tontine ON messages(tontine_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
