CREATE TABLE `connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`fromFeatureId` integer NOT NULL,
	`toFeatureId` integer NOT NULL,
	`type` text NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fromFeatureId`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`toFeatureId`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`title` text NOT NULL,
	`pinned` integer NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `flows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`featureId` integer NOT NULL,
	`graphJson` text NOT NULL,
	FOREIGN KEY (`featureId`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flows_featureId_unique` ON `flows` (`featureId`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversationId` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`citationsJson` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
