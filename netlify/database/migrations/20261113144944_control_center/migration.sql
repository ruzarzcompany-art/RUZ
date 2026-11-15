CREATE TABLE "control_briefs" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"business_date" date NOT NULL,
	"score" double precision,
	"brief_text" text DEFAULT '' NOT NULL,
	"facts_json" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_dispatches" (
	"id" serial PRIMARY KEY,
	"alert_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"current_tier" text NOT NULL,
	"escalates" boolean DEFAULT true NOT NULL,
	"next_escalate_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"ack_at" timestamp with time zone,
	"ack_by_recipient_id" integer,
	"ack_by_name" text DEFAULT '' NOT NULL,
	"ack_tier" text DEFAULT '' NOT NULL,
	"ack_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_footfall" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"entries" integer DEFAULT 0 NOT NULL,
	"exits" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_messages" (
	"id" serial PRIMARY KEY,
	"dispatch_id" integer,
	"branch_id" integer NOT NULL,
	"recipient_id" integer,
	"tier" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'alert' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_recipients" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"tier" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"employee_id" integer,
	"zones" text[] DEFAULT '{}'::text[] NOT NULL,
	"on_shift_only" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_settings" (
	"branch_id" integer PRIMARY KEY,
	"enabled" boolean DEFAULT true NOT NULL,
	"staff_ack_minutes" double precision DEFAULT 1 NOT NULL,
	"order_staff_ack_minutes" double precision DEFAULT 2 NOT NULL,
	"manager_ack_minutes" double precision DEFAULT 3 NOT NULL,
	"queue_max" integer DEFAULT 4 NOT NULL,
	"table_wait_minutes" double precision DEFAULT 5 NOT NULL,
	"table_clear_minutes" double precision DEFAULT 1 NOT NULL,
	"queue_seconds" integer DEFAULT 60 NOT NULL,
	"edge_last_seen_at" timestamp with time zone,
	"edge_status_json" text DEFAULT '' NOT NULL,
	"edge_offline_notified" boolean DEFAULT false NOT NULL,
	"notify_minor" boolean DEFAULT false NOT NULL,
	"google_location" text DEFAULT '' NOT NULL,
	"review_max_stars" integer DEFAULT 3 NOT NULL,
	"reviews_last_sync_at" timestamp with time zone,
	"reviews_last_error" text DEFAULT '' NOT NULL,
	"feedback_enabled" boolean DEFAULT true NOT NULL,
	"table_count" integer DEFAULT 20 NOT NULL,
	"brief_time" text DEFAULT '23:45' NOT NULL,
	"brief_last_date" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_table_sessions" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"zone_id" integer,
	"table_label" text DEFAULT '' NOT NULL,
	"seated_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"first_visit_seconds" integer,
	"cleared_seconds" integer,
	"max_people" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_zones" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"camera_id" integer NOT NULL,
	"kind" text DEFAULT 'table' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"points_json" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_feedback" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"table_no" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"alert_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_reviews" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"review_id" text NOT NULL,
	"rating" integer DEFAULT 0 NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"has_reply" boolean DEFAULT false NOT NULL,
	"alert_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "control_briefs_branch_date_idx" ON "control_briefs" ("branch_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "control_dispatches_alert_idx" ON "control_dispatches" ("alert_id");--> statement-breakpoint
CREATE INDEX "control_dispatches_due_idx" ON "control_dispatches" ("status","next_escalate_at");--> statement-breakpoint
CREATE INDEX "control_dispatches_branch_time_idx" ON "control_dispatches" ("branch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "control_footfall_branch_hour_idx" ON "control_footfall" ("branch_id","hour_start");--> statement-breakpoint
CREATE INDEX "control_messages_dispatch_idx" ON "control_messages" ("dispatch_id");--> statement-breakpoint
CREATE INDEX "control_recipients_branch_tier_idx" ON "control_recipients" ("branch_id","tier");--> statement-breakpoint
CREATE UNIQUE INDEX "control_table_sessions_zone_seated_idx" ON "control_table_sessions" ("zone_id","seated_at");--> statement-breakpoint
CREATE INDEX "control_table_sessions_branch_time_idx" ON "control_table_sessions" ("branch_id","seated_at");--> statement-breakpoint
CREATE INDEX "control_zones_branch_camera_idx" ON "control_zones" ("branch_id","camera_id");--> statement-breakpoint
CREATE INDEX "customer_feedback_branch_time_idx" ON "customer_feedback" ("branch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "google_reviews_branch_review_idx" ON "google_reviews" ("branch_id","review_id");--> statement-breakpoint
CREATE INDEX "google_reviews_branch_time_idx" ON "google_reviews" ("branch_id","reviewed_at");--> statement-breakpoint
ALTER TABLE "control_briefs" ADD CONSTRAINT "control_briefs_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_dispatches" ADD CONSTRAINT "control_dispatches_alert_id_surveillance_alerts_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "surveillance_alerts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_dispatches" ADD CONSTRAINT "control_dispatches_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_dispatches" ADD CONSTRAINT "control_dispatches_jORLuReSrQkN_fkey" FOREIGN KEY ("ack_by_recipient_id") REFERENCES "control_recipients"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "control_footfall" ADD CONSTRAINT "control_footfall_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_messages" ADD CONSTRAINT "control_messages_dispatch_id_control_dispatches_id_fkey" FOREIGN KEY ("dispatch_id") REFERENCES "control_dispatches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_messages" ADD CONSTRAINT "control_messages_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_messages" ADD CONSTRAINT "control_messages_recipient_id_control_recipients_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "control_recipients"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "control_recipients" ADD CONSTRAINT "control_recipients_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_recipients" ADD CONSTRAINT "control_recipients_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "control_settings" ADD CONSTRAINT "control_settings_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_table_sessions" ADD CONSTRAINT "control_table_sessions_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_table_sessions" ADD CONSTRAINT "control_table_sessions_zone_id_control_zones_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "control_zones"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "control_zones" ADD CONSTRAINT "control_zones_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_zones" ADD CONSTRAINT "control_zones_camera_id_surveillance_cameras_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "surveillance_cameras"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "customer_feedback" ADD CONSTRAINT "customer_feedback_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "customer_feedback" ADD CONSTRAINT "customer_feedback_alert_id_surveillance_alerts_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "surveillance_alerts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "google_reviews" ADD CONSTRAINT "google_reviews_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "google_reviews" ADD CONSTRAINT "google_reviews_alert_id_surveillance_alerts_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "surveillance_alerts"("id") ON DELETE SET NULL;