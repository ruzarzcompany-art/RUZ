CREATE TABLE "foodics_item_stock" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foodics_stock_docs" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"kind" text DEFAULT 'purchase' NOT NULL,
	"foodics_id" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"party" text DEFAULT '' NOT NULL,
	"foodics_status" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"business_date" date,
	"expected_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"total" double precision DEFAULT 0 NOT NULL,
	"items_json" text DEFAULT '[]' NOT NULL,
	"confirm_status" text DEFAULT 'awaiting' NOT NULL,
	"confirmed_by_employee_id" integer,
	"confirmed_at" timestamp with time zone,
	"confirm_note" text DEFAULT '' NOT NULL,
	"diff_json" text DEFAULT '[]' NOT NULL,
	"reminded_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "foodics_item_stock_key_idx" ON "foodics_item_stock" ("branch_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "foodics_stock_docs_key_idx" ON "foodics_stock_docs" ("branch_id","kind","foodics_id");--> statement-breakpoint
CREATE INDEX "foodics_stock_docs_branch_date_idx" ON "foodics_stock_docs" ("branch_id","business_date");--> statement-breakpoint
ALTER TABLE "foodics_item_stock" ADD CONSTRAINT "foodics_item_stock_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "foodics_item_stock" ADD CONSTRAINT "foodics_item_stock_item_id_inventory_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "foodics_stock_docs" ADD CONSTRAINT "foodics_stock_docs_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "foodics_stock_docs" ADD CONSTRAINT "foodics_stock_docs_confirmed_by_employee_id_employees_id_fkey" FOREIGN KEY ("confirmed_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;