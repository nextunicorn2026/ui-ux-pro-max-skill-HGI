-- ============================================================
-- HGI Platform — Shared Database Schema
-- Migration 001: Core platform tables
-- Target: Supabase PostgreSQL (shared HGI project)
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- fuzzy search

-- ── Enums ───────────────────────────────────────────────────
CREATE TYPE hgi_product AS ENUM ('artoies', 're-evolve', 'imagin', 'kavacha', 'platform');
CREATE TYPE hgi_plan AS ENUM ('free', 'starter', 'pro', 'enterprise');
CREATE TYPE hgi_role AS ENUM ('owner', 'admin', 'member', 'viewer', 'agent');
CREATE TYPE hgi_sub_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'paused');
CREATE TYPE hgi_agent_status AS ENUM ('active', 'degraded', 'offline', 'maintenance');
CREATE TYPE hgi_notif_type AS ENUM ('info', 'success', 'warning', 'error', 'agent');

-- ============================================================
-- ORGANIZATIONS
-- Tenant entity. Artoies vendors map here. Re-Evolve workspaces map here.
-- ============================================================
CREATE TABLE hgi_organizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  slug           text UNIQUE NOT NULL,
  plan           hgi_plan NOT NULL DEFAULT 'free',
  logo_url       text,
  website        text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hgi_orgs_slug ON hgi_organizations(slug);

-- ============================================================
-- USERS (cross-product profiles)
-- Extends auth.users from Supabase Auth.
-- Products write to their own tables AND sync here.
-- ============================================================
CREATE TABLE hgi_users (
  id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email          text UNIQUE NOT NULL,
  display_name   text,
  avatar_url     text,
  phone          text,
  org_id         uuid REFERENCES hgi_organizations(id) ON DELETE SET NULL,
  products       hgi_product[] NOT NULL DEFAULT '{}',  -- which products user has access to
  last_seen_at   timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hgi_users_email ON hgi_users(email);
CREATE INDEX idx_hgi_users_org ON hgi_users(org_id);

-- ============================================================
-- PERMISSIONS (RBAC across products)
-- ============================================================
CREATE TABLE hgi_permissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES hgi_users(id) ON DELETE CASCADE,
  org_id         uuid REFERENCES hgi_organizations(id) ON DELETE CASCADE,
  product        hgi_product,       -- NULL = platform-wide permission
  role           hgi_role NOT NULL,
  granted_by     uuid REFERENCES hgi_users(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,       -- NULL = never expires
  UNIQUE (user_id, org_id, product, role)
);

CREATE INDEX idx_hgi_perms_user ON hgi_permissions(user_id);
CREATE INDEX idx_hgi_perms_org ON hgi_permissions(org_id);

-- ============================================================
-- SUBSCRIPTIONS (unified billing)
-- One subscription per org per product. Stripe/Razorpay backed.
-- ============================================================
CREATE TABLE hgi_subscriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES hgi_organizations(id) ON DELETE CASCADE,
  product                   hgi_product NOT NULL,
  plan                      hgi_plan NOT NULL DEFAULT 'free',
  status                    hgi_sub_status NOT NULL DEFAULT 'trialing',
  stripe_customer_id        text,
  stripe_subscription_id    text UNIQUE,
  razorpay_customer_id      text,
  razorpay_subscription_id  text,
  trial_ends_at             timestamptz,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  canceled_at               timestamptz,
  metadata                  jsonb NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, product)
);

CREATE INDEX idx_hgi_subs_org ON hgi_subscriptions(org_id);
CREATE INDEX idx_hgi_subs_stripe ON hgi_subscriptions(stripe_subscription_id);

