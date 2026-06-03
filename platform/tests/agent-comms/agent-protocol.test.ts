// HGI Platform — Agent Communication Tests

import { assertEquals, assertExists, assertGreater } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const HGI_SERVICE_KEY = Deno.env.get("HGI_SERVICE_KEY")!;
const FN_BASE = `${SUPABASE_URL}/functions/v1`;

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const TEST_AGENT_NAME = `test-agent-${Date.now()}`;
const TEST_AGENT_ENDPOINT = "https://mock.hgi.internal";

Deno.test("AGENT-COMMS: register a new agent via service key", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
    body: JSON.stringify({
      name: TEST_AGENT_NAME, display_name: "Test Agent", product: "re-evolve",
      endpoint: TEST_AGENT_ENDPOINT, api_path: "/v1/invoke",
      capabilities: ["text-generation", "reasoning"], model: "claude-sonnet-4-6", version: "1.0.0",
    }),
  });

  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.registered, true);
  assertExists(body.agent?.id);
});

Deno.test("AGENT-COMMS: registered agent appears in list", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: session } = await anonClient.auth.signInWithPassword({
    email: Deno.env.get("TEST_USER_EMAIL") || "test@hgi.internal",
    password: Deno.env.get("TEST_USER_PASSWORD") || "TestHgi123!",
  });

  if (!session.session) {
    console.warn("AGENT-COMMS: skipping list test — no test user credentials");
    return;
  }

  const resp = await fetch(`${FN_BASE}/hgi-agents/list?product=re-evolve`, {
    headers: { Authorization: `Bearer ${session.session.access_token}` },
  });

  assertEquals(resp.status, 200);
  const body = await resp.json();
  const found = (body.agents || []).some((a: { name: string }) => a.name === TEST_AGENT_NAME);
  assertEquals(found, true, "Registered agent must appear in list");
});

Deno.test("AGENT-COMMS: heartbeat updates last_heartbeat timestamp", async () => {
  const before = new Date();

  const resp = await fetch(`${FN_BASE}/hgi-agents/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
    body: JSON.stringify({ agent_name: TEST_AGENT_NAME, status: "active", version: "1.0.1", metadata: { memory_mb: 256, cpu_pct: 12 } }),
  });

  assertEquals(resp.status, 200);
  assertEquals((await resp.json()).recorded, true);

  const { data: agent } = await adminClient
    .from("hgi_agent_registry")
    .select("last_heartbeat, version")
    .eq("name", TEST_AGENT_NAME)
    .single();

  assertExists(agent?.last_heartbeat);
  assertEquals(new Date(agent!.last_heartbeat) >= before, true, "Heartbeat timestamp must be after test start");
  assertEquals(agent?.version, "1.0.1");
});

Deno.test("AGENT-COMMS: heartbeat creates record in hgi_agent_heartbeats", async () => {
  const { data } = await adminClient
    .from("hgi_agent_heartbeats")
    .select("*")
    .eq("agent_name", TEST_AGENT_NAME)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  assertExists(data);
  assertEquals(data.status, "active");
});

Deno.test("AGENT-COMMS: heartbeat updates status to degraded", async () => {
  await fetch(`${FN_BASE}/hgi-agents/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
    body: JSON.stringify({ agent_name: TEST_AGENT_NAME, status: "degraded" }),
  });

  const { data: agent } = await adminClient
    .from("hgi_agent_registry")
    .select("status")
    .eq("name", TEST_AGENT_NAME)
    .single();

  assertEquals(agent?.status, "degraded");
});

Deno.test("AGENT-COMMS: call to unknown agent returns 404", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: session } = await anonClient.auth.signInWithPassword({
    email: Deno.env.get("TEST_USER_EMAIL") || "test@hgi.internal",
    password: Deno.env.get("TEST_USER_PASSWORD") || "TestHgi123!",
  });

  if (!session.session) return;

  const resp = await fetch(`${FN_BASE}/hgi-agents/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.session.access_token}` },
    body: JSON.stringify({ agent_name: "nonexistent-agent-xyz", org_id: crypto.randomUUID(), input: { message: "hello" } }),
  });

  assertEquals(resp.status === 404 || resp.status === 403, true);
});

Deno.test("AGENT-COMMS: Kavacha blocked calls appear in hgi_kavacha_decisions", async () => {
  const { data } = await adminClient
    .from("hgi_kavacha_decisions")
    .select("decision, reason")
    .eq("decision", "blocked")
    .order("created_at", { ascending: false })
    .limit(5);

  assertExists(data);
  for (const d of data || []) {
    assertExists(d.reason);
  }
});

Deno.test("AGENT-COMMS: all agent call statuses are valid enum values", async () => {
  const { data } = await adminClient.from("hgi_agent_calls").select("status").limit(100);
  const valid = new Set(["pending", "success", "error", "blocked"]);
  for (const row of data || []) {
    assertEquals(valid.has(row.status), true, `Invalid status: ${row.status}`);
  }
});

Deno.test("AGENT-COMMS CLEANUP: remove test agent", async () => {
  await adminClient.from("hgi_agent_heartbeats").delete().eq("agent_name", TEST_AGENT_NAME);
  await adminClient.from("hgi_agent_registry").delete().eq("name", TEST_AGENT_NAME);
});
