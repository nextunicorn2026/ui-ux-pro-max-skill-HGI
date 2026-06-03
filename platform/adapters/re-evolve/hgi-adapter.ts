// HGI Integration Adapter — Re-Evolve
// Drop this into re-evolve workspace root (apps/web/src/lib/hgi/ or shared package).

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const HGI_SUPABASE_URL = process.env.NEXT_PUBLIC_HGI_SUPABASE_URL!;
const HGI_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_HGI_SUPABASE_ANON_KEY!;
const HGI_SERVICE_KEY = process.env.HGI_SERVICE_KEY!;

let _hgiClient: SupabaseClient | null = null;

function getHgiClient(): SupabaseClient {
  if (!_hgiClient) {
    _hgiClient = createClient(HGI_SUPABASE_URL, HGI_SUPABASE_ANON_KEY);
  }
  return _hgiClient;
}

const BASE_URL = `${HGI_SUPABASE_URL}/functions/v1`;

export async function syncReEvolveUserToHgi(params: {
  userId: string;
  email: string;
  displayName?: string;
  workspaceId?: string;
}): Promise<void> {
  const resp = await fetch(`${BASE_URL}/hgi-auth/sync/re-evolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
    body: JSON.stringify({
      user_id: params.userId, email: params.email,
      display_name: params.displayName, workspace_id: params.workspaceId || null,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    console.error("[ReEvolveHGI] sync failed:", err);
  }
}

export async function registerHgiAgent(params: {
  name: string;
  displayName: string;
  endpoint: string;
  apiPath: string;
  capabilities: string[];
  model?: string;
  version: string;
}): Promise<void> {
  const resp = await fetch(`${BASE_URL}/hgi-agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
    body: JSON.stringify({
      name: params.name, display_name: params.displayName, product: "re-evolve",
      endpoint: params.endpoint, api_path: params.apiPath,
      capabilities: params.capabilities, model: params.model, version: params.version,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`[ReEvolveHGI] agent registration failed for ${params.name}:`, err);
  }
}

export async function sendAgentHeartbeat(
  agentName: string,
  status: "active" | "degraded" | "offline" | "maintenance" = "active",
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${BASE_URL}/hgi-agents/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
      body: JSON.stringify({ agent_name: agentName, status, metadata }),
    });
  } catch {
    // Heartbeat failure is non-fatal
  }
}

export async function redeemHgiSsoToken(token: string): Promise<{
  userId: string;
  targetProduct: string;
  scopes: string[];
  profile: Record<string, unknown> | null;
} | null> {
  try {
    const resp = await fetch(`${BASE_URL}/hgi-auth/sso/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      userId: data.user_id, targetProduct: data.target_product,
      scopes: data.scopes, profile: data.profile || null,
    };
  } catch {
    return null;
  }
}

export async function trackHgiEvent(params: {
  eventName: string;
  userId?: string;
  orgId?: string;
  sessionId?: string;
  properties?: Record<string, unknown>;
}): Promise<void> {
  try {
    await fetch(`${BASE_URL}/hgi-analytics/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product: "re-evolve", event_name: params.eventName,
        user_id: params.userId, org_id: params.orgId,
        session_id: params.sessionId, properties: params.properties || {}, platform: "web",
      }),
    });
  } catch {
    // Non-fatal
  }
}

export async function sendHgiNotification(params: {
  userId: string;
  type: "info" | "success" | "warning" | "error" | "agent";
  title: string;
  body?: string;
  actionUrl?: string;
  channels?: ("in-app" | "email" | "sms")[];
}): Promise<void> {
  try {
    await fetch(`${BASE_URL}/hgi-notify/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
      body: JSON.stringify({
        user_id: params.userId, product: "re-evolve", type: params.type,
        title: params.title, body: params.body, action_url: params.actionUrl,
        channels: params.channels || ["in-app"],
      }),
    });
  } catch {
    // Non-fatal
  }
}

export async function getReEvolveSubscription(orgId: string) {
  const client = getHgiClient();
  const { data, error } = await client
    .from("hgi_subscriptions")
    .select("plan, status, current_period_end")
    .eq("org_id", orgId)
    .eq("product", "re-evolve")
    .single();

  if (error && error.code !== "PGRST116") return null;
  return data;
}

const BANNED_KEYWORDS = ["delete", "shutdown", "drop", "kill", "format", "rm -rf"];
const MAX_PAYLOAD_CHARS = 10_000;

export function localKavachaCheck(input: Record<string, unknown>): { allowed: boolean; reason?: string } {
  const payload = JSON.stringify(input);
  if (payload.length > MAX_PAYLOAD_CHARS) {
    return { allowed: false, reason: `Payload too large (${payload.length} > ${MAX_PAYLOAD_CHARS})` };
  }
  const lower = payload.toLowerCase();
  for (const kw of BANNED_KEYWORDS) {
    if (lower.includes(kw)) {
      return { allowed: false, reason: `Banned keyword: "${kw}"` };
    }
  }
  return { allowed: true };
}

export async function getUserHgiPermissions(userId: string) {
  const client = getHgiClient();
  const { data } = await client
    .from("hgi_permissions")
    .select("role, product, org_id, expires_at")
    .eq("user_id", userId)
    .eq("product", "re-evolve");

  return data || [];
}
