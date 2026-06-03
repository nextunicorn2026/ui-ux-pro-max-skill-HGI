// HGI Platform — Agent Orchestration Edge Function

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hgi-product, x-hgi-service-key",
};

const PLANS = {
  free: { agent_calls_per_month: 100 },
  starter: { agent_calls_per_month: 1000 },
  pro: { agent_calls_per_month: 10000 },
  enterprise: { agent_calls_per_month: -1 },
} as const;

const KAVACHA_BANNED = ["delete", "shutdown", "drop", "kill", "format", "rm -rf"];
const KAVACHA_MAX_PAYLOAD = 10_000;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace("/hgi-agents", "");

  try {
    switch (path) {
      case "/list": return handleList(req);
      case "/call": return handleCall(req);
      case "/heartbeat": return handleHeartbeat(req);
      case "/register": return handleRegister(req);
      case "/status": return handleAgentStatus(req);
      default:
        return json({ error: "Unknown path" }, 404);
    }
  } catch (err) {
    console.error("[hgi-agents]", err);
    return json({ error: (err as Error).message }, 500);
  }
});

async function handleList(req: Request): Promise<Response> {
  await requireAuth(req);
  const url = new URL(req.url);
  const product = url.searchParams.get("product");
  const status = url.searchParams.get("status") || "active";

  let query = supabase
    .from("hgi_agent_registry")
    .select("id, name, display_name, product, capabilities, model, status, last_heartbeat, version")
    .eq("status", status);

  if (product) query = query.eq("product", product);

  const { data, error } = await query;
  if (error) throw error;

  return json({ agents: data || [] });
}

