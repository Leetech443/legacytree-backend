-- LegacyTree RSVP schema (PostgreSQL / Neon). Safe to re-run; also upgrades older databases.
DO $$ BEGIN CREATE TYPE generation_t AS ENUM ('PARENT','CHILD','GRANDCHILD','GREAT_GRANDCHILD'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE rsvp_status_t AS ENUM ('YES','NO','MAYBE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE followup_status_t AS ENUM ('PENDING','DONE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS decline_reasons (code TEXT PRIMARY KEY, label TEXT NOT NULL, sort_order INT NOT NULL DEFAULT 0);
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

-- Contact details
CREATE TABLE IF NOT EXISTS member_contacts (
  member_id      BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  email          TEXT,
  phone          TEXT,
  age            INT CHECK (age BETWEEN 0 AND 120),
  guardian_name  TEXT,
  guardian_phone TEXT
);

-- Personal profile: occupation, marital status, spouse (children & grandchildren)
CREATE TABLE IF NOT EXISTS member_profiles (
  member_id      BIGINT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  occupation     TEXT,
  marital_status TEXT CHECK (marital_status IN ('Single','Married','Divorced','Widowed')),
  spouse_name    TEXT,
  CHECK (marital_status = 'Married' OR spouse_name IS NULL)
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

-- Exists only when status = YES. friends_count = FAMILY FRIENDS (not relatives) coming along.
CREATE TABLE IF NOT EXISTS rsvp_attendance (
  rsvp_id       BIGINT PRIMARY KEY REFERENCES rsvps(id) ON DELETE CASCADE,
  friends_count INT NOT NULL DEFAULT 0 CHECK (friends_count BETWEEN 0 AND 50),
  arrival_date  DATE NOT NULL
);

-- Upgrade older databases WITHOUT losing data:
--  * companions_count is renamed friends_count
--  * the removed fields keep their old data but become optional (see README for the optional cleanup SQL)
ALTER TABLE rsvp_attendance DROP COLUMN IF EXISTS dietary_notes, DROP COLUMN IF EXISTS special_assistance;
DO $$
DECLARE c TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rsvp_attendance' AND column_name='companions_count') THEN
    ALTER TABLE rsvp_attendance RENAME COLUMN companions_count TO friends_count;
  END IF;
  FOREACH c IN ARRAY ARRAY['arrival_time','departure_date','travel_method','needs_accommodation'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rsvp_attendance' AND column_name=c) THEN
      EXECUTE format('ALTER TABLE rsvp_attendance ALTER COLUMN %I DROP NOT NULL', c);
    END IF;
  END LOOP;
END $$;

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
