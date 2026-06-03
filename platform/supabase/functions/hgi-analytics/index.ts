// HGI Platform — Analytics Edge Function

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hgi-product, x-hgi-service-key",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace("/hgi-analytics", "");

  try {
    switch (path) {
      case "/track": return handleTrack(req);
      case "/batch": return handleBatch(req);
      case "/query": return handleQuery(req);
      case "/funnel": return handleFunnel(req);
      case "/retention": return handleRetention(req);
      case "/top-events": return handleTopEvents(req);
      default:
        return json({ error: "Unknown path" }, 404);
    }
  } catch (err) {
    console.error("[hgi-analytics]", err);
    return json({ error: (err as Error).message }, 500);
  }
});

async function handleTrack(req: Request): Promise<Response> {
  const body = await req.json();
  const { user_id, org_id, product, event_name, session_id, properties, device, platform } = body;

  if (!product || !event_name) return json({ error: "product and event_name required" }, 400);

  const { error } = await supabase.from("hgi_analytics_events").insert({
    user_id: user_id || null, org_id: org_id || null, product, event_name,
    session_id: session_id || null, properties: properties || {},
    device: device || null, platform: platform || null,
  });

  if (error) {
    console.error("[hgi-analytics] track error:", error.message);
    return json({ tracked: false, error: error.message });
  }

  return json({ tracked: true });
}

async function handleBatch(req: Request): Promise<Response> {
  const { events } = await req.json();
  if (!Array.isArray(events) || events.length === 0) return json({ error: "events array required" }, 400);
  if (events.length > 100) return json({ error: "Max 100 events per batch" }, 400);

  const rows = events
    .filter(e => e.product && e.event_name)
    .map(e => ({
      user_id: e.user_id || null, org_id: e.org_id || null, product: e.product,
      event_name: e.event_name, session_id: e.session_id || null,
      properties: e.properties || {}, device: e.device || null, platform: e.platform || null,
    }));

  if (rows.length === 0) return json({ error: "No valid events in batch" }, 400);

  const { error } = await supabase.from("hgi_analytics_events").insert(rows);

  if (error) {
    console.error("[hgi-analytics] batch error:", error.message);
    return json({ tracked: 0, error: error.message });
  }

  return json({ tracked: rows.length });
}

async function handleQuery(req: Request): Promise<Response> {
  await requireAdminOrService(req);
  const url = new URL(req.url);

  const product = url.searchParams.get("product");
  const event = url.searchParams.get("event");
  const orgId = url.searchParams.get("org_id");
  const from = url.searchParams.get("from") || startOfDay(-7);
  const to = url.searchParams.get("to") || new Date().toISOString();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "1000"), 5000);

  let query = supabase
    .from("hgi_analytics_events")
    .select("id, user_id, org_id, product, event_name, session_id, properties, device, platform, created_at")
    .gte("created_at", from)
    .lte("created_at", to)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (product) query = query.eq("product", product);
  if (event) query = query.eq("event_name", event);
  if (orgId) query = query.eq("org_id", orgId);

  const { data, error, count } = await query;
  if (error) throw error;

  return json({ events: data || [], total: count, from, to });
}

async function handleFunnel(req: Request): Promise<Response> {
  await requireAdminOrService(req);
  const { product, steps, from, to, org_id } = await req.json();

  if (!product || !Array.isArray(steps) || steps.length < 2) {
    return json({ error: "product and steps (min 2) required" }, 400);
  }

  const since = from || startOfDay(-30);
  const until = to || new Date().toISOString();
  const funnelData: Array<{ step: string; users: number; drop_off?: number }> = [];
  let prevUsers: Set<string> = new Set();

  for (let i = 0; i < steps.length; i++) {
    let query = supabase
      .from("hgi_analytics_events")
      .select("user_id")
      .eq("product", product)
      .eq("event_name", steps[i])
      .gte("created_at", since)
      .lte("created_at", until)
      .not("user_id", "is", null);

    if (org_id) query = query.eq("org_id", org_id);

    const { data } = await query;
    const stepUsers = new Set((data || []).map((r: { user_id: string }) => r.user_id));
    const matchedUsers = i === 0
      ? stepUsers
      : new Set([...stepUsers].filter(u => prevUsers.has(u)));

    funnelData.push({
      step: steps[i], users: matchedUsers.size,
      ...(i > 0 ? { drop_off: prevUsers.size - matchedUsers.size } : {}),
    });

    prevUsers = matchedUsers;
  }

  return json({ product, steps: funnelData, period: { from: since, to: until } });
}

async function handleRetention(req: Request): Promise<Response> {
  await requireAdminOrService(req);
  const url = new URL(req.url);
  const product = url.searchParams.get("product");
  const days = parseInt(url.searchParams.get("days") || "7");

  if (!product) return json({ error: "product required" }, 400);

  const cohortStart = startOfDay(-days * 2);
  const cohortEnd = startOfDay(-days);

  const { data: newUsers } = await supabase
    .from("hgi_analytics_events")
    .select("user_id")
    .eq("product", product)
    .gte("created_at", cohortStart)
    .lte("created_at", cohortEnd)
    .not("user_id", "is", null);

  const cohort = new Set((newUsers || []).map((r: { user_id: string }) => r.user_id));
  if (cohort.size === 0) return json({ cohort_size: 0, retained: 0, retention_rate: 0 });

  const { data: retained } = await supabase
    .from("hgi_analytics_events")
    .select("user_id")
    .eq("product", product)
    .gte("created_at", startOfDay(-days))
    .lte("created_at", new Date().toISOString())
    .not("user_id", "is", null);

  const retainedSet = new Set((retained || []).map((r: { user_id: string }) => r.user_id));
  const retainedCount = [...cohort].filter(u => retainedSet.has(u)).length;

  return json({
    product, cohort_size: cohort.size, retained: retainedCount,
    retention_rate: parseFloat(((retainedCount / cohort.size) * 100).toFixed(1)),
    period_days: days,
  });
}

async function handleTopEvents(req: Request): Promise<Response> {
  await requireAdminOrService(req);
  const url = new URL(req.url);
  const product = url.searchParams.get("product");
  const from = url.searchParams.get("from") || startOfDay(-7);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 50);

  let query = supabase.from("hgi_analytics_events").select("event_name").gte("created_at", from);
  if (product) query = query.eq("product", product);

  const { data } = await query;
  const counts: Record<string, number> = {};
  for (const row of data || []) {
    counts[row.event_name] = (counts[row.event_name] || 0) + 1;
  }

  const sorted = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([event_name, count]) => ({ event_name, count }));

  return json({ events: sorted, product: product || "all", from });
}

function startOfDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function requireAdminOrService(req: Request) {
  const serviceKey = req.headers.get("x-hgi-service-key");
  const expected = Deno.env.get("HGI_SERVICE_KEY");
  if (expected && serviceKey === expected) return;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Unauthorized");

  const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user) throw new Error("Invalid token");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
