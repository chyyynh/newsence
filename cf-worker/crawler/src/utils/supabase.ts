import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(env: Env): SupabaseClient {
	if (!supabaseClient) {
		supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
	}
	return supabaseClient;
}

export interface ArticleInsert {
	url: string;
	title: string;
	source: string;
	published_date: string;
	scraped_date: string;
	summary?: string;
	source_type: string;
	content?: string;
	og_image_url?: string;
	keywords?: string[];
	tags?: string[];
	tokens?: string[];
}

/**
 * Check if article with this URL already exists
 */
export async function findExistingArticle(
	supabase: SupabaseClient,
	normalizedUrl: string
): Promise<{ id: string } | null> {
	const { data, error } = await supabase
		.from('articles')
		.select('id')
		.eq('url', normalizedUrl)
		.maybeSingle();

	if (error) {
		console.error('[SUPABASE] Error checking existing article:', error);
		return null;
	}

	return data;
}

/**
 * Insert new article into database
 */
export async function insertArticle(
	supabase: SupabaseClient,
	article: ArticleInsert
): Promise<{ id: string } | null> {
	const { data, error } = await supabase.from('articles').insert(article).select('id').single();

	if (error) {
		console.error('[SUPABASE] Error inserting article:', error);
		return null;
	}

	return data;
}
