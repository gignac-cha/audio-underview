CREATE TABLE IF NOT EXISTS provider_keys (
  user_id      TEXT    NOT NULL,
  provider     TEXT    NOT NULL,
  ciphertext   TEXT    NOT NULL,
  iv           TEXT    NOT NULL,
  wrapped_dek  TEXT    NOT NULL,
  dek_iv       TEXT    NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  last4        TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  validated_at TEXT,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS key_audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL,
  provider TEXT NOT NULL,
  action   TEXT NOT NULL,
  at       TEXT NOT NULL,
  ip_hash  TEXT,
  ua_hash  TEXT
);

CREATE INDEX IF NOT EXISTS key_audit_log_user_id_id
  ON key_audit_log (user_id, id DESC);
