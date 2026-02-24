import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../models/types';

export function getSupabaseClient(env: Env): SupabaseClient {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles';
}
