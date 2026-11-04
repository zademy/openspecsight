CREATE TABLE `digests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`rangeFrom` text NOT NULL,
	`rangeTo` text NOT NULL,
	`title` text NOT NULL,
	`blocksJson` text NOT NULL,
	`emailedAt` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `releaseNotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`title` text NOT NULL,
	`rangeFrom` text NOT NULL,
	`rangeTo` text NOT NULL,
	`voiceId` integer,
	`blocksJson` text NOT NULL,
	`slug` text NOT NULL,
	`published` integer NOT NULL,
	`createdAt` text NOT NULL,
	`publishedAt` text,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voiceId`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releaseNotes_slug_unique` ON `releaseNotes` (`slug`);--> statement-breakpoint
CREATE TABLE `voices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`isDefault` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
