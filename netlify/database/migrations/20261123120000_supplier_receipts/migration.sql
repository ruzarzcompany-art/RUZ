CREATE TABLE "supplier_receipts" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"business_date" date NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"verify_method" text DEFAULT 'session' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"supplier" text DEFAULT '' NOT NULL,
	"invoice_number" text DEFAULT '' NOT NULL,
	"invoice_date" date,
	"invoice_total" double precision DEFAULT 0 NOT NULL,
	"lines_json" text DEFAULT '[]' NOT NULL,
	"diff_count" integer DEFAULT 0 NOT NULL,
	"photo_key" text DEFAULT '' NOT NULL,
	"ai_note" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"received_by_employee_id" integer,
	"submitted_at" timestamp with time zone,
	"reviewed_by_employee_id" integer,
	"reviewed_at" timestamp with time zone,
	"review_note" text DEFAULT '' NOT NULL,
	"foodics_doc_id" integer,
	"foodics_linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "supplier_receipts_branch_date_idx" ON "supplier_receipts" ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "supplier_receipts_status_idx" ON "supplier_receipts" ("branch_id","status");--> statement-breakpoint
ALTER TABLE "supplier_receipts" ADD CONSTRAINT "supplier_receipts_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "supplier_receipts" ADD CONSTRAINT "supplier_receipts_received_by_employees_id_fkey" FOREIGN KEY ("received_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "supplier_receipts" ADD CONSTRAINT "supplier_receipts_reviewed_by_employees_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;
