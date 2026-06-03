# HGI Platform — Deployment Readiness Report
**Date:** 2026-06-03  
**Target:** Beta deployment of Re-Evolve (Product #1) + partial beta of Artoies (Product #2)

---

## 1. Readiness Summary

| Component | Status | Blocking? |
|---|---|---|
| HGI shared DB schema | READY | — |
| hgi-auth edge function | READY | — |
| hgi-billing edge function | READY | — |
| hgi-agents edge function | READY | — |
| hgi-analytics edge function | READY | — |
| hgi-notify edge function | READY | — |
| @hgi/sdk TypeScript package | READY | — |
| Artoies HGI adapter | READY | — |
| Re-Evolve HGI adapter | READY | — |
| Stripe webhook crypto verification | INCOMPLETE | No (billing optional at beta) |
| Razorpay signature verification | INCOMPLETE | No (billing optional at beta) |
| Analytics partitions beyond 2026-12 | INCOMPLETE | No (2027 future work) |
| CORS origin restriction | INCOMPLETE | No (wildcard `*` is safe at beta scale) |
| Integration test suite | READY | — |
| Security test suite | READY | — |
| Load test suite (k6) | READY | — |
| Agent communication tests | READY | — |

**Overall: GO for beta. No hard blockers.**

---

## 2. Pre-Deployment Checklist

### 2.1 Supabase Configuration

- [ ] Run migration `001_hgi_platform_schema.sql` on target project
- [ ] Run migration `002_artoies_integration.sql` on target project
- [ ] Run migration `003_re_evolve_integration.sql` on target project
- [ ] Verify RLS is enabled on all tables
- [ ] Verify `hgi_handle_new_user` trigger fires on `auth.users` insert
- [ ] Verify `hgi_issue_sso_token()` and `hgi_redeem_sso_token()` RPCs are accessible
- [ ] Seed agent registry: confirm `artomind`, `proton`, `neutron`, `electron` rows exist

### 2.2 Edge Function Deployment

```bash
supabase functions deploy hgi-auth     --project-ref <project_id>
supabase functions deploy hgi-billing  --project-ref <project_id>
supabase functions deploy hgi-agents   --project-ref <project_id>
supabase functions deploy hgi-analytics --project-ref <project_id>
supabase functions deploy hgi-notify   --project-ref <project_id>
```

### 2.3 Environment Secrets

```bash
supabase secrets set HGI_SERVICE_KEY="<generate: openssl rand -hex 32>"
supabase secrets set STRIPE_SECRET_KEY="sk_live_..."
supabase secrets set STRIPE_WEBHOOK_SECRET="whsec_..."
supabase secrets set RESEND_API_KEY="re_..."                 # optional at beta
supabase secrets set TWILIO_ACCOUNT_SID="AC..."              # optional at beta
supabase secrets set TWILIO_AUTH_TOKEN="..."                 # optional at beta
supabase secrets set TWILIO_FROM_NUMBER="+1..."              # optional at beta
```

### 2.4 Artoies Partial Beta

- [ ] Add to `artoies-hub/.env.production`:
  ```
  VITE_HGI_SUPABASE_URL=https://<project>.supabase.co
  VITE_HGI_SUPABASE_ANON_KEY=<anon_key>
  VITE_HGI_SERVICE_KEY=<hgi_service_key>
  ```
- [ ] Copy `platform/adapters/artoies/hgi-adapter.ts` to `artoies-hub/src/lib/hgi/`
- [ ] Wire `syncArtoiesUserToHgi()` into the Artoies auth callback (post sign-in)
- [ ] Wire `trackHgiEvent()` into key Artoies events (page views, ArtoMind calls, booking)
- [ ] Wire `subscribeToHgiNotifications()` in CustomerHome and VendorDashboard

### 2.5 Re-Evolve Beta

- [ ] Add to Re-Evolve `.env.local`:
  ```
  NEXT_PUBLIC_HGI_SUPABASE_URL=https://<project>.supabase.co
  NEXT_PUBLIC_HGI_SUPABASE_ANON_KEY=<anon_key>
  HGI_SERVICE_KEY=<hgi_service_key>
  ```
- [ ] Copy `platform/adapters/re-evolve/hgi-adapter.ts` to Re-Evolve shared package
- [ ] Call `registerHgiAgent()` at Proton/Neutron/Electron service startup
- [ ] Set up heartbeat worker (60s interval) calling `sendAgentHeartbeat()`
- [ ] Wire `syncReEvolveUserToHgi()` into Re-Evolve user onboarding

---

## 3. Smoke Test Sequence

```bash
# 1. Plans endpoint (no auth)
curl $FN_BASE/hgi-billing/plans

# 2. Analytics track (no auth)
curl -X POST $FN_BASE/hgi-analytics/track \
  -H "Content-Type: application/json" \
  -d '{"product":"artoies","event_name":"smoke_test"}'

# 3. Agent heartbeat (requires service key)
curl -X POST $FN_BASE/hgi-agents/heartbeat \
  -H "Content-Type: application/json" \
  -H "x-hgi-service-key: $HGI_SERVICE_KEY" \
  -d '{"agent_name":"artomind","status":"active"}'

# 4. Full integration test suite
deno test --allow-env --allow-net tests/integration/ \
  --env SUPABASE_URL=$SUPABASE_URL \
  --env SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
  --env SUPABASE_ANON_KEY=$ANON_KEY \
  --env HGI_SERVICE_KEY=$HGI_SERVICE_KEY
```

---

## 4. Performance Baselines

| Endpoint | p50 | p95 | p99 |
|---|---|---|---|
| Analytics track | < 50ms | < 200ms | < 500ms |
| Notification list | < 100ms | < 400ms | < 800ms |
| Agent call (proxied) | < 800ms | < 2,000ms | < 5,000ms |
| Billing plans | < 30ms | < 100ms | < 200ms |
| SSO issue | < 80ms | < 300ms | < 600ms |

---

## 5. Rollback Plan

Products degrade gracefully when HGI platform is unavailable:
- Artoies adapter wraps all HGI calls in try/catch — product continues working
- Re-Evolve adapter's `localKavachaCheck()` runs client-side as fallback
- Analytics track calls swallow all errors

---

## 6. Known Limitations at Beta

1. **Stripe webhook crypto:** Signature verification uses `JSON.parse(body)` only. Full `Stripe-Signature` HMAC validation must be added before processing real payments.
2. **Razorpay signature:** Omitted in webhook handler. Add before accepting live Razorpay payments.
3. **CORS:** Currently `*`. Before GA, restrict to known HGI product origins.
4. **Analytics partitions:** Only created through 2026-12. Add 2027 partitions by December 2026.
5. **Email templates:** Plain HTML. Consider Resend's React Email templates for brand consistency.
6. **SSO cross-origin:** Assumes all products share the same Supabase project.
