CREATE TABLE "surveillance_alerts" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"camera_id" integer,
	"alert_type" text NOT NULL,
	"role" text DEFAULT 'gm' NOT NULL,
	"is_urgent" boolean DEFAULT false NOT NULL,
	"is_suspicion" boolean DEFAULT false NOT NULL,
	"severity" integer DEFAULT 2 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"employee_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"people_note" text DEFAULT '' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"clip_ref" text DEFAULT '' NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"suggested_action" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"review_note" text DEFAULT '' NOT NULL,
	"reviewed_by_employee_id" integer,
	"reviewed_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveillance_camera_checks" (
	"id" serial PRIMARY KEY,
	"camera_id" integer NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"is_recording" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"checked_by_employee_id" integer,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveillance_cameras" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"camera_number" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"zone" text DEFAULT 'dining' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"is_recording" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"blind_spots" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveillance_daily_reports" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"business_date" date NOT NULL,
	"report_json" text NOT NULL,
	"generated_by_employee_id" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveillance_orders" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"order_ref" text NOT NULL,
	"item_name" text DEFAULT '' NOT NULL,
	"channel" text DEFAULT 'dine_in' NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"prep_seconds" integer,
	"has_invoice" boolean DEFAULT true NOT NULL,
	"prepared_by_employee_id" integer,
	"camera_id" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveillance_pos_events" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"cashier_employee_id" integer,
	"cashier_name" text DEFAULT '' NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"order_ref" text DEFAULT '' NOT NULL,
	"camera_id" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveillance_prep_targets" (
	"id" serial PRIMARY KEY,
	"item_name" text NOT NULL UNIQUE,
	"max_minutes" double precision DEFAULT 15 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveillance_settings" (
	"branch_id" integer PRIMARY KEY,
	"default_prep_minutes" double precision DEFAULT 15 NOT NULL,
	"customer_wait_minutes" double precision DEFAULT 10 NOT NULL,
	"repeat_pos_threshold" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surveillance_waste" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"item_name" text NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT 'other' NOT NULL,
	"station" text DEFAULT '' NOT NULL,
	"camera_id" integer,
	"employee_id" integer,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "surveillance_alerts_branch_time_idx" ON "surveillance_alerts" ("branch_id","occurred_at");--> statement-breakpoint
CREATE INDEX "surveillance_alerts_status_idx" ON "surveillance_alerts" ("status");--> statement-breakpoint
CREATE INDEX "surveillance_alerts_source_ref_idx" ON "surveillance_alerts" ("source_ref");--> statement-breakpoint
CREATE INDEX "surveillance_camera_checks_camera_idx" ON "surveillance_camera_checks" ("camera_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "surveillance_cameras_branch_number_idx" ON "surveillance_cameras" ("branch_id","camera_number");--> statement-breakpoint
CREATE UNIQUE INDEX "surveillance_daily_reports_branch_date_idx" ON "surveillance_daily_reports" ("branch_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "surveillance_orders_ref_item_idx" ON "surveillance_orders" ("branch_id","order_ref","item_name");--> statement-breakpoint
CREATE INDEX "surveillance_orders_branch_time_idx" ON "surveillance_orders" ("branch_id","registered_at");--> statement-breakpoint
CREATE INDEX "surveillance_pos_events_branch_time_idx" ON "surveillance_pos_events" ("branch_id","occurred_at");--> statement-breakpoint
CREATE INDEX "surveillance_waste_branch_time_idx" ON "surveillance_waste" ("branch_id","occurred_at");--> statement-breakpoint
ALTER TABLE "surveillance_alerts" ADD CONSTRAINT "surveillance_alerts_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_alerts" ADD CONSTRAINT "surveillance_alerts_camera_id_surveillance_cameras_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "surveillance_cameras"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_alerts" ADD CONSTRAINT "surveillance_alerts_reviewed_by_employee_id_employees_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_alerts" ADD CONSTRAINT "surveillance_alerts_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_camera_checks" ADD CONSTRAINT "surveillance_camera_checks_3d4zKXe0P0Zo_fkey" FOREIGN KEY ("camera_id") REFERENCES "surveillance_cameras"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_camera_checks" ADD CONSTRAINT "surveillance_camera_checks_h6B0bB8qpkHG_fkey" FOREIGN KEY ("checked_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_cameras" ADD CONSTRAINT "surveillance_cameras_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_daily_reports" ADD CONSTRAINT "surveillance_daily_reports_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_daily_reports" ADD CONSTRAINT "surveillance_daily_reports_yPbeqsxM7Hre_fkey" FOREIGN KEY ("generated_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_orders" ADD CONSTRAINT "surveillance_orders_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_orders" ADD CONSTRAINT "surveillance_orders_prepared_by_employee_id_employees_id_fkey" FOREIGN KEY ("prepared_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_orders" ADD CONSTRAINT "surveillance_orders_camera_id_surveillance_cameras_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "surveillance_cameras"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_orders" ADD CONSTRAINT "surveillance_orders_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_pos_events" ADD CONSTRAINT "surveillance_pos_events_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_pos_events" ADD CONSTRAINT "surveillance_pos_events_cashier_employee_id_employees_id_fkey" FOREIGN KEY ("cashier_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_pos_events" ADD CONSTRAINT "surveillance_pos_events_camera_id_surveillance_cameras_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "surveillance_cameras"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_pos_events" ADD CONSTRAINT "surveillance_pos_events_cJ6KZlLzWAb4_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD CONSTRAINT "surveillance_settings_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_waste" ADD CONSTRAINT "surveillance_waste_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "surveillance_waste" ADD CONSTRAINT "surveillance_waste_camera_id_surveillance_cameras_id_fkey" FOREIGN KEY ("camera_id") REFERENCES "surveillance_cameras"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_waste" ADD CONSTRAINT "surveillance_waste_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "surveillance_waste" ADD CONSTRAINT "surveillance_waste_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
-- منح بند «الرقابة والكاميرات» كاملاً (درجة الموافقات + الحذف) لكل نطاق يملك
-- اليوم إنشاء قواعد الصلاحيات (المالك/مسؤول النظام)، ومنه يمنحه لمن يشاء من
-- شاشة «إدارة الصلاحيات». لا يُعدَّل أي صف قائم ولا يُحذف شيء.
INSERT INTO "access_rules" ("scope_type", "employee_id", "scope_key", "module_key", "level", "can_delete", "note")
SELECT "scope_type", "employee_id", "scope_key", 'surveillance', 4, true, 'منح تلقائي عند إضافة وحدة الرقابة'
FROM "access_rules"
WHERE "module_key" = 'access_control' AND "level" >= 3
ON CONFLICT ("scope_type", "scope_key", "module_key") DO NOTHING;
