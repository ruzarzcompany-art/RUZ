CREATE TABLE "purchase_receipt_lines" (
	"id" serial PRIMARY KEY,
	"receipt_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit_cost" double precision DEFAULT 0 NOT NULL,
	"total_cost" double precision DEFAULT 0 NOT NULL,
	"previous_unit_cost" double precision DEFAULT 0 NOT NULL,
	"movement_id" integer
);
--> statement-breakpoint
CREATE TABLE "purchase_receipts" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"business_date" date NOT NULL,
	"supplier" text DEFAULT '' NOT NULL,
	"invoice_number" text DEFAULT '' NOT NULL,
	"payment_method" text DEFAULT 'cash' NOT NULL,
	"invoice_total" double precision DEFAULT 0 NOT NULL,
	"paid_amount" double precision DEFAULT 0 NOT NULL,
	"lines_total" double precision DEFAULT 0 NOT NULL,
	"difference" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"flags" text DEFAULT '[]' NOT NULL,
	"photo_key" text DEFAULT '' NOT NULL,
	"cash_expense_id" integer,
	"foodics_reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"received_by_employee_id" integer,
	"reviewed_by_employee_id" integer,
	"reviewed_at" timestamp with time zone,
	"review_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "purchase_receipt_lines_receipt_idx" ON "purchase_receipt_lines" ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receipts_invoice_unique_idx" ON "purchase_receipts" ("branch_id","invoice_number") WHERE invoice_number <> '';--> statement-breakpoint
CREATE INDEX "purchase_receipts_branch_date_idx" ON "purchase_receipts" ("branch_id","business_date");--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_receipt_id_purchase_receipts_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_item_id_inventory_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_cash_expense_id_cash_expenses_id_fkey" FOREIGN KEY ("cash_expense_id") REFERENCES "cash_expenses"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_received_by_employee_id_employees_id_fkey" FOREIGN KEY ("received_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_reviewed_by_employee_id_employees_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;