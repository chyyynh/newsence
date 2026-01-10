import { Article } from '../types';
import { ProcessorResult, ProcessorContext, ArticleProcessor } from './types';
import { translateTweet } from '../utils/ai';
import { isEmpty } from './base';

export class TwitterProcessor implements ArticleProcessor {
	readonly sourceType = 'twitter';

	async process(article: Article, ctx: ProcessorContext): Promise<ProcessorResult> {
		const tweetText = article.content ?? '';
		const updateData: ProcessorResult['updateData'] = {};

		if (isEmpty(article.summary)) updateData.summary = tweetText;

		const analysis = await translateTweet(tweetText, ctx.env.OPENROUTER_API_KEY);

		if (isEmpty(article.summary_cn)) updateData.summary_cn = analysis.summary_cn;
		if (!article.tags?.length) updateData.tags = analysis.tags;
		if (!article.keywords?.length) updateData.keywords = analysis.keywords;

		return { updateData };
	}
}
