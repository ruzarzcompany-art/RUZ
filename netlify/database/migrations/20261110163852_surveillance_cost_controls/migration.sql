ALTER TABLE "surveillance_settings" ADD COLUMN "analyze_open_hours_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "daily_analysis_cap" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "cap_notified_date" text DEFAULT '' NOT NULL;