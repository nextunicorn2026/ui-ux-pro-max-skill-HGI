// HGI Platform — Auth & SSO Edge Function

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hgi-product",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace("/hgi-auth", "");

  try {
    switch (path) {
      case "/sso/issue": return handleIssueSso(req);
      case "/sso/redeem": return handleRedeemSso(req);
      case "/sync/artoies": return handleArtoiesSync(req);
      case "/sync/re-evolve": return handleReEvolveSync(req);
      case "/user": return handleGetUser(req);
      default:
        return json({ error: "Unknown path" }, 404);
    }
  } catch (err) {
    console.error("[hgi-auth] Error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});

async function handleIssueSso(req: Request): Promise<Response> {
  const user = await requireAuth(req);
  const { target_product, scopes = [] } = await req.json();

  if (!target_product) return json({ error: "target_product required" }, 400);

  const source_product = req.headers.get("x-hgi-product") || "platform";

  const { data: token, error } = await supabase.rpc("hgi_issue_sso_token", {
    p_user_id: user.id,
    p_source: source_product,
    p_target: target_product,
    p_scopes: scopes,
  });
  if (error) throw error;

  await auditLog(user.id, source_product, "sso.issue", "sso_token", null, { target: target_product });

  return json({ token, expires_in: 600 });
}

async function handleRedeemSso(req: Request): Promise<Response> {
  const { token } = await req.json();
  if (!token) return json({ error: "token required" }, 400);

  const { data, error } = await supabase.rpc("hgi_redeem_sso_token", { p_token: token });
  if (error || !data || data.length === 0) {
    return json({ error: "Invalid or expired SSO token" }, 401);
  }

  const { user_id, target_product, scopes } = data[0];

  const { data: profile } = await supabase
    .from("hgi_users")
    .select("*")
    .eq("id", user_id)
    .single();

  await auditLog(user_id, target_product, "sso.redeem", "sso_token", null, { scopes });

  return json({ user_id, target_product, scopes, profile });
}

async function handleArtoiesSync(req: Request): Promise<Response> {
  await requireServiceKey(req);
  const { user_id, email, display_name, role, vendor_id } = await req.json();

  const { error } = await supabase.rpc("hgi_sync_artoies_user", {
    p_user_id: user_id,
    p_email: email,
    p_display_name: display_name,
    p_role: role,
    p_vendor_id: vendor_id || null,
  });
  if (error) throw error;

  return json({ synced: true });
}

async function handleReEvolveSync(req: Request): Promise<Response> {
  await requireServiceKey(req);
  const { user_id, email, display_name, workspace_id } = await req.json();

  const { error } = await supabase.rpc("hgi_sync_re_evolve_user", {
    p_user_id: user_id,
    p_email: email,
    p_display_name: display_name,
    p_workspace_id: workspace_id || null,
  });
  if (error) throw error;

  return json({ synced: true });
}

async function handleGetUser(req: Request): Promise<Response> {
  const user = await requireAuth(req);

  const { data: profile, error } = await supabase
    .from("hgi_users")
    .select(`*, hgi_organizations (*), hgi_permissions (*), hgi_subscriptions (*)`)
    .eq("id", user.id)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  return json({ user: profile });
}

async function requireAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Unauthorized");
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user) throw new Error("Invalid token");
  return user;
}

async function requireServiceKey(req: Request) {
  const key = req.headers.get("x-hgi-service-key");
  const expected = Deno.env.get("HGI_SERVICE_KEY");
  if (!expected || key !== expected) throw new Error("Forbidden: invalid service key");
}

async function auditLog(actorId: string, product: string, action: string, resourceType: string | null, resourceId: string | null, details: Record<string, unknown>) {
  await supabase.from("hgi_audit_log").insert({
    actor_id: actorId, product, action, resource_type: resourceType, resource_id: resourceId, details,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
