// ── HGI Platform — Shared Type Definitions ──────────────────────────────────

export type HgiProduct = 'artoies' | 're-evolve' | 'imagin' | 'kavacha' | 'platform';
export type HgiPlan = 'free' | 'starter' | 'pro' | 'enterprise';
export type HgiRole = 'owner' | 'admin' | 'member' | 'viewer' | 'agent';
export type HgiSubStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused';
export type HgiAgentStatus = 'active' | 'degraded' | 'offline' | 'maintenance';
export type HgiNotifType = 'info' | 'success' | 'warning' | 'error' | 'agent';

export interface HgiOrganization {
  id: string;
  name: string;
  slug: string;
  plan: HgiPlan;
  logo_url?: string;
  website?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface HgiUser {
  id: string;
  email: string;
  display_name?: string;
  avatar_url?: string;
  phone?: string;
  org_id?: string;
  products: HgiProduct[];
  last_seen_at?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface HgiPermission {
  id: string;
  user_id: string;
  org_id?: string;
  product?: HgiProduct;
  role: HgiRole;
  granted_by?: string;
  granted_at: string;
  expires_at?: string;
}

export interface HgiSubscription {
  id: string;
  org_id: string;
  product: HgiProduct;
  plan: HgiPlan;
  status: HgiSubStatus;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  trial_ends_at?: string;
  current_period_start?: string;
  current_period_end?: string;
  canceled_at?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface HgiAgent {
  id: string;
  name: string;
  display_name: string;
  product: HgiProduct;
  endpoint: string;
  api_path: string;
  capabilities: string[];
  model?: string;
  status: HgiAgentStatus;
  last_heartbeat?: string;
  version: string;
  metadata: Record<string, unknown>;
}

export interface HgiAgentCall {
  id: string;
  agent_id: string;
  user_id?: string;
  org_id?: string;
  session_id?: string;
  status: 'pending' | 'success' | 'error' | 'blocked';
  blocked_reason?: string;
  tokens_in?: number;
  tokens_out?: number;
  duration_ms?: number;
  error_code?: string;
  created_at: string;
}

export interface HgiAnalyticsEvent {
  user_id?: string;
  org_id?: string;
  product: HgiProduct;
  event_name: string;
  session_id?: string;
  properties?: Record<string, unknown>;
  device?: string;
  platform?: 'web' | 'ios' | 'android';
}

export interface HgiNotification {
  id: string;
  user_id: string;
  product: HgiProduct;
  type: HgiNotifType;
  title: string;
  body?: string;
  action_url?: string;
  read_at?: string;
  dismissed_at?: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface HgiSsoToken {
  token: string;
  source_product: HgiProduct;
  target_product: HgiProduct;
  scopes: string[];
  expires_at: string;
}

export interface HgiSdkConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  product: HgiProduct;
}

export interface HgiAgentCallRequest {
  agentName: string;
  input: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
  orgId?: string;
}

export interface HgiAgentCallResponse {
  callId: string;
  output: unknown;
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
  blocked?: boolean;
  blockedReason?: string;
}
