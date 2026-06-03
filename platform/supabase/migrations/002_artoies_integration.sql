-- ============================================================
-- HGI Platform — Artoies Integration Layer
-- Migration 002: Bridge Artoies data model to HGI platform
-- Run in the HGI Platform Supabase project AFTER 001
-- ============================================================

CREATE TABLE hgi_artoies_vendor_orgs (
  vendor_id      uuid NOT NULL,
  org_id         uuid NOT NULL REFERENCES hgi_organizations(id) ON DELETE CASCADE,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id)
);

INSERT INTO hgi_subscriptions (org_id, product, plan, status)
SELECT
  o.id,
  'artoies'::hgi_product,
  'free'::hgi_plan,
  'active'::hgi_sub_status
FROM hgi_organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM hgi_subscriptions s
  WHERE s.org_id = o.id AND s.product = 'artoies'
)
ON CONFLICT (org_id, product) DO NOTHING;

CREATE OR REPLACE VIEW hgi_artoies_role_map AS
SELECT
  'customer'  AS artoies_role, 'viewer'::hgi_role AS hgi_role UNION ALL
SELECT 'vendor',  'member'::hgi_role UNION ALL
SELECT 'admin',   'admin'::hgi_role UNION ALL
SELECT 'founder', 'owner'::hgi_role;

CREATE OR REPLACE FUNCTION hgi_sync_artoies_user(
  p_user_id      uuid,
  p_email        text,
  p_display_name text,
  p_role         text,
  p_vendor_id    uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_hgi_role hgi_role;
  v_org_id   uuid;
BEGIN
  SELECT hgi_role INTO v_hgi_role
  FROM hgi_artoies_role_map
  WHERE artoies_role = p_role;

  INSERT INTO hgi_users (id, email, display_name, products)
  VALUES (p_user_id, p_email, p_display_name, ARRAY['artoies'::hgi_product])
  ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    products = array_append(
      array_remove(hgi_users.products, 'artoies'::hgi_product),
      'artoies'::hgi_product
    ),
    updated_at = now();

  IF p_vendor_id IS NOT NULL THEN
    SELECT org_id INTO v_org_id
    FROM hgi_artoies_vendor_orgs
    WHERE vendor_id = p_vendor_id;

    IF v_org_id IS NULL THEN
      INSERT INTO hgi_organizations (name, slug, plan)
      VALUES (
        p_display_name || ' (Vendor)',
        'artoies-vendor-' || replace(p_vendor_id::text, '-', ''),
        'free'
      )
      RETURNING id INTO v_org_id;

      INSERT INTO hgi_artoies_vendor_orgs (vendor_id, org_id)
      VALUES (p_vendor_id, v_org_id);
    END IF;

    UPDATE hgi_users SET org_id = v_org_id WHERE id = p_user_id;
  END IF;

  IF v_hgi_role IS NOT NULL THEN
    INSERT INTO hgi_permissions (user_id, org_id, product, role)
    VALUES (p_user_id, v_org_id, 'artoies'::hgi_product, v_hgi_role)
    ON CONFLICT (user_id, org_id, product, role) DO NOTHING;
  END IF;

  INSERT INTO hgi_audit_log (actor_id, product, action, resource_type, resource_id, details)
  VALUES (p_user_id, 'artoies', 'user.sync', 'user', p_user_id::text,
    jsonb_build_object('role', p_role, 'vendor_id', p_vendor_id));
END; $$;
