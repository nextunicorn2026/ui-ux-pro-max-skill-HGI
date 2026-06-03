# HGI Platform — Integration Report
**Date:** 2026-06-03  
**Scope:** Artoies ↔ HGI Platform ↔ Re-Evolve

---

## 1. Integration Overview

The HGI platform integrates three previously independent systems into a unified ecosystem. This report documents the integration points, data flows, shared contracts, and validation status for each connection.

---

## 2. Integration Map

```
┌─────────────────┐     sync/artoies     ┌──────────────────────┐
│    Artoies      │ ──────────────────▶  │                      │
│  (React/Vite)   │                      │   HGI Platform       │
│                 │ ◀──────────────────  │   (Supabase)         │
│  hgi-adapter.ts │   notifications/SSO  │                      │
└────────┬────────┘                      │  hgi-auth            │
         │                               │  hgi-billing         │
         │  SSO token (10 min)           │  hgi-agents          │
         │                               │  hgi-analytics       │
         ↓                               │  hgi-notify          │
┌─────────────────┐     sync/re-evolve   │                      │
│   Re-Evolve     │ ──────────────────▶  │                      │
│  (Next.js 15)   │                      │                      │
│                 │ ◀──────────────────  │                      │
│  hgi-adapter.ts │   agent heartbeats   └──────────────────────┘
└─────────────────┘
```

---

## 3. Integration Points

### 3.1 Artoies → HGI Platform

#### 3.1.1 User Sync
- **Trigger:** Post sign-in (Supabase auth callback)
- **Endpoint:** `POST /hgi-auth/sync/artoies`
- **Auth:** `x-hgi-service-key` header
- **Payload:** `{ user_id, email, display_name, role, vendor_id? }`
- **Result:** Upserts `hgi_users`, creates `hgi_organization` for vendors, inserts `hgi_permissions` with role-mapped HGI role
- **Role mapping:**

| Artoies Role | HGI Role |
|---|---|
| customer | viewer |
| delivery_exec | viewer |
| vendor | member |
| admin | admin |
| founder | owner |

#### 3.1.2 Analytics Events
- **Endpoint:** `POST /hgi-analytics/track`
- **Payload:** `{ product: "artoies", event_name, user_id?, org_id?, properties? }`
- **Error handling:** Fully swallowed. Never interrupts product flow.

#### 3.1.3 SSO Token Issuance
- **Endpoint:** `POST /hgi-auth/sso/issue`
- **Result:** Returns 10-minute single-use token

#### 3.1.4 Agent Calls via HGI Orchestration
- **Endpoint:** `POST /hgi-agents/call`
- **Before call:** Kavacha check (10k chars, banned keywords)
- **Subscription enforcement:** Free plan = 100 calls/month (per org)

#### 3.1.5 Notification Subscription
- **Channel:** Supabase Realtime postgres_changes on `hgi_notifications`
- **Filter:** `user_id=eq.{userId}`

---

### 3.2 Re-Evolve → HGI Platform

#### 3.2.1 User Sync
- **Endpoint:** `POST /hgi-auth/sync/re-evolve`

#### 3.2.2 Agent Registration (at service boot)
- **Endpoint:** `POST /hgi-agents/register`
- **Called by:** Proton, Neutron, Electron services at startup

#### 3.2.3 Agent Heartbeat
- **Trigger:** Health worker, every 60 seconds per agent
- **Endpoint:** `POST /hgi-agents/heartbeat`

#### 3.2.4 SSO Token Redemption
- **Endpoint:** `POST /hgi-auth/sso/redeem`
- **Result:** Returns `{ user_id, target_product, scopes, profile }`. Token is invalidated (single-use).

---

### 3.3 Artoies ↔ Re-Evolve (Direct Cross-Product)

The two products do not call each other directly. All cross-product communication routes through the HGI platform layer:
- **User data:** Via `hgi_users` (shared DB row)
- **Identity:** Via SSO token flow (Artoies issues, Re-Evolve redeems)
- **Agent calls:** Via `/hgi-agents/call` (Kavacha validates all inputs centrally)
- **Notifications:** Via `/hgi-notify/send`

---

## 4. Shared Data Contracts

### 4.1 Analytics Event Schema

```typescript
{
  product: HgiProduct,        // "artoies" | "re-evolve" | ...
  event_name: string,         // snake_case: "artomind_call", "workspace_created"
  user_id?: string,
  org_id?: string,
  session_id?: string,
  properties?: Record<string, unknown>,
  platform?: "web" | "ios" | "android",
}
```

---

## 5. Integration Test Results (Expected)

| Test | Expected Result |
|---|---|
| Artoies user sync → hgi_users row created | PASS |
| Artoies vendor sync → hgi_organization created | PASS |
| SSO token issued by Artoies → redeemable at Re-Evolve | PASS |
| SSO token cannot be redeemed twice | PASS |
| SSO forged token rejected | PASS |
| Free plan enforces 100 call limit | PASS |
| Kavacha blocks "delete" keyword | PASS |
| Kavacha blocks 10,001-char payload | PASS |
| Analytics batch of 5 events → 5 tracked | PASS |
| Notification sent → appears in list | PASS |
| Agent heartbeat → last_heartbeat updated | PASS |
| RLS: user cannot read other user's notifications | PASS |
| RLS: anon cannot read hgi_subscriptions | PASS |

---

## 6. Integration Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `HGI_SERVICE_KEY` leaked in Artoies client bundle | Medium | High | Move sync call to a server-side function; never expose service key to browser |
| Analytics partition fills up | Low | Low | Monthly partition rotation; alert at 80% capacity |
| Kavacha false positive blocks legitimate content | Low | Medium | Review blocked decisions in `hgi_kavacha_decisions`; refine keyword list |
| Re-Evolve agent misses heartbeat window | Medium | Low | Agent status degrades automatically; alert on `status = "degraded"` |
| SSO token window (10 min) too short for slow redirects | Low | Low | Increase to 15 min or implement token refresh |

---

## 7. Next Integration Steps (Post-Beta)

1. Move `VITE_HGI_SERVICE_KEY` from Artoies client to a proxy edge function
2. Add Stripe webhook HMAC signature verification
3. Add Razorpay webhook signature verification
4. Implement Re-Evolve subscription enforcement (usage limits per workspace)
5. Build HGI admin dashboard to view cross-product analytics, agent status, billing
6. Implement cross-product notification preferences (user can opt out per channel)
