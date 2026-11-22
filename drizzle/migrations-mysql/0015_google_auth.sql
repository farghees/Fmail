ALTER TABLE `users` ADD `google_sub` varchar(191);--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_idx` ON `users` (`google_sub`);--> statement-breakpoint
CREATE TABLE `google_auth_flows` (
	`id` varchar(191) NOT NULL,
	`purpose` varchar(64) NOT NULL,
	`stage` varchar(64) NOT NULL,
	`host` varchar(191) NOT NULL,
	`state` varchar(191),
	`code_verifier` varchar(191),
	`nonce` varchar(191),
	`google_sub` varchar(191),
	`email` varchar(191),
	`expires_at` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `google_auth_flows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `google_auth_flows_expires_idx` ON `google_auth_flows` (`expires_at`);