-- ============================================================
-- AGENT REGISTRY (cross-product AI agent catalog)
-- Proton/Neutron/Electron (Re-Evolve) + ArtoMind (Artoies) registered here.
-- ============================================================
CREATE TABLE hgi_agent_registry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text UNIQUE NOT NULL,
  display_name   text NOT NULL,
  product        hgi_product NOT NULL,
  endpoint       text NOT NULL,        -- internal service URL
  api_path       text NOT NULL,        -- e.g. /execute, /evaluate
  capabilities   text[] NOT NULL DEFAULT '{}',
  model          text,                 -- underlying LLM model if AI agent
  status         hgi_agent_status NOT NULL DEFAULT 'active',
  last_heartbeat timestamptz,
  version        text NOT NULL DEFAULT '1.0.0',
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Seed initial agents
INSERT INTO hgi_agent_registry (name, display_name, product, endpoint, api_path, capabilities, model, metadata) VALUES
  ('artomind', 'ArtoMind', 'artoies', 'https://hgi-platform.supabase.co/functions/v1', '/hgi-agents/artomind', ARRAY['diagnose', 'recommend', 'spare-parts', 'multilingual'], 'google/gemini-3-flash-preview', '{"language_support": ["en","hi","kn","ta","te","ml","mr","bn"]}'),
  ('proton', 'Sruta-Netra (Proton)', 're-evolve', 'http://agent-proton:3001', '/execute', ARRAY['execute', 'process'], NULL, '{"kavacha": true, "role": "execution"}'),
  ('neutron', 'Sanka-Nasaka (Neutron)', 're-evolve', 'http://agent-neutron:3002', '/evaluate', ARRAY['evaluate', 'risk-assess'], NULL, '{"kavacha": true, "role": "evaluation"}'),
  ('electron', 'Rahasya-Drashta (Electron)', 're-evolve', 'http://agent-electron:3003', '/observe', ARRAY['observe', 'monitor'], NULL, '{"kavacha": true, "role": "observation"}');

-- ============================================================
-- AGENT CALLS (telemetry + billing meter)
-- Every agent invocation is logged here for observability and metered billing.
-- ============================================================
CREATE TABLE hgi_agent_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES hgi_agent_registry(id),
  user_id        uuid REFERENCES hgi_users(id),
  org_id         uuid REFERENCES hgi_organizations(id),
  session_id     text,
  input_hash     text,               -- SHA256 of input for dedup (never store PII)
  status         text NOT NULL DEFAULT 'pending',  -- pending|success|error|blocked
  blocked_reason text,               -- if Kavacha blocked
  tokens_in      integer,
  tokens_out     integer,
  duration_ms    integer,
  error_code     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hgi_calls_agent ON hgi_agent_calls(agent_id, created_at DESC);
CREATE INDEX idx_hgi_calls_user ON hgi_agent_calls(user_id, created_at DESC);
CREATE INDEX idx_hgi_calls_org ON hgi_agent_calls(org_id, created_at DESC);

-- ============================================================
-- ANALYTICS EVENTS (unified product analytics)
-- All products write here with a shared schema.
-- Queryable across products for cross-product funnels.
-- ============================================================
CREATE TABLE hgi_analytics_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES hgi_users(id),
  org_id         uuid REFERENCES hgi_organizations(id),
  product        hgi_product NOT NULL,
  event_name     text NOT NULL,
  session_id     text,
  properties     jsonb NOT NULL DEFAULT '{}',
  device         text,
  platform       text,               -- 'web' | 'ios' | 'android'
  ip_hash        text,               -- hashed for privacy
  created_at     timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Monthly partitions for analytics (2026)
CREATE TABLE hgi_analytics_events_2026_06 PARTITION OF hgi_analytics_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE hgi_analytics_events_2026_07 PARTITION OF hgi_analytics_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE hgi_analytics_events_2026_08 PARTITION OF hgi_analytics_events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE hgi_analytics_events_2026_09 PARTITION OF hgi_analytics_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE hgi_analytics_events_2026_10 PARTITION OF hgi_analytics_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE hgi_analytics_events_2026_11 PARTITION OF hgi_analytics_events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE hgi_analytics_events_2026_12 PARTITION OF hgi_analytics_events
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE INDEX idx_hgi_analytics_product ON hgi_analytics_events(product, event_name, created_at DESC);
CREATE INDEX idx_hgi_analytics_user ON hgi_analytics_events(user_id, created_at DESC);

-- ============================================================
-- NOTIFICATIONS (cross-product notification center)
-- ============================================================
CREATE TABLE hgi_notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES hgi_users(id) ON DELETE CASCADE,
  product        hgi_product NOT NULL,
  type           hgi_notif_type NOT NULL DEFAULT 'info',
  title          text NOT NULL,
  body           text,
  action_url     text,
  read_at        timestamptz,
  dismissed_at   timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hgi_notifs_user ON hgi_notifications(user_id, read_at, created_at DESC);

