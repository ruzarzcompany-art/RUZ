CREATE TABLE "waste_entries" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"business_date" date NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT 'other' NOT NULL,
	"station" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"unit_cost" double precision DEFAULT 0 NOT NULL,
	"total_cost" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recorded_by_employee_id" integer,
	"reviewed_by_employee_id" integer,
	"reviewed_at" timestamp with time zone,
	"review_note" text DEFAULT '' NOT NULL,
	"movement_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waste_settings" (
	"branch_id" integer PRIMARY KEY NOT NULL,
	"limit_percent" double precision DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "waste_entries_branch_date_idx" ON "waste_entries" ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "waste_entries_status_idx" ON "waste_entries" ("branch_id","status");--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_item_id_inventory_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_recorded_by_employees_id_fkey" FOREIGN KEY ("recorded_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_reviewed_by_employees_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "waste_settings" ADD CONSTRAINT "waste_settings_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;
