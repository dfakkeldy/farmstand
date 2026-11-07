-- Farmstand schema. Money is integer cents; times are epoch milliseconds (UTC).

CREATE TABLE sellers (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- One secret link per phone or helper. Only the SHA-256 of the token is stored.
CREATE TABLE seller_links (
  id         INTEGER PRIMARY KEY,
  seller_id  INTEGER NOT NULL REFERENCES sellers(id),
  token_hash TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL DEFAULT '',
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE stands (
  id              INTEGER PRIMARY KEY,
  seller_id       INTEGER NOT NULL REFERENCES sellers(id),
  slug            TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  mode            TEXT    NOT NULL CHECK (mode IN ('staffed', 'unattended')),
  pickup_info     TEXT    NOT NULL DEFAULT '',
  message         TEXT    NOT NULL DEFAULT '',
  max_per_item    INTEGER NOT NULL DEFAULT 6 CHECK (max_per_item >= 1),
  turnstile_on    INTEGER NOT NULL DEFAULT 0,
  paused          INTEGER NOT NULL DEFAULT 0,
  last_counted_at INTEGER,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);
CREATE INDEX stands_seller ON stands (seller_id);

-- stock = all units at the stand (shelf + baskets). held = units reserved by open orders.
-- The CHECK is the last line of defence against selling the same unit twice.
CREATE TABLE items (
  id                INTEGER PRIMARY KEY,
  stand_id          INTEGER NOT NULL REFERENCES stands(id),
  name              TEXT    NOT NULL,
  unit_label        TEXT    NOT NULL DEFAULT '',
  price_cents       INTEGER NOT NULL CHECK (price_cents >= 0),
  stock             INTEGER NOT NULL DEFAULT 0,
  held              INTEGER NOT NULL DEFAULT 0,
  short_since_visit INTEGER NOT NULL DEFAULT 0 CHECK (short_since_visit >= 0),
  sold_out          INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  sort              INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (stock >= 0 AND held >= 0 AND held <= stock)
);
CREATE INDEX items_stand ON items (stand_id, active, sort);

CREATE TABLE orders (
  id                  INTEGER PRIMARY KEY,
  stand_id            INTEGER NOT NULL REFERENCES stands(id),
  code                TEXT    NOT NULL,
  public_token        TEXT    NOT NULL UNIQUE,
  idem_key            TEXT    NOT NULL UNIQUE,
  customer_name       TEXT    NOT NULL,
  contact             TEXT,
  when_note           TEXT,
  status              TEXT    NOT NULL CHECK (status IN
                        ('placed', 'ready', 'picked_up', 'released', 'cancelled', 'not_found')),
  prev_status         TEXT,
  to_unpack           INTEGER NOT NULL DEFAULT 0,
  reopen_ok           INTEGER NOT NULL DEFAULT 0,
  total_cents         INTEGER NOT NULL,
  cash_cents          INTEGER NOT NULL,
  orig_total_cents    INTEGER NOT NULL,
  orig_cash_cents     INTEGER NOT NULL,
  reported_paid_cents INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  closed_at           INTEGER,
  closed_by           TEXT CHECK (closed_by IN ('seller', 'customer', 'visit')),
  scrubbed_at         INTEGER
);
CREATE INDEX orders_stand_status ON orders (stand_id, status, created_at);
CREATE INDEX orders_stand_closed ON orders (stand_id, closed_at);

-- Item name, unit and price are copied at order time, so later edits don't change old orders.
CREATE TABLE order_lines (
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  item_id     INTEGER NOT NULL REFERENCES items(id),
  item_name   TEXT    NOT NULL,
  unit_label  TEXT    NOT NULL,
  price_cents INTEGER NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  packed_qty  INTEGER CHECK (packed_qty IS NULL OR (packed_qty >= 0 AND packed_qty <= qty)),
  PRIMARY KEY (order_id, item_id)
);

CREATE TABLE visits (
  id                 INTEGER PRIMARY KEY,
  stand_id           INTEGER NOT NULL REFERENCES stands(id),
  visit_key          TEXT    NOT NULL UNIQUE,
  at                 INTEGER NOT NULL,
  walkin_cents       INTEGER NOT NULL,
  app_cash_cents     INTEGER NOT NULL,
  expected_cents     INTEGER NOT NULL,
  cash_counted_cents INTEGER,
  note               TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX visits_stand_at ON visits (stand_id, at);

CREATE TABLE visit_lines (
  visit_id          INTEGER NOT NULL REFERENCES visits(id),
  item_id           INTEGER NOT NULL REFERENCES items(id),
  item_name         TEXT    NOT NULL,
  price_cents       INTEGER NOT NULL,
  stock_before      INTEGER NOT NULL,
  in_baskets        INTEGER NOT NULL,
  counted           INTEGER,
  short_since_visit INTEGER NOT NULL,
  walk_in_sold      INTEGER NOT NULL,
  found_more        INTEGER NOT NULL,
  removed           INTEGER NOT NULL,
  restocked         INTEGER NOT NULL,
  PRIMARY KEY (visit_id, item_id)
);
