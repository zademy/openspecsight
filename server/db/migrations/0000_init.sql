CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`progress` integer NOT NULL,
	`step` text NOT NULL,
	`statsJson` text NOT NULL,
	`error` text,
	`createdAt` text NOT NULL,
	`finishedAt` text,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scenarioId` integer NOT NULL,
	`body` text NOT NULL,
	`author` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`scenarioId`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `featureFiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`featureId` integer NOT NULL,
	`path` text NOT NULL,
	FOREIGN KEY (`featureId`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `features` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`parentId` integer,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`sortOrder` integer NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parentId`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payloadJson` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`error` text,
	`createdAt` text NOT NULL,
	`finishedAt` text
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`repositoryId` integer NOT NULL,
	`sha` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`highlight` integer NOT NULL,
	`summary` text NOT NULL,
	`authorsJson` text NOT NULL,
	`message` text NOT NULL,
	`committedAt` text NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repositoryId`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`projectId` integer NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`patEncrypted` text,
	`lastSyncedSha` text,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scenarioRevisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`releaseId` integer NOT NULL,
	`scenarioId` integer,
	`featureId` integer NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`beforeJson` text,
	`afterJson` text,
	FOREIGN KEY (`releaseId`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scenarioId`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`featureId`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`featureId` integer NOT NULL,
	`context` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`category` text NOT NULL,
	`code` text NOT NULL,
	`sortOrder` integer NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`featureId`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action
);
