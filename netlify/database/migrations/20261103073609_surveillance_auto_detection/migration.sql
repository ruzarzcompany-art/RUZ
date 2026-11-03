CREATE TABLE "surveillance_frames" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"camera_id" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"image_key" text DEFAULT '' NOT NULL,
	"camera_state" text DEFAULT 'ok' NOT NULL,
	"people_count" integer DEFAULT 0 NOT NULL,
	"waiting" boolean DEFAULT false NOT NULL,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"analysis_json" text DEFAULT '' NOT NULL,
	"alert_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "auto_detect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "connection_mode" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "snapshot_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "snapshot_username" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "snapshot_password_enc" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "interval_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "reference_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "last_frame_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "last_analysis_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD COLUMN "last_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "open_time" text DEFAULT '06:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "close_time" text DEFAULT '02:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "alert_emails" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "surveillance_frames_camera_time_idx" ON "surveillance_frames" ("camera_id","captured_at");--> statement-breakpoint
CREATE INDEX "surveillance_frames_branch_time_idx" ON "surveillance_frames" ("branch_id","captured_at");--> statement-breakpoint
ALTER TABLE "surveillance_frames" ADD CONSTRAINT "surveillance_frames_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_frames" ADD CONSTRAINT "surveillance_frames_camera_id_surveillance_cameras_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "surveillance_cameras"("id") ON DELETE CASCADE;