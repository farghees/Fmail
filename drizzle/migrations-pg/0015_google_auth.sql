ALTER TABLE "users" ADD COLUMN "google_sub" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_idx" ON "users" USING btree ("google_sub");--> statement-breakpoint
CREATE TABLE "google_auth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"stage" text NOT NULL,
	"host" text NOT NULL,
	"state" text,
	"code_verifier" text,
	"nonce" text,
	"google_sub" text,
	"email" text,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "google_auth_flows_expires_idx" ON "google_auth_flows" USING btree ("expires_at");
