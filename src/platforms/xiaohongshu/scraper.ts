// ─────────────────────────────────────────────────────────────
// Xiaohongshu User Page Scraper (HTMLRewriter)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface XhsNote {
	noteId: string;
	displayTitle: string;
	coverUrl: string | null;
	likeCount: number;
	user?: { nickname?: string };
}

export interface XhsUserData {
	nickname: string;
	notes: XhsNote[];
}

// ─────────────────────────────────────────────────────────────
// Scraper
// ─────────────────────────────────────────────────────────────

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface CoverInfo {
	url?: string;
	infoList?: Array<{ url?: string }>;
}

interface RawNoteCard {
	noteId?: string;
	displayTitle?: string;
	cover?: CoverInfo;
	user?: { nickname?: string };
	interactInfo?: { likedCount?: string | number };
}

interface XhsInitialState {
	user?: {
		userPageData?: {
			basicInfo?: {
				nickname?: string;
				imageb?: string;
				images?: string;
				desc?: string;
			};
		};
	};
	notes?: Array<Array<{ noteCard?: RawNoteCard }>>;
}

export async function scrapeXiaohongshuUser(uid: string): Promise<XhsUserData> {
	const url = `https://www.xiaohongshu.com/user/profile/${uid}`;
	const res = await fetch(url, {
		headers: {
			'User-Agent': USER_AGENT,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
		},
	});

	if (!res.ok) {
		throw new Error(`Xiaohongshu fetch failed: ${res.status}`);
	}

	// Use HTMLRewriter to extract script tags
	const scripts: string[] = [];
	const rewriter = new HTMLRewriter()
		.on('script', {
			element() {
				scripts.push('');
			},
			text(text) {
				scripts[scripts.length - 1] += text.text;
			},
		})
		.transform(res);

	// Consume the transformed response to trigger HTMLRewriter
	await rewriter.text();

	// Find the __INITIAL_STATE__ script
	const stateScript = scripts.find((s) => s.startsWith('window.__INITIAL_STATE__='));
	if (!stateScript) {
		throw new Error('Xiaohongshu: __INITIAL_STATE__ not found');
	}

	const jsonStr = stateScript.slice('window.__INITIAL_STATE__='.length).replace(/undefined/g, 'null');
	const state = JSON.parse(jsonStr) as XhsInitialState;

	const basicInfo = state.user?.userPageData?.basicInfo;
	const nickname = basicInfo?.nickname || 'Unknown';

	const notes: XhsNote[] = [];
	if (state.notes && Array.isArray(state.notes)) {
		for (const group of state.notes) {
			if (!Array.isArray(group)) continue;
			for (const item of group) {
				const card = item.noteCard;
				if (!card?.noteId) continue;

				const coverUrl = card.cover?.infoList?.[0]?.url || card.cover?.url || null;
				const likeCount =
					typeof card.interactInfo?.likedCount === 'string'
						? parseInt(card.interactInfo.likedCount, 10) || 0
						: (card.interactInfo?.likedCount ?? 0);

				notes.push({
					noteId: card.noteId,
					displayTitle: card.displayTitle || '',
					coverUrl,
					likeCount,
					user: card.user,
				});
			}
		}
	}

	return { nickname, notes };
}
