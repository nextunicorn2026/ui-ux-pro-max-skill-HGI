// HGI Platform — Billing & Subscriptions Edge Function

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

const PLANS = {
  free: { price_inr: 0, price_usd: 0, agent_calls_per_month: 100, products: 1 },
  starter: { price_inr: 999, price_usd: 12, agent_calls_per_month: 1000, products: 2 },
  pro: { price_inr: 2999, price_usd: 35, agent_calls_per_month: 10000, products: 5 },
  enterprise: { price_inr: 9999, price_usd: 120, agent_calls_per_month: -1, products: -1 },
} as const;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const path = url.pathname.replace("/hgi-billing", "");

  try {
    switch (path) {
      case "/plans": return handleGetPlans();
      case "/subscribe": return handleSubscribe(req);
      case "/cancel": return handleCancel(req);
      case "/status": return handleStatus(req);
      case "/usage": return handleUsage(req);
      case "/webhook/stripe": return handleStripeWebhook(req);
      case "/webhook/razorpay": return handleRazorpayWebhook(req);
      default:
        return json({ error: "Unknown path" }, 404);
    }
  } catch (err) {
    console.error("[hgi-billing]", err);
    return json({ error: (err as Error).message }, 500);
  }
});

function handleGetPlans() {
  return json({ plans: PLANS });
}

async function handleSubscribe(req: Request): Promise<Response> {
  const user = await requireAuth(req);
  const { org_id, product, plan, payment_method } = await req.json();

  if (!org_id || !product || !plan) return json({ error: "org_id, product, and plan required" }, 400);
  if (!(plan in PLANS)) return json({ error: "Invalid plan" }, 400);

  const { data: perm } = await supabase
    .from("hgi_permissions")
    .select("role")
    .eq("user_id", user.id)
    .eq("org_id", org_id)
    .in("role", ["owner", "admin"])
    .single();

  if (!perm) return json({ error: "Insufficient permissions" }, 403);

  if (plan === "free") {
    const { data, error } = await supabase
      .from("hgi_subscriptions")
      .upsert({
        org_id, product, plan: "free", status: "active",
        current_period_start: new Date().toISOString(),
        current_period_end: null,
      }, { onConflict: "org_id,product" })
      .select()
      .single();
    if (error) throw error;
    return json({ subscription: data, payment_required: false });
  }

  const checkoutUrl = await createCheckoutSession({
    orgId: org_id, product, plan, userId: user.id, paymentMethod: payment_method || "stripe",
  });

  return json({ checkout_url: checkoutUrl, payment_required: true });
}

async function handleCancel(req: Request): Promise<Response> {
  const user = await requireAuth(req);
  const { org_id, product } = await req.json();

  const { error } = await supabase
    .from("hgi_subscriptions")
    .update({ status: "canceled", canceled_at: new Date().toISOString() })
    .eq("org_id", org_id)
    .eq("product", product);

  if (error) throw error;

  await auditLog(user.id, product, "subscription.cancel", org_id);
  return json({ canceled: true });
}

async function handleStatus(req: Request): Promise<Response> {
  await requireAuth(req);
  const orgId = new URL(req.url).searchParams.get("org_id");
  const product = new URL(req.url).searchParams.get("product");

  if (!orgId) return json({ error: "org_id required" }, 400);

  let query = supabase.from("hgi_subscriptions").select("*").eq("org_id", orgId);
  if (product) query = query.eq("product", product);

  const { data, error } = await query;
  if (error) throw error;

  return json({ subscriptions: data });
}

async function handleUsage(req: Request): Promise<Response> {
  await requireAuth(req);
  const orgId = new URL(req.url).searchParams.get("org_id");

  if (!orgId) return json({ error: "org_id required" }, 400);

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data: calls, error } = await supabase
    .from("hgi_agent_calls")
    .select("id, agent_id, tokens_in, tokens_out, created_at")
    .eq("org_id", orgId)
    .gte("created_at", startOfMonth.toISOString())
    .eq("status", "success");

  if (error) throw error;

  return json({
    usage: {
      agent_calls: calls?.length || 0,
      tokens_consumed: (calls || []).reduce((sum, c) => sum + (c.tokens_in || 0) + (c.tokens_out || 0), 0),
      period_start: startOfMonth.toISOString(),
    },
  });
}

async function handleStripeWebhook(req: Request): Promise<Response> {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!signature || !webhookSecret) return json({ error: "Invalid webhook" }, 400);

  const body = await req.text();
  const event = JSON.parse(body);

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const orgId = sub.metadata?.hgi_org_id;
      const product = sub.metadata?.hgi_product;
      if (orgId && product) {
        await supabase.from("hgi_subscriptions").upsert({
          org_id: orgId, product,
          plan: sub.metadata?.hgi_plan || "pro",
          status: sub.status,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        }, { onConflict: "org_id,product" });
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      await supabase.from("hgi_subscriptions")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("stripe_subscription_id", sub.id);
      break;
    }
  }

  return json({ received: true });
}

async function handleRazorpayWebhook(req: Request): Promise<Response> {
  const body = await req.json();
  if (body.event === "subscription.activated") {
    const sub = body.payload.subscription.entity;
    const orgId = sub.notes?.hgi_org_id;
    const product = sub.notes?.hgi_product;
    if (orgId && product) {
      await supabase.from("hgi_subscriptions").upsert({
        org_id: orgId, product,
        plan: sub.notes?.hgi_plan || "pro",
        status: "active",
        razorpay_subscription_id: sub.id,
        razorpay_customer_id: sub.customer_id,
      }, { onConflict: "org_id,product" });
    }
  }
  return json({ received: true });
}

async function createCheckoutSession({ orgId, product, plan, userId, paymentMethod }: {
  orgId: string; product: string; plan: string; userId: string; paymentMethod: string;
}): Promise<string> {
  const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
  if (!STRIPE_KEY) {
    return `https://hgi.app/billing/checkout?org=${orgId}&product=${product}&plan=${plan}`;
  }
  return `https://hgi.app/billing/checkout?session=pending`;
}

async function requireAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Unauthorized");
  const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user) throw new Error("Invalid token");
  return user;
}

async function auditLog(actorId: string, product: string, action: string, resourceId: string) {
  await supabase.from("hgi_audit_log").insert({
    actor_id: actorId, product, action, resource_type: "subscription", resource_id: resourceId,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
