CREATE TABLE `hosts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` text,
	`label` text NOT NULL,
	`kind` text DEFAULT 'ssh' NOT NULL,
	`target` text NOT NULL,
	`editor_target` text,
	`last_seen_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosts_kind_target_idx` ON `hosts` (`kind`,`target`);--> statement-breakpoint
CREATE UNIQUE INDEX `hosts_instance_idx` ON `hosts` (`instance_id`) WHERE "hosts"."instance_id" is not null;