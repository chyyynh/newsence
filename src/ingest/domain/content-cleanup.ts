// ─────────────────────────────────────────────────────────────
// Post-extraction Content Cleanup
// Strips ads, sidebars, author bios, and other non-article
// content that Readability sometimes includes.
// ─────────────────────────────────────────────────────────────

/** Trailing section headings that indicate non-article content (sidebar, footer, etc.) */
const JUNK_HEADING_RE =
	/\n#{1,4}\s*(Most Popular|Related Stories?|Trending Now|Trending|You May Also Like|More From\b|Recommended|Popular Stories|Read Next|Related Articles?|Further Reading|Also Read|What to Read Next|Editor'?s Picks?|Top Stories|Don'?t Miss)\b/i;

/** Trailing author bio / "Topics" section (e.g. TechCrunch) */
const JUNK_AUTHOR_BIO_RE = /\nTopics\s*\n[\s\S]*$/;

/** Inline ad blocks inserted mid-article (e.g. TechCrunch Disrupt / Founder Summit promos) */
const INLINE_AD_RE =
	/\n\n#### (?:Disrupt 202\d|Join the Disrupt|Save up to \$\d.*(?:Disrupt|Founder Summit)|\d+ days? (?:left|until).*Disrupt|Last 24 hours.*Disrupt|How Disrupt delivers|Build a pipeline.*Disrupt|TechCrunch Disrupt 202\d)[^\n]*(?:\n\n#### [^\n]*)*/gi;

/** Promotional / newsletter CTAs that appear after article body */
const JUNK_CTA_PATTERNS: RegExp[] = [
	// TechCrunch event promos
	/\nActively scaling\? Fundraising\?/,
	// Generic newsletter CTAs
	/\n(?:Sign up for|Subscribe to|Get the latest|Join our newsletter|This is an edition of)\b/i,
];

/**
 * Strip non-article content from extracted markdown:
 * - Inline ad blocks (TechCrunch Disrupt / Founder Summit promos)
 * - Trailing sidebar sections ("Most Popular", "Related Stories", etc.)
 * - Author bio blocks ("Topics" section)
 * - Newsletter / event CTAs
 */
export function cleanExtractedContent(markdown: string): string {
	let cleaned = markdown;

	// Strip inline ad blocks (e.g. TechCrunch Disrupt promos inserted mid-article)
	cleaned = cleaned.replace(INLINE_AD_RE, '');

	// Find the earliest junk heading and truncate everything after it
	const headingMatch = JUNK_HEADING_RE.exec(cleaned);
	if (headingMatch) {
		cleaned = cleaned.slice(0, headingMatch.index);
	}

	// Strip trailing author bio sections (e.g. TechCrunch "Topics" block)
	const bioMatch = JUNK_AUTHOR_BIO_RE.exec(cleaned);
	if (bioMatch && cleaned.length - bioMatch.index < 800) {
		cleaned = cleaned.slice(0, bioMatch.index);
	}

	// Remove trailing CTA patterns (only if near the end — within last 600 chars)
	for (const pattern of JUNK_CTA_PATTERNS) {
		const match = pattern.exec(cleaned);
		if (match && cleaned.length - match.index < 600) {
			cleaned = cleaned.slice(0, match.index);
		}
	}

	return cleaned.trimEnd();
}
