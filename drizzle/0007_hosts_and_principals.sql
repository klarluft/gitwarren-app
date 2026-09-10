CREATE TABLE `principals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`identifier` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `principals_identity_idx` ON `principals` (`kind`,`identifier`);--> statement-breakpoint
DROP INDEX `repositories_path_unique`;--> statement-breakpoint
ALTER TABLE `repositories` ADD `host_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_host_path_idx` ON `repositories` (`host_id`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_local_path_idx` ON `repositories` (`path`) WHERE "repositories"."host_id" is null;--> statement-breakpoint
ALTER TABLE `comments` ADD `author_id` integer REFERENCES principals(id);