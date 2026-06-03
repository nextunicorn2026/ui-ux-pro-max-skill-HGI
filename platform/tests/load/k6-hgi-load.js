// HGI Platform — Load Tests (k6)
// Run: k6 run --env SUPABASE_URL=... --env HGI_SERVICE_KEY=... tests/load/k6-hgi-load.js

import http from "k6/http";
import { sleep, check, group } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

const errorRate = new Rate("hgi_error_rate");
const agentCallDuration = new Trend("hgi_agent_call_duration", true);
const analyticsTrackDuration = new Trend("hgi_analytics_track_duration", true);
const notifyDuration = new Trend("hgi_notify_duration", true);
const blockedCalls = new Counter("hgi_kavacha_blocked");

const SUPABASE_URL = __ENV.SUPABASE_URL;
const HGI_SERVICE_KEY = __ENV.HGI_SERVICE_KEY;
const TEST_ACCESS_TOKEN = __ENV.TEST_ACCESS_TOKEN;
const TEST_ORG_ID = __ENV.TEST_ORG_ID;

const BASE = `${SUPABASE_URL}/functions/v1`;

export const options = {
  scenarios: {
    analytics_baseline: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 10 },
        { duration: "1m", target: 10 },
        { duration: "15s", target: 0 },
      ],
      exec: "analyticsScenario",
    },
    notification_spike: {
      executor: "constant-vus",
      vus: 50,
      duration: "30s",
      startTime: "2m",
      exec: "notifyScenario",
    },
    platform_sustained: {
      executor: "constant-vus",
      vus: 20,
      duration: "2m",
      startTime: "3m",
      exec: "platformScenario",
    },
    stress_test: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: 50 },
        { duration: "2m", target: 100 },
        { duration: "30s", target: 0 },
      ],
      startTime: "6m",
      exec: "analyticsScenario",
    },
  },
  thresholds: {
    hgi_analytics_track_duration: ["p(95)<500"],
    hgi_agent_call_duration: ["p(95)<2000"],
    hgi_error_rate: ["rate<0.01"],
    http_req_failed: ["rate<0.05"],
  },
};

export function analyticsScenario() {
  group("Analytics: track event", () => {
    const payload = JSON.stringify({
      product: "artoies",
      event_name: "load_test_event",
      user_id: `load-user-${__VU}`,
      org_id: TEST_ORG_ID || `load-org-${__VU % 10}`,
      properties: { vu: __VU, iter: __ITER, ts: Date.now() },
    });

    const start = Date.now();
    const res = http.post(`${BASE}/hgi-analytics/track`, payload, {
      headers: { "Content-Type": "application/json" },
      tags: { name: "analytics_track" },
    });

    analyticsTrackDuration.add(Date.now() - start);

    const ok = check(res, {
      "analytics track: status 200": r => r.status === 200,
      "analytics track: tracked=true": r => {
        try { return JSON.parse(r.body).tracked === true; } catch { return false; }
      },
    });
    errorRate.add(!ok);
  });

  sleep(0.1);
}

export function notifyScenario() {
  if (!TEST_ACCESS_TOKEN) return;

  group("Notifications: list", () => {
    const start = Date.now();
    const res = http.get(`${BASE}/hgi-notify/list?limit=20`, {
      headers: { Authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
      tags: { name: "notify_list" },
    });

    notifyDuration.add(Date.now() - start);

    const ok = check(res, {
      "notify list: status 200": r => r.status === 200,
      "notify list: has notifications array": r => {
        try { return Array.isArray(JSON.parse(r.body).notifications); } catch { return false; }
      },
    });
    errorRate.add(!ok);
  });

  sleep(0.2);
}

export function platformScenario() {
  group("Billing: get plans", () => {
    const res = http.get(`${BASE}/hgi-billing/plans`, { tags: { name: "billing_plans" } });
    const ok = check(res, {
      "billing plans: status 200": r => r.status === 200,
      "billing plans: has free plan": r => {
        try { return !!JSON.parse(r.body).plans?.free; } catch { return false; }
      },
    });
    errorRate.add(!ok);
  });

  if (TEST_ACCESS_TOKEN) {
    group("Agents: list active", () => {
      const res = http.get(`${BASE}/hgi-agents/list?status=active`, {
        headers: { Authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
        tags: { name: "agents_list" },
      });
      check(res, { "agents list: status 200": r => r.status === 200 });
    });
  }

  group("Agent heartbeat", () => {
    if (!HGI_SERVICE_KEY) return;
    const res = http.post(`${BASE}/hgi-agents/heartbeat`, JSON.stringify({
      agent_name: "artomind", status: "active", metadata: { load_test: true, vu: __VU },
    }), {
      headers: { "Content-Type": "application/json", "x-hgi-service-key": HGI_SERVICE_KEY },
      tags: { name: "agent_heartbeat" },
    });
    check(res, { "heartbeat: status 200": r => r.status === 200 });
  });

  sleep(0.5);
}
