// HGI Platform — Security Tests
// Verifies: RLS enforcement, auth bypass attempts, IDOR, Kavacha injection

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const HGI_SERVICE_KEY = Deno.env.get("HGI_SERVICE_KEY")!;
const FN_BASE = `${SUPABASE_URL}/functions/v1`;

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function createTestUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `sec-test-${suffix}-${Date.now()}@security.hgi.test`;
  const { data } = await adminClient.auth.admin.createUser({ email, password: "Hgi@Security!", email_confirm: true });
  const id = data.user!.id;
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: session } = await anonClient.auth.signInWithPassword({ email, password: "Hgi@Security!" });
  return { id, token: session.session!.access_token };
}

async function deleteTestUser(id: string) {
  await adminClient.from("hgi_users").delete().eq("id", id);
  await adminClient.auth.admin.deleteUser(id);
}

Deno.test("SECURITY/RLS: anon user cannot read hgi_users", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data } = await anonClient.from("hgi_users").select("*").limit(10);
  assertEquals(data === null || (Array.isArray(data) && data.length === 0), true);
});

Deno.test("SECURITY/RLS: anon user cannot read hgi_subscriptions", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data } = await anonClient.from("hgi_subscriptions").select("*").limit(10);
  assertEquals(data === null || (Array.isArray(data) && data.length === 0), true);
});

Deno.test("SECURITY/RLS: anon user cannot read hgi_permissions", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data } = await anonClient.from("hgi_permissions").select("*").limit(10);
  assertEquals(data === null || (Array.isArray(data) && data.length === 0), true);
});

Deno.test("SECURITY/RLS: anon user cannot read hgi_audit_log", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data } = await anonClient.from("hgi_audit_log").select("*").limit(10);
  assertEquals(data === null || (Array.isArray(data) && data.length === 0), true);
});

Deno.test("SECURITY/RLS: anon user cannot read hgi_sso_tokens", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data } = await anonClient.from("hgi_sso_tokens").select("*").limit(10);
  assertEquals(data === null || (Array.isArray(data) && data.length === 0), true);
});

Deno.test("SECURITY/IDOR: user A cannot read user B notifications", async () => {
  const userA = await createTestUser("idor-a");
  const userB = await createTestUser("idor-b");

  await adminClient.from("hgi_notifications").insert({
    user_id: userB.id, product: "artoies", type: "info", title: "Secret notification for B",
  });

  const clientA = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userA.token}` } },
  });
  const { data } = await clientA.from("hgi_notifications").select("*");
  const leaked = (data || []).some((n: { user_id: string }) => n.user_id === userB.id);
  assertEquals(leaked, false, "User A must not see User B notifications");

  await deleteTestUser(userA.id);
  await deleteTestUser(userB.id);
});

Deno.test("SECURITY/IDOR: user cannot modify another user's profile", async () => {
  const userA = await createTestUser("idor-c");
  const userB = await createTestUser("idor-d");

  const clientA = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userA.token}` } },
  });

  await clientA.from("hgi_users").update({ display_name: "Hacked by A" }).eq("id", userB.id);

  const { data: bProfile } = await adminClient.from("hgi_users").select("display_name").eq("id", userB.id).single();
  assertNotEquals(bProfile?.display_name, "Hacked by A", "RLS must prevent cross-user update");

  await deleteTestUser(userA.id);
  await deleteTestUser(userB.id);
});

Deno.test("SECURITY/AUTH: edge functions reject missing auth", async () => {
  const endpoints = [
    { url: `${FN_BASE}/hgi-agents/list`, method: "GET" },
    { url: `${FN_BASE}/hgi-billing/status?org_id=test`, method: "GET" },
    { url: `${FN_BASE}/hgi-notify/list`, method: "GET" },
  ];

  for (const ep of endpoints) {
    const resp = await fetch(ep.url, { method: ep.method });
    assertEquals(
      resp.status === 401 || resp.status === 403 || resp.status === 500, true,
      `${ep.url} must reject unauthenticated requests`,
    );
  }
});

Deno.test("SECURITY/AUTH: service key endpoints reject wrong key", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-agents/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": "wrong-key-12345" },
    body: JSON.stringify({ agent_name: "artomind", status: "active" }),
  });
  assertEquals(resp.status === 403 || resp.status === 500, true);
});

Deno.test("SECURITY/AUTH: SSO token cannot be forged", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-auth/sso/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "hgi_sso_" + crypto.randomUUID().replace(/-/g, "") }),
  });
  assertEquals(resp.status, 401);
});

Deno.test("SECURITY/KAVACHA: blocks banned keyword 'delete'", async () => {
  const user = await createTestUser("kavacha-a");

  const resp = await fetch(`${FN_BASE}/hgi-agents/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({
      agent_name: "artomind", org_id: crypto.randomUUID(),
      input: { message: "please delete all records from the database" },
    }),
  });

  const body = await resp.json();
  assertEquals(resp.status, 403);
  assertEquals(body.blocked, true);
  await deleteTestUser(user.id);
});

Deno.test("SECURITY/KAVACHA: blocks payload exceeding 10000 chars", async () => {
  const user = await createTestUser("kavacha-b");

  const resp = await fetch(`${FN_BASE}/hgi-agents/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({
      agent_name: "artomind", org_id: crypto.randomUUID(),
      input: { message: "A".repeat(10_001) },
    }),
  });

  assertEquals((await resp.json()).blocked, true);
  await deleteTestUser(user.id);
});

Deno.test("SECURITY/KAVACHA: blocks 'rm -rf' variant", async () => {
  const user = await createTestUser("kavacha-c");

  const resp = await fetch(`${FN_BASE}/hgi-agents/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({
      agent_name: "artomind", org_id: crypto.randomUUID(),
      input: { command: "rm -rf /data/critical" },
    }),
  });

  assertEquals(resp.status, 403);
  await deleteTestUser(user.id);
});

Deno.test("SECURITY/SQLi: parameterized queries reject injection attempt", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data } = await anonClient
    .from("hgi_subscriptions")
    .select("*")
    .eq("org_id", "' OR '1'='1");
  assertEquals(data === null || (Array.isArray(data) && data.length === 0), true);
});
