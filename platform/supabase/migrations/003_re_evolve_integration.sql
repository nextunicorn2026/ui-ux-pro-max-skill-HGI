-- ============================================================
-- HGI Platform — Re-Evolve Integration Layer
-- Migration 003: Connect Re-Evolve agent services to HGI platform
-- ============================================================

CREATE TABLE hgi_re_evolve_workspaces (
  workspace_id   text PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES hgi_organizations(id) ON DELETE CASCADE,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hgi_agent_heartbeats (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES hgi_agent_registry(id),
  status         hgi_agent_status NOT NULL,
  response_ms    integer,
  error          text,
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hgi_heartbeats_agent ON hgi_agent_heartbeats(agent_id, checked_at DESC);

CREATE TABLE hgi_kavacha_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid REFERENCES hgi_agent_registry(id),
  user_id        uuid REFERENCES hgi_users(id),
  payload_hash   text NOT NULL,
  allowed        boolean NOT NULL,
  reason         text,
  rules_applied  text[] DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_kavacha_decisions_agent ON hgi_kavacha_decisions(agent_id, created_at DESC);
CREATE INDEX idx_kavacha_decisions_blocked ON hgi_kavacha_decisions(allowed, created_at DESC)
  WHERE allowed = false;

CREATE OR REPLACE FUNCTION hgi_sync_re_evolve_user(
  p_user_id      uuid,
  p_email        text,
  p_display_name text,
  p_workspace_id text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_org_id uuid;
BEGIN
  INSERT INTO hgi_users (id, email, display_name, products)
  VALUES (p_user_id, p_email, p_display_name, ARRAY['re-evolve'::hgi_product])
  ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    products = array_append(
      array_remove(hgi_users.products, 're-evolve'::hgi_product),
      're-evolve'::hgi_product
    ),
    updated_at = now();

  IF p_workspace_id IS NOT NULL THEN
    SELECT org_id INTO v_org_id
    FROM hgi_re_evolve_workspaces
    WHERE workspace_id = p_workspace_id;

    IF v_org_id IS NULL THEN
      INSERT INTO hgi_organizations (name, slug)
      VALUES ('Re-Evolve Workspace ' || p_workspace_id, 're-evolve-ws-' || p_workspace_id)
      RETURNING id INTO v_org_id;

      INSERT INTO hgi_re_evolve_workspaces (workspace_id, org_id)
      VALUES (p_workspace_id, v_org_id);
    END IF;

    UPDATE hgi_users SET org_id = v_org_id WHERE id = p_user_id;

    INSERT INTO hgi_permissions (user_id, org_id, product, role)
    VALUES (p_user_id, v_org_id, 're-evolve'::hgi_product, 'member'::hgi_role)
    ON CONFLICT (user_id, org_id, product, role) DO NOTHING;
  END IF;

  IF v_org_id IS NOT NULL THEN
    INSERT INTO hgi_subscriptions (org_id, product, plan, status)
    VALUES (v_org_id, 're-evolve'::hgi_product, 'free'::hgi_plan, 'active'::hgi_sub_status)
    ON CONFLICT (org_id, product) DO NOTHING;
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION hgi_record_agent_heartbeat(
  p_agent_name   text,
  p_status       hgi_agent_status,
  p_response_ms  integer DEFAULT NULL,
  p_error        text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_agent_id uuid;
BEGIN
  SELECT id INTO v_agent_id FROM hgi_agent_registry WHERE name = p_agent_name;
  IF v_agent_id IS NULL THEN RETURN; END IF;

  INSERT INTO hgi_agent_heartbeats (agent_id, status, response_ms, error)
  VALUES (v_agent_id, p_status, p_response_ms, p_error);

  UPDATE hgi_agent_registry
  SET status = p_status, last_heartbeat = now(), updated_at = now()
  WHERE id = v_agent_id;
END; $$;

INSERT INTO hgi_subscriptions (org_id, product, plan, status)
SELECT
  o.id,
  're-evolve'::hgi_product,
  'free'::hgi_plan,
  'trialing'::hgi_sub_status
FROM hgi_organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM hgi_subscriptions s
  WHERE s.org_id = o.id AND s.product = 're-evolve'
)
ON CONFLICT (org_id, product) DO NOTHING;
