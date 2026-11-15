CREATE TABLE "control_outbox" (
	"id" serial PRIMARY KEY,
	"phone" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_settings" ADD COLUMN "wa_edge_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "control_settings" ADD COLUMN "wa_edge_state" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "control_outbox_status_idx" ON "control_outbox" ("status","id");