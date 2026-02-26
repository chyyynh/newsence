export interface FeedConfig {
	summarySource: 'description' | 'ai';
	contentSource: 'content_encoded' | 'description' | 'scrape' | 'skip';
}

const DEFAULT_CONFIG: FeedConfig = {
	summarySource: 'description',
	contentSource: 'scrape',
};

const FEED_OVERRIDES: Record<string, Partial<FeedConfig>> = {
	// Type A: content:encoded has full article, description is a good summary
	'Nvidia Blog': { contentSource: 'content_encoded' },
	'Microsoft Research': { contentSource: 'content_encoded' },
	stratechery: { contentSource: 'content_encoded' },

	// Type B: description IS the full article (Discourse forums, LessWrong)
	Lesswrong: { summarySource: 'ai', contentSource: 'description' },
	'ethresear.ch': { summarySource: 'ai', contentSource: 'description' },
	'Ethereum Magicians': { summarySource: 'ai', contentSource: 'description' },

	// Type D: description is garbage/teaser, not a real summary
	'Google Research': { summarySource: 'ai' },
	'Google Deepmind': { summarySource: 'ai' },
	'Anthropic Research': { summarySource: 'ai' },
};

export function getFeedConfig(feedName: string): FeedConfig {
	const overrides = FEED_OVERRIDES[feedName];
	if (!overrides) return DEFAULT_CONFIG;
	return { ...DEFAULT_CONFIG, ...overrides };
}
