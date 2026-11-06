CREATE TABLE `apiKeys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`keyHash` text NOT NULL,
	`displayPrefix` text NOT NULL,
	`createdAt` text NOT NULL,
	`lastUsedAt` text,
	`revokedAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apiKeys_keyHash_unique` ON `apiKeys` (`keyHash`);