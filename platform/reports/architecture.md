# HGI Platform — Architecture Report
**Date:** 2026-06-03  
**Version:** 1.0  
**Status:** Production Design

---

## 1. Executive Summary

HGI (Human-Governed Intelligence) is a multi-product AI platform. The platform layer provides shared infrastructure — authentication, billing, agent orchestration, analytics, notifications, and permissions — that all HGI products consume via a unified SDK and set of edge functions.

**Products:**
| Product | Role | Status |
|---|---|---|
| HGI Platform | Infrastructure layer | Production-ready |
| Artoies | Automotive AI OS (Product #2) | Partial beta |
| Re-Evolve | AI Workspace (Product #1) | Beta-ready |
| Imagin | Creative AI | Roadmap |
| KAVACHA | Security Intelligence | Roadmap |

---

## 2. System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                             │
│  Artoies (React/Capacitor)    Re-Evolve (Next.js 15/Turborepo)  │
│  iOS + Android + Web          Web SaaS + Agent API              │
└────────────────┬────────────────────────────┬───────────┘
                 │ @hgi/sdk                    │ @hgi/sdk
                 ↓                             ↓
┌─────────────────────────────────────────────────────────────────┐
│                    HGI PLATFORM LAYER                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Supabase Edge Functions (Deno)              │   │
│  │  hgi-auth  │  hgi-billing  │  hgi-agents  │  hgi-notify  │   │
│  │            │               │              │  hgi-analytics│   │
│  └────────────┬───────────────┬──────────────┬──────────────┘   │
│             │               │              │                   │
│  ┌────────────↓───────────────↓──────────────↓───────────┐   │
│  │            Supabase PostgreSQL (Shared DB)                │   │
│  │  hgi_organizations   hgi_users       hgi_permissions      │   │
│  │  hgi_subscriptions   hgi_sso_tokens  hgi_audit_log        │   │
│  │  hgi_agent_registry  hgi_agent_calls hgi_agent_heartbeats │   │
│  │  hgi_analytics_events (partitioned)  hgi_notifications    │   │
│  │  hgi_kavacha_decisions  hgi_re_evolve_workspaces          │   │
│  │  hgi_artoies_vendor_orgs                                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌─────────────┼─────────────┐
              ↓               ↓               ↓
     ┌───────────┐  ┌───────────┐  ┌────────────┐
     │  ArtoMind   │  │   Proton    │  │   Neutron    │
     │  (Artoies)  │  │ (Re-Evolve) │  │ (Re-Evolve)  │
     │  Gemini 3   │  │ Claude API  │  │ Claude API   │
     └───────────┘  └───────────┘  └────────────┘
```

---

## 3. Shared Platform Services

### 3.1 Authentication (hgi-auth)

**Architecture:** Supabase Auth as identity provider. Single sign-on tokens issued as cryptographically random UUIDs stored in `hgi_sso_tokens` with 10-minute TTL. Token redemption is single-use.

**Flows:**
- **New user:** Auth trigger `hgi_handle_new_user()` auto-creates `hgi_users` row on signup
- **Product sync:** Products call `/sync/{product}` with service key to register users and map roles
- **SSO:** Artoies calls `/sso/issue` → gets token → passes to Re-Evolve → Re-Evolve calls `/sso/redeem`
- **User profile:** `/user` returns full profile with org, permissions, and subscriptions joined

**Security:** JWT validation via Supabase, service-to-service via `HGI_SERVICE_KEY` (env var), CORS locked to `*` with plans to restrict to known origins.

### 3.2 Billing (hgi-billing)

**Plans:**
| Plan | INR/month | USD/month | Agent Calls | Products |
|---|---|---|---|---|
| Free | ₹0 | $0 | 100 | 1 |
| Starter | ₹999 | $12 | 1,000 | 2 |
| Pro | ₹2,999 | $35 | 10,000 | 5 |
| Enterprise | ₹9,999 | $120 | Unlimited | Unlimited |

**Payment:** Stripe (global) + Razorpay (India). Webhooks update `hgi_subscriptions` with Stripe metadata (`hgi_org_id`, `hgi_product`, `hgi_plan`). Free plan downgrades are instant with no payment.

### 3.3 Agent Orchestration (hgi-agents)

**Registry:** `hgi_agent_registry` stores all agents across products. Agents self-register via `/register` with service key. Seeded agents: `artomind`, `proton`, `neutron`, `electron`.

**Call flow:**
1. Client calls `/call` with `agent_name`, `input`, `org_id`
2. Kavacha validation (banned keywords + payload size)
3. Subscription limit check (monthly call count vs plan limit)
4. Agent endpoint proxied with `x-hgi-call-id`, `x-hgi-user-id`, `x-hgi-org-id` headers
5. Token counts extracted from agent response
6. Call record updated in `hgi_agent_calls` (status, duration, tokens)

**Kavacha Governance:**
- Banned keywords: `delete`, `shutdown`, `drop`, `kill`, `format`, `rm -rf`
- Max payload: 10,000 characters
- All decisions logged to `hgi_kavacha_decisions` with SHA-256 payload hash

### 3.4 Analytics (hgi-analytics)

**Storage:** `hgi_analytics_events` partitioned by month (2026-06 through 2026-12).

**Ingest:** `/track` (single event) and `/batch` (up to 100 events). Analytics failures are swallowed.

**Query API (admin/service only):** `/query`, `/funnel`, `/retention`, `/top-events`

### 3.5 Notifications (hgi-notify)

**Channels:** In-app (always), email (via Resend), SMS (via Twilio).

**In-app:** Stored in `hgi_notifications`, delivered via Supabase Realtime.

### 3.6 Permissions

**Role hierarchy:** `owner > admin > member > viewer > agent`

**RLS:** Every table has Row Level Security. Service role bypasses RLS for cross-product operations.

---

## 4. Data Architecture

### 4.1 Key Tables

```
hgi_organizations     — tenant root, holds plan + slug
hgi_users             — cross-product user profile, linked to auth.users
hgi_permissions       — RBAC join: user × org × product × role
hgi_subscriptions     — billing state: org × product × plan
hgi_sso_tokens        — ephemeral cross-product auth tokens (10 min TTL)
hgi_agent_registry    — agent catalog with endpoint + capabilities
hgi_agent_calls       — immutable call log with tokens + duration
hgi_agent_heartbeats  — agent health time series
hgi_kavacha_decisions — governance audit trail
hgi_analytics_events  — partitioned event log (monthly)
hgi_notifications     — in-app notification queue
hgi_audit_log         — compliance event log
```

### 4.2 Product-Specific Bridge Tables

```
hgi_artoies_vendor_orgs      — maps Artoies vendor_id → hgi_organization
hgi_re_evolve_workspaces     — Re-Evolve workspace metadata within HGI
```

---

## 5. SDK Architecture (`@hgi/sdk`)

**Package:** `@hgi/sdk` v0.1.0 (TypeScript, ESM + CJS via tsup)

**Design:** Single `HgiClient` class instantiated with `{ supabaseUrl, supabaseAnonKey, product }`. Singleton pattern via `createHgiClient()` / `getHgiClient()`.

**Surface area:**
- Auth: `getSession`, `signIn`, `signOut`, `onAuthStateChange`
- Users: `getUser`, `updateUser`, `registerProductAccess`
- Orgs: `getOrganization`, `getUserOrg`
- Permissions: `getPermissions`, `hasPermission`
- Subscriptions: `getSubscription`, `isSubscriptionActive`
- SSO: `issueSsoToken`, `redeemSsoToken`
- Analytics: `track` (swallows errors)
- Notifications: `getNotifications`, `markNotificationRead`, `subscribeToNotifications`
- Agents: `callAgent`, `listAgents`

---

## 6. Security Architecture

| Layer | Control |
|---|---|
| Network | CORS headers on all edge functions |
| Auth | JWT via Supabase Auth, service key for server-to-server |
| Data | RLS on every table, no public write access |
| Governance | Kavacha (keyword ban + size limit) on every agent call |
| Audit | `hgi_audit_log` + `hgi_kavacha_decisions` + `hgi_agent_heartbeats` |
| SSO | Single-use tokens, 10-minute TTL, stored hash |

---

## 7. Infrastructure Requirements

```
SUPABASE_URL                    # Supabase project URL
SUPABASE_ANON_KEY               # Public anon key
SUPABASE_SERVICE_ROLE_KEY       # Service role (edge functions only)
HGI_SERVICE_KEY                 # Shared secret for product-to-product calls
STRIPE_SECRET_KEY               # Stripe payments
STRIPE_WEBHOOK_SECRET           # Stripe webhook validation
RESEND_API_KEY                  # Email notifications (optional)
TWILIO_ACCOUNT_SID              # SMS notifications (optional)
TWILIO_AUTH_TOKEN               # SMS notifications (optional)
TWILIO_FROM_NUMBER              # SMS from number (optional)
```

---

## 8. Design Decisions & Rationale

| Decision | Rationale |
|---|---|
| Single Supabase project | Shared auth across products with zero token exchange overhead |
| Edge functions over microservices | No cold-start infra, auto-scaling, co-located with DB |
| Kavacha at orchestration layer | Not bypassable by individual product teams; centralized audit |
| Monthly analytics partitions | Fast time-range queries; old partitions can be archived/dropped |
| Service key for product sync | Products are trusted internal callers; JWT overkill for server-to-server |
| Free plan allows 100 calls | Enough for individual users to evaluate; metered at org level |
| SSO token single-use | Prevents replay attacks; 10 min window balances UX and security |
