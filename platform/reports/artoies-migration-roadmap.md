# Artoies → HGI Full Migration Roadmap
**Date:** 2026-06-03  
**Current State:** Partial beta integration (adapter installed, sync + analytics wired)  
**Target State:** Artoies fully native on HGI platform — auth, billing, agents, notifications all through HGI

---

## Phase Overview

| Phase | Name | Timeline | Status |
|---|---|---|---|
| 0 | HGI Platform Build | May 2026 | COMPLETE |
| 1 | Partial Beta Integration | June 2026 | IN PROGRESS |
| 2 | Auth Migration | July 2026 | PLANNED |
| 3 | Billing Migration | August 2026 | PLANNED |
| 4 | Agent Migration | September 2026 | PLANNED |
| 5 | Full Native Integration | October 2026 | PLANNED |
| 6 | Deprecation & Cleanup | November 2026 | PLANNED |

---

## Phase 1: Partial Beta Integration (June 2026)

**Status:** In Progress  
**Deliverables completed:**
- HGI platform schema (3 migrations)
- 5 edge functions deployed
- `@hgi/sdk` TypeScript package
- Artoies adapter (`adapters/artoies/hgi-adapter.ts`)
- Integration, security, load, and agent-comms test suites

**Remaining Phase 1 tasks:**
- [ ] Wire `syncArtoiesUserToHgi()` into Artoies `useAuth` hook (post sign-in)
- [ ] Wire `trackHgiEvent()` into ArtoMind call, booking confirmation, page nav
- [ ] Wire `subscribeToHgiNotifications()` in CustomerHome + VendorDashboard
- [ ] Set HGI env vars in Artoies staging build
- [ ] Run smoke tests against staging Supabase
- [ ] Deploy to staging + verify

---

## Phase 2: Auth Migration (July 2026)

**Goal:** Artoies uses HGI auth as the single identity source.

### 2.1 Replace local role checks

```typescript
// Before
const role = user.user_metadata?.role;

// After
const hgiRole = await getUserHgiRole(user.id); // reads hgi_permissions
```

### 2.2 Remove duplicate user profile table

Migrate all fields to `hgi_users` and deprecate the Artoies-specific table.

### 2.3 SSO for cross-product navigation

1. Call `issueHgiSsoToken("re-evolve")`
2. Redirect to Re-Evolve URL with `?sso_token=...`

**Effort estimate:** 2 weeks  
**Risk:** Medium — role logic changes require thorough QA across all 5 Artoies portals

---

## Phase 3: Billing Migration (August 2026)

**Goal:** Artoies subscription and usage enforced through HGI billing.

### 3.1 Map Artoies vendor tiers to HGI plans

| Artoies Tier | HGI Plan | ArtoMind Calls/Month |
|---|---|---|
| Free vendor | free | 100 |
| Basic vendor | starter | 1,000 |
| Pro vendor | pro | 10,000 |
| Enterprise fleet | enterprise | Unlimited |

### 3.2 Enforce ArtoMind call limits

Replace direct ArtoMind calls with HGI-proxied calls via `/hgi-agents/call`.

### 3.3 Stripe integration for vendor subscriptions

Wire Artoies vendor upgrade flow through `POST /hgi-billing/subscribe`.

**Effort estimate:** 3 weeks  
**Risk:** High — billing changes require staged rollout with fallback.

---

## Phase 4: Agent Migration (September 2026)

**Goal:** ArtoMind calls route exclusively through HGI agent orchestration.

### 4.1 Register ArtoMind as HGI agent

```typescript
await registerHgiAgent({
  name: "artomind",
  endpoint: "https://<supabase-project>.supabase.co/functions/v1",
  apiPath: "/ask-artoies",
  capabilities: ["automotive-qa", "multilingual", "streaming"],
  model: "google/gemini-3-flash-preview",
  version: "2.0.0",
});
```

### 4.2 Update AskArtoiesPage

```typescript
// Before: direct to ask-artoies
const resp = await supabase.functions.invoke("ask-artoies", { body: { message } });

// After: via HGI orchestration (Kavacha + metering included)
const result = await callArtoMindViaHgi({ input: { message }, orgId, sessionId });
```

**Effort estimate:** 2 weeks  
**Risk:** Low — existing ask-artoies edge function continues working during transition.

---

## Phase 5: Full Native Integration (October 2026)

**Goal:** Artoies is a first-class HGI product.

- HGI Admin Dashboard at `/admin/hgi` showing cross-product analytics
- Unified notification center powered by `subscribeToHgiNotifications()`
- Organization management via `hgi_organizations`
- Multi-product user switcher with SSO

**Effort estimate:** 4 weeks  
**Risk:** Low — additive features only

---

## Phase 6: Deprecation & Cleanup (November 2026)

```sql
-- Drop Artoies-local tables that have been migrated
DROP TABLE IF EXISTS artoies_profiles;
DROP TABLE IF EXISTS artoies_subscriptions;

-- Verify all user data is in hgi_users
SELECT COUNT(*) FROM auth.users u
LEFT JOIN hgi_users h ON h.id = u.id
WHERE h.id IS NULL; -- Should return 0
```

**Effort estimate:** 2 weeks  
**Risk:** Low — cleanup only

---

## Total Effort Estimate

| Phase | Weeks |
|---|---|
| Phase 1 (partial beta) | 2 |
| Phase 2 (auth) | 2 |
| Phase 3 (billing) | 3 |
| Phase 4 (agents) | 2 |
| Phase 5 (full native) | 4 |
| Phase 6 (cleanup) | 2 |
| **Total** | **15 weeks** |

**Earliest full migration complete:** November 2026  
**Critical path:** Phase 3 (billing) is the longest and highest-risk phase. Start early.

---

## Migration Decision Log

| Decision | Rationale |
|---|---|
| Keep ask-artoies edge function, register as HGI agent | Less disruption than rewriting. |
| Vendor org = HGI org (1:1) | Vendors in Artoies are single-brand operators. |
| Migrate billing last | Highest risk. Billing must be solid before switching payment flows. |
| Keep Artoies Supabase tables | Only platform concerns (users, billing, agents) migrate. Product data stays in Artoies schema. |
| SSO via token (not shared session) | Clean separation: each product validates its own JWTs. |
