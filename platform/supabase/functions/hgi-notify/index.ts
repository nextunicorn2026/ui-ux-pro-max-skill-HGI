// HGI Platform — Notifications Edge Function

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
  const path = url.pathname.replace("/hgi-notify", "");

  try {
    switch (path) {
      case "/send": return handleSend(req);
      case "/broadcast": return handleBroadcast(req);
      case "/list": return handleList(req);
      case "/read": return handleRead(req);
      case "/dismiss": return handleDismiss(req);
      case "/unread-count": return handleUnreadCount(req);
      default:
        return json({ error: "Unknown path" }, 404);
    }
  } catch (err) {
    console.error("[hgi-notify]", err);
    return json({ error: (err as Error).message }, 500);
  }
});

async function handleSend(req: Request): Promise<Response> {
  await requireServiceKey(req);
  const body = await req.json();
  const { user_id, product, type, title, body: notifBody, action_url, metadata, channels = ["in-app"] } = body;

  if (!user_id || !product || !type || !title) {
    return json({ error: "user_id, product, type, and title required" }, 400);
  }

  const validTypes = ["info", "success", "warning", "error", "agent"];
  if (!validTypes.includes(type)) return json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` }, 400);

  const { data: notif, error } = await supabase.from("hgi_notifications").insert({
    user_id, product, type, title,
    body: notifBody || null, action_url: action_url || null, metadata: metadata || {},
  }).select().single();

  if (error) throw error;

  const dispatched: string[] = ["in-app"];
  const failures: Array<{ channel: string; error: string }> = [];

  if (channels.includes("email")) {
    try {
      await sendEmail(user_id, title, notifBody || "", action_url, product);
      dispatched.push("email");
    } catch (e) {
      failures.push({ channel: "email", error: (e as Error).message });
    }
  }

  if (channels.includes("sms")) {
    try {
      await sendSms(user_id, title, product);
      dispatched.push("sms");
    } catch (e) {
      failures.push({ channel: "sms", error: (e as Error).message });
    }
  }

  return json({ notification_id: notif.id, dispatched, failures });
}

async function handleBroadcast(req: Request): Promise<Response> {
  await requireServiceKey(req);
  const { product, org_id, type, title, body: notifBody, action_url, metadata } = await req.json();

  if (!product || !type || !title) return json({ error: "product, type, and title required" }, 400);

  let query = supabase.from("hgi_users").select("id").contains("products", [product]);
  if (org_id) query = query.eq("org_id", org_id);

  const { data: users, error: usersErr } = await query;
  if (usersErr) throw usersErr;
  if (!users || users.length === 0) return json({ sent: 0 });

  const rows = users.map(u => ({
    user_id: u.id, product, type, title,
    body: notifBody || null, action_url: action_url || null, metadata: metadata || {},
  }));

  const { error } = await supabase.from("hgi_notifications").insert(rows);
  if (error) throw error;

  return json({ sent: rows.length, product, org_id: org_id || null });
}

async function handleList(req: Request): Promise<Response> {
  const user = await requireAuth(req);
  const url = new URL(req.url);
  const product = url.searchParams.get("product");
  const unreadOnly = url.searchParams.get("unread_only") === "true";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);

  let query = supabase
    .from("hgi_notifications")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (product) query = query.eq("product", product);
  if (unreadOnly) query = query.is("read_at", null);

  const { data, error } = await query;
  if (error) throw error;

  return json({ notifications: data || [] });
}

async function handleRead(req: Request): Promise<Response> {
  const user = await requireAuth(req);
  const { notification_id } = await req.json();

  if (!notification_id) return json({ error: "notification_id required" }, 400);

  const { error } = await supabase
    .from("hgi_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notification_id)
    .eq("user_id", user.id);

  if (error) throw error;
  return json({ read: true });
}

async function handleDismiss(req: Request): Promise<Response> {
  const user = await requireAuth(req);
  const { notification_id } = await req.json();

  if (!notification_id) return json({ error: "notification_id required" }, 400);

  const { error } = await supabase
    .from("hgi_notifications")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", notification_id)
    .eq("user_id", user.id);

  if (error) throw error;
  return json({ dismissed: true });
}

async function handleUnreadCount(req: Request): Promise<Response> {
  const user = await requireAuth(req);
  const url = new URL(req.url);
  const product = url.searchParams.get("product");

  let query = supabase
    .from("hgi_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("read_at", null)
    .is("dismissed_at", null);

  if (product) query = query.eq("product", product);

  const { count, error } = await query;
  if (error) throw error;

  return json({ unread: count || 0 });
}

async function sendEmail(userId: string, subject: string, body: string, actionUrl: string | null, product: string) {
  const { data: user } = await supabase.from("hgi_users").select("email").eq("id", userId).single();
  if (!user?.email) return;

  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_KEY) {
    console.log(`[hgi-notify] Email skipped (no RESEND_API_KEY): ${user.email} — ${subject}`);
    return;
  }

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
      <h2 style="color:#0B2A45">${subject}</h2>
      <p style="color:#333">${body}</p>
      ${actionUrl ? `<a href="${actionUrl}" style="display:inline-block;background:#F2B21B;color:#0B2A45;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">View</a>` : ""}
      <p style="font-size:12px;color:#999;margin-top:24px">HGI Platform · ${product}</p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "HGI Platform <noreply@hgi.app>", to: [user.email], subject, html }),
  });
}

async function sendSms(userId: string, message: string, product: string) {
  const { data: user } = await supabase.from("hgi_users").select("phone").eq("id", userId).single();
  if (!user?.phone) return;

  const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
  const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER");

  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    console.log(`[hgi-notify] SMS skipped (no Twilio config): ${user.phone} — ${message}`);
    return;
  }

  const body = new URLSearchParams({
    From: TWILIO_FROM, To: user.phone,
    Body: `[HGI/${product.toUpperCase()}] ${message}`,
  });

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

async function requireAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Unauthorized");
  const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error } = await supabaseAuth.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user) throw new Error("Invalid token");
  return user;
}

async function requireServiceKey(req: Request) {
  const key = req.headers.get("x-hgi-service-key");
  const expected = Deno.env.get("HGI_SERVICE_KEY");
  if (!expected || key !== expected) throw new Error("Forbidden: invalid service key");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
