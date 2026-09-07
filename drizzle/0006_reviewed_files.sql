CREATE TABLE `reviewed_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`content_digest` text NOT NULL,
	`reviewed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviewed_files_path_idx` ON `reviewed_files` (`review_id`,`file_path`);