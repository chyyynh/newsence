import { Article, Env } from '../types';

// Processor 處理結果
export interface ProcessorResult {
	// 更新到 articles 表的欄位
	updateData: {
		tags?: string[];
		keywords?: string[];
		title_cn?: string;
		summary?: string;
		summary_cn?: string;
		title?: string;
	};
	// 平台特定的額外資料 (存入 platform_metadata.enrichments)
	enrichments?: Record<string, unknown>;
}

// Processor 上下文
export interface ProcessorContext {
	env: Env;
	supabase: any;
	table: string;
}

// Processor 介面
export interface ArticleProcessor {
	readonly sourceType: string;
	process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult>;
}
