// HGI Integration Adapter — Artoies
// Drop this into artoies-hub/src/lib/hgi/ and initialize on app boot.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const HGI_SUPABASE_URL = import.meta.env.VITE_HGI_SUPABASE_URL as string;
const HGI_SUPABASE_ANON_KEY = import.meta.env.VITE_HGI_SUPABASE_ANON_KEY as string;
const HGI_SERVICE_KEY = import.meta.env.VITE_HGI_SERVICE_KEY as string;

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

let _hgiClient: SupabaseClient | null = null;

function getHgiClient(): SupabaseClient {
  if (!_hgiClient) {
    _hgiClient = createClient(
      HGI_SUPABASE_URL || SUPABASE_URL,
      HGI_SUPABASE_ANON_KEY || SUPABASE_ANON_KEY,
    );
  }
  return _hgiClient;
}

export type ArtoiesRole = "customer" | "vendor" | "delivery_exec" | "admin" | "founder";

export async function syncArtoiesUserToHgi(params: {
  userId: string;
  email: string;
  displayName?: string;
  role: ArtoiesRole;
  vendorId?: string;
}): Promise<void> {
  const baseUrl = `${HGI_SUPABASE_URL || SUPABASE_URL}/functions/v1/hgi-auth`;

  try {
    const resp = await fetch(`${baseUrl}/sync/artoies`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
      body: JSON.stringify({
        user_id: params.userId, email: params.email,
        display_name: params.displayName, role: params.role,
        vendor_id: params.vendorId || null,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.error("[ArtoiesHGI] sync failed:", err);
    }
  } catch {
    // Non-fatal — Artoies continues without HGI sync
  }
}

export async function issueHgiSsoToken(targetProduct: "re-evolve" | "imagin" | "kavacha", scopes: string[] = []): Promise<string | null> {
  const client = getHgiClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) return null;

  const baseUrl = `${HGI_SUPABASE_URL || SUPABASE_URL}/functions/v1/hgi-auth`;

  try {
    const resp = await fetch(`${baseUrl}/sso/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        "x-hgi-product": "artoies",
      },
      body: JSON.stringify({ target_product: targetProduct, scopes }),
    });

    if (!resp.ok) return null;
    const { token } = await resp.json();
    return token as string;
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
  const baseUrl = `${HGI_SUPABASE_URL || SUPABASE_URL}/functions/v1/hgi-analytics`;

  try {
    await fetch(`${baseUrl}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product: "artoies", event_name: params.eventName,
        user_id: params.userId, org_id: params.orgId,
        session_id: params.sessionId, properties: params.properties || {}, platform: "web",
      }),
    });
  } catch {
    // Analytics must never break product flow
  }
}

export async function getArtoiesSubscription(orgId: string) {
  const client = getHgiClient();
  const { data, error } = await client
    .from("hgi_subscriptions")
    .select("plan, status, current_period_end, canceled_at")
    .eq("org_id", orgId)
    .eq("product", "artoies")
    .single();

  if (error && error.code !== "PGRST116") return null;
  return data;
}

export async function isArtoiesSubscriptionActive(orgId: string): Promise<boolean> {
  const sub = await getArtoiesSubscription(orgId);
  return sub?.status === "active" || sub?.status === "trialing";
}

export async function callArtoMindViaHgi(params: {
  input: Record<string, unknown>;
  orgId: string;
  sessionId?: string;
}): Promise<{ output: unknown; callId: string; durationMs: number } | null> {
  const client = getHgiClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) return null;

  const baseUrl = `${HGI_SUPABASE_URL || SUPABASE_URL}/functions/v1/hgi-agents`;

  try {
    const resp = await fetch(`${baseUrl}/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        "x-hgi-product": "artoies",
      },
      body: JSON.stringify({
        agent_name: "artomind", input: params.input,
        org_id: params.orgId, session_id: params.sessionId,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if ((err as { blocked?: boolean }).blocked) {
        console.warn("[ArtoiesHGI] ArtoMind call blocked by Kavacha:", (err as { reason?: string }).reason);
      }
      return null;
    }

    const { call_id, output, duration_ms } = await resp.json();
    return { callId: call_id, output, durationMs: duration_ms };
  } catch {
    return null;
  }
}

export async function subscribeToHgiNotifications(
  userId: string,
  onNotification: (notif: Record<string, unknown>) => void,
) {
  const client = getHgiClient();

  return client
    .channel(`hgi-notifications-artoies-${userId}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "hgi_notifications",
      filter: `user_id=eq.${userId}`,
    }, payload => onNotification(payload.new as Record<string, unknown>))
    .subscribe();
}

export async function getUserHgiRole(userId: string): Promise<string | null> {
  const client = getHgiClient();
  const { data } = await client
    .from("hgi_permissions")
    .select("role")
    .eq("user_id", userId)
    .eq("product", "artoies")
    .order("granted_at", { ascending: false })
    .limit(1)
    .single();

  return data?.role || null;
}
