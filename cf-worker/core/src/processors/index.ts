import { ArticleProcessor } from './types';
import { DefaultProcessor } from './base';
import { HackerNewsProcessor } from './hackernews';
import { TwitterProcessor } from './twitter';

export * from './types';
export { DefaultProcessor } from './base';
export { HackerNewsProcessor } from './hackernews';
export { TwitterProcessor } from './twitter';

// Processor 工廠
const processors: Record<string, ArticleProcessor> = {
	hackernews: new HackerNewsProcessor(),
	twitter: new TwitterProcessor(),
	default: new DefaultProcessor(),
};

export function getProcessor(sourceType: string | undefined): ArticleProcessor {
	return processors[sourceType ?? 'default'] ?? processors.default;
}
