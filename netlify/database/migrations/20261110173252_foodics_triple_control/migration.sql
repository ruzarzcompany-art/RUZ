CREATE TABLE "foodics_connection" (
	"id" integer PRIMARY KEY,
	"token_enc" text DEFAULT '' NOT NULL,
	"api_base" text DEFAULT '' NOT NULL,
	"updated_by_employee_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foodics_inventory_events" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"foodics_key" text NOT NULL,
	"kind" text DEFAULT 'waste' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date,
	"item_name" text DEFAULT '' NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"cost" double precision DEFAULT 0 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foodics_orders" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"foodics_id" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"business_date" date,
	"channel" text DEFAULT 'dine_in' NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'other' NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"kitchen_done_at" timestamp with time zone,
	"total" double precision DEFAULT 0 NOT NULL,
	"discount" double precision DEFAULT 0 NOT NULL,
	"payments_json" text DEFAULT '[]' NOT NULL,
	"items_json" text DEFAULT '[]' NOT NULL,
	"creator_name" text DEFAULT '' NOT NULL,
	"cashier_employee_id" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "surveillance_pos_events" ADD COLUMN "match_status" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_pos_events" ADD COLUMN "match_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "foodics_branch_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "foodics_match_minutes" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "sales_gap_tolerance" double precision DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "foodics_last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "surveillance_settings" ADD COLUMN "foodics_last_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "foodics_inventory_events_key_idx" ON "foodics_inventory_events" ("branch_id","foodics_key");--> statement-breakpoint
CREATE INDEX "foodics_inventory_events_branch_time_idx" ON "foodics_inventory_events" ("branch_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "foodics_orders_branch_fid_idx" ON "foodics_orders" ("branch_id","foodics_id");--> statement-breakpoint
CREATE INDEX "foodics_orders_branch_closed_idx" ON "foodics_orders" ("branch_id","closed_at");--> statement-breakpoint
CREATE INDEX "foodics_orders_branch_date_idx" ON "foodics_orders" ("branch_id","business_date");--> statement-breakpoint
ALTER TABLE "foodics_connection" ADD CONSTRAINT "foodics_connection_updated_by_employee_id_employees_id_fkey" FOREIGN KEY ("updated_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "foodics_inventory_events" ADD CONSTRAINT "foodics_inventory_events_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "foodics_orders" ADD CONSTRAINT "foodics_orders_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "foodics_orders" ADD CONSTRAINT "foodics_orders_cashier_employee_id_employees_id_fkey" FOREIGN KEY ("cashier_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;