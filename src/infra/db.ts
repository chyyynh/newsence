import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../models/types';

export function getSupabaseClient(env: Env): SupabaseClient {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles';
}
