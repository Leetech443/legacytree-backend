-- LegacyTree RSVP schema (PostgreSQL / Neon). Safe to re-run.
DO $$ BEGIN CREATE TYPE generation_t AS ENUM ('PARENT','CHILD','GRANDCHILD','GREAT_GRANDCHILD'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE rsvp_status_t AS ENUM ('YES','NO','MAYBE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE followup_status_t AS ENUM ('PENDING','DONE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lookup tables (editable without code changes)
CREATE TABLE IF NOT EXISTS travel_methods (code TEXT PRIMARY KEY, label TEXT NOT NULL, sort_order INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS decline_reasons (code TEXT PRIMARY KEY, label TEXT NOT NULL, sort_order INT NOT NULL DEFAULT 0);
INSERT INTO travel_methods (code,label,sort_order) VALUES
 ('CAR','Own car',1),('BUS','Bus / coach',2),('TAXI','Taxi / ride-hailing',3),('PLANE','Flight',4),('TRAIN','Train',5),('OTHER','Other',9)
 ON CONFLICT DO NOTHING;
INSERT INTO decline_reasons (code,label,sort_order) VALUES
 ('WORK','Work commitments',1),('HEALTH','Health reasons',2),('TRAVEL','Travel / distance / cost',3),
 ('FAMILY','Another family commitment',4),('SCHOOL','School / exams',5),('OTHER','Other (please explain)',9)
 ON CONFLICT DO NOTHING;

-- People (family tree only)
CREATE TABLE IF NOT EXISTS members (
  id            BIGSERIAL PRIMARY KEY,
  full_name     TEXT NOT NULL CHECK (length(full_name) BETWEEN 2 AND 200),
  generation    generation_t NOT NULL,
  gender        TEXT NOT NULL CHECK (gender IN ('Male','Female')),
  parent_id     BIGINT REFERENCES members(id) ON DELETE RESTRICT,
  lineage_side  TEXT CHECK (lineage_side IN ('Maternal','Paternal')),
  has_children  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((generation = 'PARENT') = (parent_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_members_parent ON members(parent_id);
CREATE INDEX IF NOT EXISTS idx_members_gen ON members(generation);
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_name_parent ON members (lower(full_name), COALESCE(parent_id,0));

-- Contact details kept apart from the tree
CREATE TABLE IF NOT EXISTS member_contacts (
  member_id      BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  email          TEXT,
  phone          TEXT,
  age            INT CHECK (age BETWEEN 0 AND 120),
  school         TEXT,
  guardian_name  TEXT,
  guardian_phone TEXT
);

-- One RSVP per member
CREATE TABLE IF NOT EXISTS rsvps (
  id           BIGSERIAL PRIMARY KEY,
  member_id    BIGINT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  status       rsvp_status_t NOT NULL,
  manage_token UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rsvps_status ON rsvps(status);

-- Exists only when status = YES
CREATE TABLE IF NOT EXISTS rsvp_attendance (
  rsvp_id             BIGINT PRIMARY KEY REFERENCES rsvps(id) ON DELETE CASCADE,
  companions_count    INT NOT NULL DEFAULT 0 CHECK (companions_count BETWEEN 0 AND 50),
  arrival_date        DATE NOT NULL,
  arrival_time        TIME NOT NULL,
  departure_date      DATE NOT NULL,
  travel_method       TEXT NOT NULL REFERENCES travel_methods(code),
  needs_accommodation BOOLEAN NOT NULL,
  additional_info     TEXT,
  CHECK (departure_date >= arrival_date)
);

-- Migration for databases created before these fields were removed
ALTER TABLE rsvp_attendance DROP COLUMN IF EXISTS dietary_notes, DROP COLUMN IF EXISTS special_assistance;

-- Exists only when status = MAYBE: "ask me again on <date>"
CREATE TABLE IF NOT EXISTS rsvp_followups (
  id        BIGSERIAL PRIMARY KEY,
  rsvp_id   BIGINT NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  remind_on DATE NOT NULL,
  status    followup_status_t NOT NULL DEFAULT 'PENDING',
  done_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON rsvp_followups(remind_on) WHERE status = 'PENDING';

-- Exists only when status = NO
CREATE TABLE IF NOT EXISTS rsvp_declines (
  rsvp_id     BIGINT PRIMARY KEY REFERENCES rsvps(id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL REFERENCES decline_reasons(code),
  reason_text TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