async function handleCall(req: Request): Promise<Response> {
  const user = await requireAuth(req);
  const body = await req.json();
  const { agent_name, input, org_id, session_id } = body;

  if (!agent_name || !input) return json({ error: "agent_name and input required" }, 400);
  if (!org_id) return json({ error: "org_id required" }, 400);

  const kavachaResult = kavacha(input, agent_name);
  if (!kavachaResult.allowed) {
    await recordKavachaDecision(user.id, org_id, agent_name, "blocked", kavachaResult.reason!, input);
    return json({ blocked: true, reason: kavachaResult.reason }, 403);
  }

  const limitCheck = await checkUsageLimit(org_id);
  if (!limitCheck.allowed) {
    return json({ error: "Monthly agent call limit reached. Upgrade your plan.", limit_reached: true, current_usage: limitCheck.current, plan_limit: limitCheck.limit }, 429);
  }

  const { data: agent, error: agentErr } = await supabase
    .from("hgi_agent_registry")
    .select("*")
    .eq("name", agent_name)
    .eq("status", "active")
    .single();

  if (agentErr || !agent) return json({ error: `Agent '${agent_name}' not found or offline` }, 404);

  const callId = crypto.randomUUID();
  const startMs = Date.now();

  await supabase.from("hgi_agent_calls").insert({
    id: callId, agent_id: agent.id, user_id: user.id, org_id,
    session_id: session_id || null, status: "pending",
  });

  await recordKavachaDecision(user.id, org_id, agent_name, "allowed", null, input);

  try {
    const agentResp = await fetch(`${agent.endpoint}${agent.api_path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hgi-call-id": callId,
        "x-hgi-user-id": user.id,
        "x-hgi-org-id": org_id,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    });

    if (!agentResp.ok) {
      const errText = await agentResp.text();
      throw new Error(`Agent returned ${agentResp.status}: ${errText.slice(0, 200)}`);
    }

    const output = await agentResp.json();
    const durationMs = Date.now() - startMs;
    const tokensIn = output.usage?.prompt_tokens || output.tokens_in || 0;
    const tokensOut = output.usage?.completion_tokens || output.tokens_out || 0;

    await supabase.from("hgi_agent_calls").update({
      status: "success", duration_ms: durationMs, tokens_in: tokensIn, tokens_out: tokensOut,
    }).eq("id", callId);

    return json({ call_id: callId, output: output.result ?? output, duration_ms: durationMs, tokens_in: tokensIn, tokens_out: tokensOut });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    await supabase.from("hgi_agent_calls").update({
      status: "error", duration_ms: durationMs, error_code: (err as Error).message.slice(0, 255),
    }).eq("id", callId);
    throw err;
  }
}

async function handleHeartbeat(req: Request): Promise<Response> {
  await requireServiceKey(req);
  const { agent_name, status, version, metadata } = await req.json();

  if (!agent_name) return json({ error: "agent_name required" }, 400);

  const validStatus = ["active", "degraded", "offline", "maintenance"];
  const agentStatus = validStatus.includes(status) ? status : "active";

  const { error: regErr } = await supabase
    .from("hgi_agent_registry")
    .update({
      status: agentStatus,
      last_heartbeat: new Date().toISOString(),
      ...(version ? { version } : {}),
      ...(metadata ? { metadata } : {}),
    })
    .eq("name", agent_name);

  if (regErr) throw regErr;

  await supabase.from("hgi_agent_heartbeats").insert({
    agent_name, status: agentStatus, metadata: metadata || {},
  });

  return json({ recorded: true, agent: agent_name, status: agentStatus });
}

async function handleRegister(req: Request): Promise<Response> {
  await requireServiceKey(req);
  const { name, display_name, product, endpoint, api_path, capabilities, model, version } = await req.json();

  if (!name || !product || !endpoint || !api_path) {
    return json({ error: "name, product, endpoint, and api_path required" }, 400);
  }

  const { data, error } = await supabase
    .from("hgi_agent_registry")
    .upsert({
      name, display_name: display_name || name, product, endpoint, api_path,
      capabilities: capabilities || [], model: model || null,
      version: version || "1.0.0", status: "active",
      last_heartbeat: new Date().toISOString(),
    }, { onConflict: "name" })
    .select()
    .single();

  if (error) throw error;
  return json({ registered: true, agent: data });
}

async function handleAgentStatus(req: Request): Promise<Response> {
  await requireAuth(req);
  const url = new URL(req.url);
  const agentName = url.searchParams.get("name");

  if (!agentName) return json({ error: "name required" }, 400);

  const { data: agent, error } = await supabase
    .from("hgi_agent_registry")
    .select("name, display_name, product, status, last_heartbeat, version, capabilities")
    .eq("name", agentName)
    .single();

  if (error || !agent) return json({ error: "Agent not found" }, 404);

  const sinceMs = agent.last_heartbeat
    ? Date.now() - new Date(agent.last_heartbeat).getTime()
    : null;

  return json({
    ...agent,
    heartbeat_age_ms: sinceMs,
    healthy: agent.status === "active" && (sinceMs === null || sinceMs < 120_000),
  });
}

function kavacha(input: unknown, agentName: string): { allowed: boolean; reason?: string } {
  const payload = JSON.stringify(input);

  if (payload.length > KAVACHA_MAX_PAYLOAD) {
    return { allowed: false, reason: `Payload exceeds maximum size of ${KAVACHA_MAX_PAYLOAD} characters` };
  }

  const lower = payload.toLowerCase();
  for (const banned of KAVACHA_BANNED) {
    if (lower.includes(banned)) {
      return { allowed: false, reason: `Banned keyword detected: "${banned}"` };
    }
  }

  return { allowed: true };
}

async function recordKavachaDecision(
  userId: string, orgId: string, agentName: string,
  decision: "allowed" | "blocked", reason: string | null, input: unknown,
) {
  await supabase.from("hgi_kavacha_decisions").insert({
    user_id: userId, org_id: orgId, agent_name: agentName,
    decision, reason: reason || null,
    payload_hash: await sha256(JSON.stringify(input)),
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function checkUsageLimit(orgId: string): Promise<{ allowed: boolean; current: number; limit: number }> {
  const { data: sub } = await supabase
    .from("hgi_subscriptions")
    .select("plan")
    .eq("org_id", orgId)
    .eq("status", "active")
    .limit(1)
    .single();

  const plan = (sub?.plan || "free") as keyof typeof PLANS;
  const limit = PLANS[plan]?.agent_calls_per_month ?? 100;

  if (limit === -1) return { allowed: true, current: 0, limit: -1 };

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("hgi_agent_calls")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "success")
    .gte("created_at", startOfMonth.toISOString());

  const current = count || 0;
  return { allowed: current < limit, current, limit };
}

async function requireAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Unauthorized");
  const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user) throw new Error("Invalid token");
  return user;
}

async function requireServiceKey(req: Request) {
  const key = req.headers.get("x-hgi-service-key");
  const expected = Deno.env.get("HGI_SERVICE_KEY");
  if (!expected || key !== expected) throw new Error("Forbidden: invalid service key");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
