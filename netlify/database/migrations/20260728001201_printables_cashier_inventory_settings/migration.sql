CREATE TABLE "cashier_closings" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"business_date" date NOT NULL,
	"shift" text DEFAULT 'full' NOT NULL,
	"opening_float" double precision DEFAULT 0 NOT NULL,
	"total_sales" double precision DEFAULT 0 NOT NULL,
	"cash_sales" double precision DEFAULT 0 NOT NULL,
	"card_sales" double precision DEFAULT 0 NOT NULL,
	"transfer_sales" double precision DEFAULT 0 NOT NULL,
	"delivery_sales" double precision DEFAULT 0 NOT NULL,
	"other_sales" double precision DEFAULT 0 NOT NULL,
	"discounts" double precision DEFAULT 0 NOT NULL,
	"refunds" double precision DEFAULT 0 NOT NULL,
	"expenses" double precision DEFAULT 0 NOT NULL,
	"counted_cash" double precision DEFAULT 0 NOT NULL,
	"expected_cash" double precision DEFAULT 0 NOT NULL,
	"difference" double precision DEFAULT 0 NOT NULL,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"review_note" text DEFAULT '' NOT NULL,
	"reviewed_by_employee_id" integer,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" serial PRIMARY KEY,
	"settings_key" text DEFAULT 'default' NOT NULL UNIQUE,
	"company_name" text DEFAULT 'مؤسسة المطعم' NOT NULL,
	"company_name_en" text DEFAULT '' NOT NULL,
	"legal_form" text DEFAULT '' NOT NULL,
	"commercial_register" text DEFAULT '' NOT NULL,
	"tax_number" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"country" text DEFAULT 'المملكة العربية السعودية' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"footer_text" text DEFAULT '' NOT NULL,
	"footer_note" text DEFAULT '' NOT NULL,
	"logo_data_url" text DEFAULT '' NOT NULL,
	"logo_updated_at" timestamp with time zone,
	"paper_size" text DEFAULT 'A4' NOT NULL,
	"paper_orientation" text DEFAULT 'portrait' NOT NULL,
	"margin_mm" integer DEFAULT 16 NOT NULL,
	"base_font_pt" double precision DEFAULT 11 NOT NULL,
	"font_family" text DEFAULT 'system' NOT NULL,
	"accent_color" text DEFAULT '#0f766e' NOT NULL,
	"text_color" text DEFAULT '#111827' NOT NULL,
	"show_logo" boolean DEFAULT true NOT NULL,
	"show_footer" boolean DEFAULT true NOT NULL,
	"show_signatures" boolean DEFAULT true NOT NULL,
	"show_watermark" boolean DEFAULT false NOT NULL,
	"watermark_text" text DEFAULT '' NOT NULL,
	"header_note" text DEFAULT '' NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"updated_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"name_en" text DEFAULT '' NOT NULL,
	"branch_id" integer,
	"manager_employee_id" integer,
	"note" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disciplinary_actions" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"level" text DEFAULT 'first' NOT NULL,
	"incident_date" date NOT NULL,
	"incident_description" text DEFAULT '' NOT NULL,
	"violation_type" text DEFAULT 'other' NOT NULL,
	"action_taken" text DEFAULT '' NOT NULL,
	"deduction_amount" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_issues" (
	"id" serial PRIMARY KEY,
	"doc_type" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"employee_id" integer,
	"branch_id" integer,
	"ref_type" text DEFAULT '' NOT NULL,
	"ref_id" integer,
	"payload" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"issued_by_employee_id" integer,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" serial PRIMARY KEY,
	"code" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"unit" text DEFAULT 'قطعة' NOT NULL,
	"unit_cost" double precision DEFAULT 0 NOT NULL,
	"min_quantity" double precision DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"movement_type" text DEFAULT 'in' NOT NULL,
	"business_date" date NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit_cost" double precision DEFAULT 0 NOT NULL,
	"total_cost" double precision DEFAULT 0 NOT NULL,
	"reason" text DEFAULT 'other' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"variance" double precision DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_titles" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"name_en" text DEFAULT '' NOT NULL,
	"department_id" integer,
	"default_basic_salary" double precision DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_components" (
	"id" serial PRIMARY KEY,
	"code" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"kind" text DEFAULT 'allowance' NOT NULL,
	"calculation" text DEFAULT 'fixed' NOT NULL,
	"default_value" double precision DEFAULT 0 NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cashier_closings_unique_idx" ON "cashier_closings" ("branch_id","employee_id","business_date","shift");--> statement-breakpoint
CREATE INDEX "cashier_closings_branch_date_idx" ON "cashier_closings" ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "disciplinary_actions_employee_idx" ON "disciplinary_actions" ("employee_id","incident_date");--> statement-breakpoint
CREATE INDEX "document_issues_type_idx" ON "document_issues" ("doc_type","issued_at");--> statement-breakpoint
CREATE INDEX "document_issues_employee_idx" ON "document_issues" ("employee_id","issued_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_branch_date_idx" ON "inventory_movements" ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "inventory_movements_item_idx" ON "inventory_movements" ("item_id","business_date");--> statement-breakpoint
ALTER TABLE "cashier_closings" ADD CONSTRAINT "cashier_closings_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cashier_closings" ADD CONSTRAINT "cashier_closings_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cashier_closings" ADD CONSTRAINT "cashier_closings_reviewed_by_employee_id_employees_id_fkey" FOREIGN KEY ("reviewed_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_updated_by_employee_id_employees_id_fkey" FOREIGN KEY ("updated_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_manager_employee_id_employees_id_fkey" FOREIGN KEY ("manager_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "disciplinary_actions" ADD CONSTRAINT "disciplinary_actions_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "disciplinary_actions" ADD CONSTRAINT "disciplinary_actions_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "document_issues" ADD CONSTRAINT "document_issues_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "document_issues" ADD CONSTRAINT "document_issues_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "document_issues" ADD CONSTRAINT "document_issues_issued_by_employee_id_employees_id_fkey" FOREIGN KEY ("issued_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_inventory_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "job_titles" ADD CONSTRAINT "job_titles_department_id_departments_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL;