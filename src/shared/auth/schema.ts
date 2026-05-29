/**
 * Drizzle schema for the 4 better-auth tables — Phase 3 of issue #136.
 *
 * Mirrors `frontend/prisma/schema.prisma` models User / Session / Account /
 * Verification verbatim. `$onUpdate` on `updatedAt` matches Prisma's
 * `@updatedAt` (Drizzle doesn't auto-update otherwise; better-auth usually
 * passes the value explicitly, but this is the defensive default).
 *
 * Newsence-specific columns on `user` (bio, betaAccess, earlyAdopterNumber)
 * are owned by Vercel app code and not declared here — the worker never
 * reads or writes them.
 */

import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('emailVerified').notNull(),
	image: text('image'),
	createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).notNull().defaultNow(),
	updatedAt: timestamp('updatedAt', { precision: 3, mode: 'date' })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
	username: text('username').unique(),
});

export const session = pgTable('session', {
	id: text('id').primaryKey(),
	expiresAt: timestamp('expiresAt', { precision: 3, mode: 'date' }).notNull(),
	token: text('token').notNull().unique(),
	createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).notNull().defaultNow(),
	updatedAt: timestamp('updatedAt', { precision: 3, mode: 'date' })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
	ipAddress: text('ipAddress'),
	userAgent: text('userAgent'),
	userId: text('userId')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
	id: text('id').primaryKey(),
	accountId: text('accountId').notNull(),
	providerId: text('providerId').notNull(),
	userId: text('userId')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	accessToken: text('accessToken'),
	refreshToken: text('refreshToken'),
	idToken: text('idToken'),
	accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { precision: 3, mode: 'date' }),
	refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { precision: 3, mode: 'date' }),
	scope: text('scope'),
	password: text('password'),
	createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).notNull().defaultNow(),
	updatedAt: timestamp('updatedAt', { precision: 3, mode: 'date' })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
});

export const verification = pgTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: timestamp('expiresAt', { precision: 3, mode: 'date' }).notNull(),
	createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }),
	updatedAt: timestamp('updatedAt', { precision: 3, mode: 'date' }),
});

export const authSchema = { user, session, account, verification };