-- ============================================================
-- SSO TOKENS (cross-product session delegation)
-- ============================================================
CREATE TABLE hgi_sso_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES hgi_users(id) ON DELETE CASCADE,
  source_product  hgi_product NOT NULL,
  target_product  hgi_product NOT NULL,
  token           text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  scopes          text[] NOT NULL DEFAULT '{}',
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  used_at         timestamptz,
  ip_hash         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hgi_sso_token ON hgi_sso_tokens(token) WHERE used_at IS NULL;
CREATE INDEX idx_hgi_sso_user ON hgi_sso_tokens(user_id, created_at DESC);

-- ============================================================
-- AUDIT LOG (immutable governance trail)
-- ============================================================
CREATE TABLE hgi_audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id       uuid REFERENCES hgi_users(id),
  actor_type     text NOT NULL DEFAULT 'user',
  product        hgi_product,
  action         text NOT NULL,
  resource_type  text,
  resource_id    text,
  outcome        text NOT NULL DEFAULT 'success',
  ip_hash        text,
  details        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hgi_audit_actor ON hgi_audit_log(actor_id, created_at DESC);
CREATE INDEX idx_hgi_audit_product ON hgi_audit_log(product, action, created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE hgi_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hgi_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE hgi_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hgi_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hgi_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE hgi_sso_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hgi_users_self_read" ON hgi_users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "hgi_users_self_update" ON hgi_users
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "hgi_orgs_member_read" ON hgi_organizations
  FOR SELECT USING (
    id IN (SELECT org_id FROM hgi_users WHERE id = auth.uid())
  );

CREATE POLICY "hgi_perms_self_read" ON hgi_permissions
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "hgi_notifs_private" ON hgi_notifications
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "hgi_sso_private" ON hgi_sso_tokens
  FOR SELECT USING (user_id = auth.uid());

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION hgi_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_hgi_orgs_updated_at
  BEFORE UPDATE ON hgi_organizations
  FOR EACH ROW EXECUTE FUNCTION hgi_set_updated_at();

CREATE TRIGGER trg_hgi_users_updated_at
  BEFORE UPDATE ON hgi_users
  FOR EACH ROW EXECUTE FUNCTION hgi_set_updated_at();

CREATE OR REPLACE FUNCTION hgi_handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO hgi_users (id, email, display_name, products)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    '{}'::hgi_product[]
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;

CREATE TRIGGER on_hgi_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION hgi_handle_new_user();

CREATE OR REPLACE FUNCTION hgi_issue_sso_token(
  p_user_id      uuid,
  p_source       hgi_product,
  p_target       hgi_product,
  p_scopes       text[]
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_token text;
BEGIN
  UPDATE hgi_sso_tokens
  SET expires_at = now()
  WHERE user_id = p_user_id
    AND source_product = p_source
    AND target_product = p_target
    AND used_at IS NULL
    AND expires_at > now();

  INSERT INTO hgi_sso_tokens (user_id, source_product, target_product, scopes)
  VALUES (p_user_id, p_source, p_target, p_scopes)
  RETURNING token INTO v_token;

  RETURN v_token;
END; $$;

CREATE OR REPLACE FUNCTION hgi_redeem_sso_token(p_token text)
RETURNS TABLE(user_id uuid, target_product hgi_product, scopes text[])
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  UPDATE hgi_sso_tokens
  SET used_at = now()
  WHERE token = p_token
    AND used_at IS NULL
    AND expires_at > now()
  RETURNING hgi_sso_tokens.user_id, hgi_sso_tokens.target_product, hgi_sso_tokens.scopes;
END; $$;

CREATE MATERIALIZED VIEW hgi_org_plan_summary AS
SELECT
  o.id AS org_id,
  o.name AS org_name,
  o.plan AS org_plan,
  array_agg(DISTINCT s.product) AS subscribed_products,
  array_agg(DISTINCT s.status) AS subscription_statuses,
  count(DISTINCT u.id) AS member_count
FROM hgi_organizations o
LEFT JOIN hgi_subscriptions s ON s.org_id = o.id
LEFT JOIN hgi_users u ON u.org_id = o.id
GROUP BY o.id, o.name, o.plan;

CREATE UNIQUE INDEX ON hgi_org_plan_summary(org_id);
