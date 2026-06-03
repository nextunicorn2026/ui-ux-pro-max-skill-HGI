import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  HgiSdkConfig, HgiProduct, HgiUser, HgiOrganization,
  HgiPermission, HgiSubscription, HgiSsoToken,
  HgiAnalyticsEvent, HgiNotification, HgiRole,
  HgiAgentCallRequest, HgiAgentCallResponse,
} from './types';

export class HgiClient {
  private supabase: SupabaseClient;
  private product: HgiProduct;

  constructor(config: HgiSdkConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
    this.product = config.product;
  }

  async getSession() {
    const { data, error } = await this.supabase.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async signIn(email: string, password: string) {
    const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async signOut() {
    const { error } = await this.supabase.auth.signOut();
    if (error) throw error;
  }

  onAuthStateChange(callback: (event: string, session: unknown) => void) {
    return this.supabase.auth.onAuthStateChange(callback);
  }

  async getUser(userId: string): Promise<HgiUser | null> {
    const { data, error } = await this.supabase
      .from('hgi_users')
      .select('*')
      .eq('id', userId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async updateUser(userId: string, updates: Partial<HgiUser>): Promise<HgiUser> {
    const { data, error } = await this.supabase
      .from('hgi_users')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async registerProductAccess(userId: string) {
    const { data: user } = await this.supabase
      .from('hgi_users')
      .select('products')
      .eq('id', userId)
      .single();

    const current: HgiProduct[] = user?.products || [];
    if (!current.includes(this.product)) {
      await this.supabase
        .from('hgi_users')
        .update({ products: [...current, this.product] })
        .eq('id', userId);
    }
  }

  async getOrganization(orgId: string): Promise<HgiOrganization | null> {
    const { data, error } = await this.supabase
      .from('hgi_organizations')
      .select('*')
      .eq('id', orgId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async getUserOrg(userId: string): Promise<HgiOrganization | null> {
    const { data: user } = await this.supabase
      .from('hgi_users')
      .select('org_id')
      .eq('id', userId)
      .single();
    if (!user?.org_id) return null;
    return this.getOrganization(user.org_id);
  }

  async getPermissions(userId: string): Promise<HgiPermission[]> {
    const { data, error } = await this.supabase
      .from('hgi_permissions')
      .select('*')
      .eq('user_id', userId);
    if (error) throw error;
    return data || [];
  }

  async hasPermission(userId: string, role: HgiRole, product?: HgiProduct): Promise<boolean> {
    const perms = await this.getPermissions(userId);
    const hierarchy: HgiRole[] = ['owner', 'admin', 'member', 'viewer', 'agent'];
    const userLevel = Math.min(...perms
      .filter(p => !product || p.product === product)
      .map(p => hierarchy.indexOf(p.role))
      .filter(i => i !== -1));
    const requiredLevel = hierarchy.indexOf(role);
    return userLevel <= requiredLevel;
  }

  async getSubscription(orgId: string, product?: HgiProduct): Promise<HgiSubscription | null> {
    const { data, error } = await this.supabase
      .from('hgi_subscriptions')
      .select('*')
      .eq('org_id', orgId)
      .eq('product', product || this.product)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async isSubscriptionActive(orgId: string, product?: HgiProduct): Promise<boolean> {
    const sub = await this.getSubscription(orgId, product);
    return sub?.status === 'active' || sub?.status === 'trialing';
  }

  async issueSsoToken(userId: string, targetProduct: HgiProduct, scopes: string[] = []): Promise<string> {
    const { data, error } = await this.supabase.rpc('hgi_issue_sso_token', {
      p_user_id: userId,
      p_source: this.product,
      p_target: targetProduct,
      p_scopes: scopes,
    });
    if (error) throw error;
    return data as string;
  }

  async redeemSsoToken(token: string): Promise<{ userId: string; targetProduct: HgiProduct; scopes: string[] } | null> {
    const { data, error } = await this.supabase.rpc('hgi_redeem_sso_token', { p_token: token });
    if (error) throw error;
    if (!data || data.length === 0) return null;
    return { userId: data[0].user_id, targetProduct: data[0].target_product, scopes: data[0].scopes };
  }

  async track(event: Omit<HgiAnalyticsEvent, 'product'>): Promise<void> {
    const { error } = await this.supabase
      .from('hgi_analytics_events')
      .insert({ ...event, product: this.product });
    if (error) console.error('[HGI Analytics] Failed to track event:', error.message);
  }

  async getNotifications(userId: string, unreadOnly = false): Promise<HgiNotification[]> {
    let query = this.supabase
      .from('hgi_notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (unreadOnly) query = query.is('read_at', null);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    const { error } = await this.supabase
      .from('hgi_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationId);
    if (error) throw error;
  }

  subscribeToNotifications(userId: string, callback: (notification: HgiNotification) => void) {
    return this.supabase
      .channel(`hgi-notifications-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'hgi_notifications',
        filter: `user_id=eq.${userId}`,
      }, (payload) => callback(payload.new as HgiNotification))
      .subscribe();
  }

  async callAgent(request: HgiAgentCallRequest): Promise<HgiAgentCallResponse> {
    const startMs = Date.now();
    const callId = crypto.randomUUID();

    const { data: agent, error: agentErr } = await this.supabase
      .from('hgi_agent_registry')
      .select('*')
      .eq('name', request.agentName)
      .eq('status', 'active')
      .single();

    if (agentErr || !agent) throw new Error(`Agent '${request.agentName}' not found or offline`);

    await this.supabase.from('hgi_agent_calls').insert({
      id: callId,
      agent_id: agent.id,
      user_id: request.userId,
      org_id: request.orgId,
      session_id: request.sessionId,
      status: 'pending',
    });

    try {
      const resp = await fetch(`${agent.endpoint}${agent.api_path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.input),
      });

      if (!resp.ok) throw new Error(`Agent responded with ${resp.status}`);
      const output = await resp.json();
      const durationMs = Date.now() - startMs;

      await this.supabase.from('hgi_agent_calls').update({
        status: 'success',
        duration_ms: durationMs,
      }).eq('id', callId);

      return { callId, output, durationMs };
    } catch (err) {
      await this.supabase.from('hgi_agent_calls').update({
        status: 'error',
        duration_ms: Date.now() - startMs,
        error_code: (err as Error).message,
      }).eq('id', callId);
      throw err;
    }
  }

  async listAgents(product?: HgiProduct) {
    let query = this.supabase.from('hgi_agent_registry').select('*').eq('status', 'active');
    if (product) query = query.eq('product', product);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  get db() { return this.supabase; }
}

let _client: HgiClient | null = null;
export function createHgiClient(config: HgiSdkConfig): HgiClient {
  _client = new HgiClient(config);
  return _client;
}
export function getHgiClient(): HgiClient {
  if (!_client) throw new Error('HGI SDK not initialized. Call createHgiClient() first.');
  return _client;
}
