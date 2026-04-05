// ─────────────────────────────────────────────────────────────
// Bilibili Dynamic Card Parser
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface DynDescText {
	text?: string;
}

interface DynExtend {
	dynIdStr?: string;
	origName?: string;
	origDesc?: DynDescText[];
	origImgUrl?: string;
	desc?: DynDescText[];
	onlyFansProperty?: { isOnlyFans?: boolean };
}

interface DynModuleAuthor {
	ptimeLabelText?: string;
	author?: { name?: string };
}

interface DynModuleDesc {
	text?: string;
}

interface DynModule {
	moduleType?: string;
	moduleAuthor?: DynModuleAuthor;
	moduleDesc?: DynModuleDesc;
}

export interface DynCard {
	cardType?: string;
	extend?: DynExtend;
	modules?: DynModule[];
}

export interface ParsedDynamic {
	title: string;
	url: string;
	author: string;
	publishedDate: string;
	imageUrl: string | null;
	cardType: string;
	dynamicId: string;
	description: string;
}

// ─────────────────────────────────────────────────────────────
// Date Parsing
// ─────────────────────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Parses Chinese relative time labels (e.g. "3小时前", "昨天 14:30", "5月20日") to a Date. */
export function parsePubDate(label: string): Date {
	const now = Date.now();

	// "X分钟前"
	const minMatch = label.match(/(\d+)\s*分钟前/);
	if (minMatch) return new Date(now - parseInt(minMatch[1], 10) * MINUTE_MS);

	// "X小时前"
	const hourMatch = label.match(/(\d+)\s*小时前/);
	if (hourMatch) return new Date(now - parseInt(hourMatch[1], 10) * HOUR_MS);

	// "X天前"
	const dayMatch = label.match(/(\d+)\s*天前/);
	if (dayMatch) return new Date(now - parseInt(dayMatch[1], 10) * DAY_MS);

	// "昨天 HH:MM"
	const yesterdayMatch = label.match(/昨天\s*(\d{1,2}):(\d{2})/);
	if (yesterdayMatch) {
		const d = new Date(now - DAY_MS);
		d.setHours(parseInt(yesterdayMatch[1], 10), parseInt(yesterdayMatch[2], 10), 0, 0);
		return d;
	}

	// "M月D日" (current year)
	const mdMatch = label.match(/(\d{1,2})月(\d{1,2})日/);
	if (mdMatch) {
		const d = new Date();
		d.setMonth(parseInt(mdMatch[1], 10) - 1, parseInt(mdMatch[2], 10));
		d.setHours(0, 0, 0, 0);
		return d;
	}

	// "YYYY年M月D日"
	const ymdMatch = label.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
	if (ymdMatch) {
		return new Date(parseInt(ymdMatch[1], 10), parseInt(ymdMatch[2], 10) - 1, parseInt(ymdMatch[3], 10));
	}

	// "刚刚"
	if (label.includes('刚刚')) return new Date(now);

	// Fallback
	return new Date();
}

// ─────────────────────────────────────────────────────────────
// Card Parsing
// ─────────────────────────────────────────────────────────────

interface ExtractedModuleInfo {
	author: string;
	timeLabel: string;
	description: string;
}

function extractModuleInfo(modules: DynModule[], fallbackAuthor: string): ExtractedModuleInfo {
	let author = fallbackAuthor;
	let timeLabel = '';
	let description = '';

	for (const mod of modules) {
		if (mod.moduleType === 'module_author' && mod.moduleAuthor) {
			if (mod.moduleAuthor.author?.name) author = mod.moduleAuthor.author.name;
			if (mod.moduleAuthor.ptimeLabelText) timeLabel = mod.moduleAuthor.ptimeLabelText;
		}
		if (mod.moduleType === 'module_desc' && mod.moduleDesc?.text) {
			description = mod.moduleDesc.text;
		}
	}
	return { author, timeLabel, description };
}

export function parseDynCard(card: DynCard): ParsedDynamic | null {
	const extend = card.extend;
	if (!extend?.dynIdStr) return null;

	const dynamicId = extend.dynIdStr;
	const cardType = card.cardType || 'unknown';

	const moduleInfo = card.modules
		? extractModuleInfo(card.modules, extend.origName || '')
		: { author: extend.origName || '', timeLabel: '', description: '' };

	// Build description from extend.desc if module_desc was empty
	let { description } = moduleInfo;
	if (!description && extend.desc) {
		description = extend.desc.map((d) => d.text || '').join('');
	}

	const title = description ? description.split('\n')[0].slice(0, 120) : `Bilibili Dynamic ${dynamicId}`;
	const url = cardType === 'av' ? `https://www.bilibili.com/video/${dynamicId}` : `https://t.bilibili.com/${dynamicId}`;
	const publishedDate = moduleInfo.timeLabel ? parsePubDate(moduleInfo.timeLabel).toISOString() : new Date().toISOString();

	return {
		title,
		url,
		author: moduleInfo.author,
		publishedDate,
		imageUrl: extend.origImgUrl || null,
		cardType,
		dynamicId,
		description,
	};
}

/** Parse getDynSpace JSON output and return only video (av) cards. */
export function parseVideoCards(jsonStr: string): ParsedDynamic[] {
	const data = JSON.parse(jsonStr) as { list?: DynCard[] };
	if (!data.list || !Array.isArray(data.list)) return [];

	const results: ParsedDynamic[] = [];
	for (const card of data.list) {
		if (card.cardType !== 'av') continue;
		const parsed = parseDynCard(card);
		if (parsed) results.push(parsed);
	}
	return results;
}
