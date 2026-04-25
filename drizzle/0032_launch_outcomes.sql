CREATE TABLE `launch_outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`revenue_usd` integer,
	`conversions` integer,
	`views` integer,
	`churn_30d` integer,
	`source` text,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `factory_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
