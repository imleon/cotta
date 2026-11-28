-- Accounts are keyed by our own id; the GitHub numeric id is the stable login identity (logins can be renamed).
-- The login is kept only for display. No email is read or stored.
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_login_at_ms INTEGER NOT NULL
);

-- Browser sessions; only a SHA-256 of the cookie token is stored.
CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX account_sessions_by_expiry ON account_sessions(expires_at_ms);

-- GitHub device-flow logins in progress. The device code never leaves the cloud.
CREATE TABLE login_flows (
  flow_id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  interval_ms INTEGER NOT NULL,
  next_poll_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

-- One machine per key; a key bound to an account cannot be registered again without resetting the machine identity.
CREATE TABLE machines (
  machine_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'linux')),
  version TEXT,
  registered_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER
);
CREATE INDEX machines_by_account ON machines(account_id);

-- Device-code registrations: the daemon starts one, the user approves its code in a signed-in browser.
CREATE TABLE machine_registrations (
  registration_id TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'linux')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  machine_id TEXT
);
CREATE INDEX machine_registrations_by_expiry ON machine_registrations(expires_at_ms);
