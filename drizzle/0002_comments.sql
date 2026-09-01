CREATE TABLE `comment_threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` integer NOT NULL,
	`file_path` text,
	`side` text,
	`line` integer,
	`anchor_text` text,
	`anchor_sha` text,
	`resolved_at` text,
	`resolved_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_threads_review_idx` ON `comment_threads` (`review_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `comment_threads_file_idx` ON `comment_threads` (`review_id`,`file_path`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`author_kind` text NOT NULL,
	`author_name` text NOT NULL,
	`author_label` text,
	`author_session` text,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comments_thread_idx` ON `comments` (`thread_id`,`created_at`);