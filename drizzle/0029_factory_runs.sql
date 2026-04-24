CREATE TABLE `factory_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`idea_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
