// HGI Platform — Integration Tests
// Runner: Deno test (deno test --allow-env --allow-net tests/integration/)

import { assertEquals, assertExists, assertNotEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const HGI_SERVICE_KEY = Deno.env.get("HGI_SERVICE_KEY")!;
const FN_BASE = `${SUPABASE_URL}/functions/v1`;

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const TEST_EMAIL = `hgi-test-${Date.now()}@integration.hgi.test`;
const TEST_PASSWORD = "Hgi@Int3gration!";
let testUserId: string;
let testOrgId: string;
let testAccessToken: string;

async function cleanup() {
  if (testUserId) {
    await adminClient.from("hgi_permissions").delete().eq("user_id", testUserId);
    await adminClient.from("hgi_users").delete().eq("id", testUserId);
    await adminClient.auth.admin.deleteUser(testUserId);
  }
  if (testOrgId) {
    await adminClient.from("hgi_subscriptions").delete().eq("org_id", testOrgId);
    await adminClient.from("hgi_organizations").delete().eq("id", testOrgId);
  }
}

Deno.test("AUTH: create test user via Supabase admin", async () => {
  const { data, error } = await adminClient.auth.admin.createUser({
    email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true,
  });
  assertEquals(error, null);
  assertExists(data.user?.id);
  testUserId = data.user!.id;
});

Deno.test("AUTH: sign in and get access token", async () => {
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await anonClient.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
  assertEquals(error, null);
  assertExists(data.session?.access_token);
  testAccessToken = data.session!.access_token;
});

Deno.test("AUTH: hgi_users row created by trigger on sign-up", async () => {
  const { data, error } = await adminClient.from("hgi_users").select("*").eq("id", testUserId).single();
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.email, TEST_EMAIL);
});

Deno.test("ORG: create test organization", async () => {
  const { data, error } = await adminClient
    .from("hgi_organizations")
    .insert({ name: "HGI Test Org", slug: `test-org-${Date.now()}`, plan: "free" })
    .select().single();
  assertEquals(error, null);
  assertExists(data.id);
  testOrgId = data.id;
});

Deno.test("ORG: assign user to org", async () => {
  const { error: userErr } = await adminClient.from("hgi_users").update({ org_id: testOrgId }).eq("id", testUserId);
  assertEquals(userErr, null);

  const { error: permErr } = await adminClient.from("hgi_permissions").insert({
    user_id: testUserId, org_id: testOrgId, product: "artoies", role: "admin",
  });
  assertEquals(permErr, null);
});

Deno.test("SSO: issue token from artoies to re-evolve", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-auth/sso/issue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${testAccessToken}`,
      "x-hgi-product": "artoies",
    },
    body: JSON.stringify({ target_product: "re-evolve", scopes: ["read:workspace"] }),
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertExists(body.token);
  assertEquals(body.expires_in, 600);
  (globalThis as Record<string, unknown>).__sso_token = body.token;
});

Deno.test("SSO: redeem token at re-evolve", async () => {
  const token = (globalThis as Record<string, unknown>).__sso_token as string;
  if (!token) return;

  const resp = await fetch(`${FN_BASE}/hgi-auth/sso/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.user_id, testUserId);
  assertEquals(body.target_product, "re-evolve");
});

Deno.test("SSO: token cannot be redeemed twice", async () => {
  const token = (globalThis as Record<string, unknown>).__sso_token as string;
  if (!token) return;

  const resp = await fetch(`${FN_BASE}/hgi-auth/sso/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assertEquals(resp.status, 401);
});

Deno.test("BILLING: get plans returns expected structure", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-billing/plans`);
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertExists(body.plans);
  assertExists(body.plans.free);
  assertEquals(body.plans.free.price_inr, 0);
});

Deno.test("BILLING: subscribe to free plan", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-billing/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${testAccessToken}` },
    body: JSON.stringify({ org_id: testOrgId, product: "artoies", plan: "free" }),
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.payment_required, false);
  assertEquals(body.subscription.plan, "free");
});

Deno.test("BILLING: get subscription status", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-billing/status?org_id=${testOrgId}&product=artoies`, {
    headers: { Authorization: `Bearer ${testAccessToken}` },
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.subscriptions.length > 0, true);
});

Deno.test("AGENTS: list active agents", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-agents/list`, {
    headers: { Authorization: `Bearer ${testAccessToken}` },
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertExists(body.agents);
});

Deno.test("AGENTS: heartbeat registers agent", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-agents/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
    body: JSON.stringify({ agent_name: "artomind", status: "active", version: "2.0.0" }),
  });
  assertEquals(resp.status, 200);
  assertEquals((await resp.json()).recorded, true);
});

Deno.test("ANALYTICS: track single event", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-analytics/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product: "artoies", event_name: "integration_test_event",
      user_id: testUserId, org_id: testOrgId, properties: { test: true },
    }),
  });
  assertEquals((await resp.json()).tracked, true);
});

Deno.test("ANALYTICS: batch track events", async () => {
  const events = Array.from({ length: 5 }, (_, i) => ({
    product: "artoies", event_name: `batch_test_${i}`, user_id: testUserId, properties: { seq: i },
  }));
  const resp = await fetch(`${FN_BASE}/hgi-analytics/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
  assertEquals((await resp.json()).tracked, 5);
});

Deno.test("NOTIFY: send in-app notification", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-notify/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
    body: JSON.stringify({
      user_id: testUserId, product: "artoies", type: "info",
      title: "Integration test notification",
    }),
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertExists(body.notification_id);
  assertEquals(body.dispatched.includes("in-app"), true);
});

Deno.test("NOTIFY: list notifications for user", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-notify/list`, {
    headers: { Authorization: `Bearer ${testAccessToken}` },
  });
  assertEquals(resp.status, 200);
  assertEquals((await resp.json()).notifications.length > 0, true);
});

Deno.test("NOTIFY: get unread count", async () => {
  const resp = await fetch(`${FN_BASE}/hgi-notify/unread-count`, {
    headers: { Authorization: `Bearer ${testAccessToken}` },
  });
  const body = await resp.json();
  assertEquals(typeof body.unread, "number");
  assertEquals(body.unread >= 1, true);
});

Deno.test("SYNC: artoies user sync creates hgi_users row", async () => {
  const syncResp = await fetch(`${FN_BASE}/hgi-auth/sync/artoies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
    body: JSON.stringify({
      user_id: testUserId, email: TEST_EMAIL, display_name: "Integration Tester",
      role: "vendor", vendor_id: crypto.randomUUID(),
    }),
  });
  assertEquals((await syncResp.json()).synced, true);

  const { data } = await adminClient.from("hgi_users").select("display_name").eq("id", testUserId).single();
  assertEquals(data?.display_name, "Integration Tester");
});

Deno.test("CLEANUP: remove test fixtures", async () => {
  await cleanup();
});
