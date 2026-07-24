export const USER_ACCOUNT_KINDS = ['human', 'system'] as const;

export type UserAccountKind = (typeof USER_ACCOUNT_KINDS)[number];

// Product identity shared by the app and Core. This is intentionally a fixed
// UUID, not a username lookup: usernames are presentation, while publication
// ownership must survive renames and remain deterministic across Workers.
export const OPENNEWS_SYSTEM_USER = {
	id: 'aaf9170b-44e7-42fb-af97-b2260d9bcfc7',
	username: 'opennews',
	name: 'OpenNews',
	email: 'opennews-system@internal.newsence.invalid',
} as const;

export const RESERVED_SYSTEM_USERNAMES = [OPENNEWS_SYSTEM_USER.username] as const;

export function isSystemUserId(userId: string): boolean {
	return userId === OPENNEWS_SYSTEM_USER.id;
}

export function isSystemUserEmail(email: string): boolean {
	return email.trim().toLowerCase() === OPENNEWS_SYSTEM_USER.email;
}
