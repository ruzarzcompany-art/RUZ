-- يوافق هذا الملف اللقطة (snapshot) على وضع القاعدة الفعلي: جداول الإغلاق
-- النقدي ومخالصات المزوّدين وحد ساعات الوردية أُنشئت في هجرات مكتوبة يدوياً
-- (20260804/20260805/20260808) دون لقطات، فأعاد المولِّد إصدارها هنا. لذلك
-- كل عبارة مكتوبة بصيغة لا تفشل على قاعدة تحتويها أصلاً (IF NOT EXISTS)،
-- وتُنشئ المخطط كاملاً على قاعدة جديدة.
CREATE TABLE IF NOT EXISTS "cash_expenses" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL CONSTRAINT "cash_expenses_branch_id_branches_id_fkey" REFERENCES "branches"("id") ON DELETE CASCADE,
	"business_date" date NOT NULL,
	"shift" text DEFAULT 'full' NOT NULL,
	"kind" text DEFAULT 'expense' NOT NULL,
	"description" text NOT NULL,
	"invoice_number" text DEFAULT '' NOT NULL,
	"quantity" double precision DEFAULT 1 NOT NULL,
	"unit_price" double precision DEFAULT 0 NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"supplier" text DEFAULT '' NOT NULL,
	"payment_method" text DEFAULT 'cash' NOT NULL,
	"closing_id" integer CONSTRAINT "cash_expenses_closing_id_cashier_closings_id_fkey" REFERENCES "cashier_closings"("id") ON DELETE SET NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer CONSTRAINT "cash_expenses_created_by_employee_id_employees_id_fkey" REFERENCES "employees"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cash_notifications" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL CONSTRAINT "cash_notifications_employee_id_employees_id_fkey" REFERENCES "employees"("id") ON DELETE CASCADE,
	"kind" text DEFAULT 'month_close_ready' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"ref_type" text DEFAULT '' NOT NULL,
	"ref_id" integer,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monthly_cash_closings" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL CONSTRAINT "monthly_cash_closings_branch_id_branches_id_fkey" REFERENCES "branches"("id") ON DELETE CASCADE,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"opening_balance" double precision DEFAULT 0 NOT NULL,
	"cash_sales_total" double precision DEFAULT 0 NOT NULL,
	"expenses_total" double precision DEFAULT 0 NOT NULL,
	"settlements_received" double precision DEFAULT 0 NOT NULL,
	"commission_total" double precision DEFAULT 0 NOT NULL,
	"vat_total" double precision DEFAULT 0 NOT NULL,
	"net_amount" double precision DEFAULT 0 NOT NULL,
	"carried_amount" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"decision" text DEFAULT '' NOT NULL,
	"decision_note" text DEFAULT '' NOT NULL,
	"decided_by_employee_id" integer CONSTRAINT "monthly_cash_closings_decided_by_employee_id_employees_id_fkey" REFERENCES "employees"("id") ON DELETE SET NULL,
	"decided_by_name" text DEFAULT '' NOT NULL,
	"decided_at" timestamp with time zone,
	"prepared_by_employee_id" integer CONSTRAINT "monthly_cash_closings_prepared_by_employee_id_employees_id_fkey" REFERENCES "employees"("id") ON DELETE SET NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"summary_json" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_settlements" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL CONSTRAINT "provider_settlements_branch_id_branches_id_fkey" REFERENCES "branches"("id") ON DELETE CASCADE,
	"provider_type" text DEFAULT 'network' NOT NULL,
	"provider_name" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"sales_amount" double precision DEFAULT 0 NOT NULL,
	"received_amount" double precision DEFAULT 0 NOT NULL,
	"commission_amount" double precision DEFAULT 0 NOT NULL,
	"commission_rate" double precision DEFAULT 0 NOT NULL,
	"vat_rate" double precision DEFAULT 0 NOT NULL,
	"vat_amount" double precision DEFAULT 0 NOT NULL,
	"vat_included" boolean DEFAULT true NOT NULL,
	"commission_before_vat" double precision DEFAULT 0 NOT NULL,
	"contract_rate" double precision DEFAULT 0 NOT NULL,
	"expected_amount" double precision DEFAULT 0 NOT NULL,
	"actual_deducted" double precision DEFAULT 0 NOT NULL,
	"variance_amount" double precision DEFAULT 0 NOT NULL,
	"carried_in_amount" double precision DEFAULT 0 NOT NULL,
	"carried_out_amount" double precision DEFAULT 0 NOT NULL,
	"carried_from_month" text DEFAULT '' NOT NULL,
	"carried_to_month" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"confirmed_by_employee_id" integer CONSTRAINT "provider_settlements_confirmed_by_employee_id_employees_id_fkey" REFERENCES "employees"("id") ON DELETE SET NULL,
	"confirmed_by_name" text DEFAULT '' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_by_employee_id" integer CONSTRAINT "provider_settlements_created_by_employee_id_employees_id_fkey" REFERENCES "employees"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_settlement_payments" (
	"id" serial PRIMARY KEY,
	"settlement_id" integer NOT NULL REFERENCES "provider_settlements"("id") ON DELETE CASCADE,
	"payment_date" date NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer REFERENCES "employees"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "min_shift_hours" double precision DEFAULT 4 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cash_expenses_invoice_unique_idx" ON "cash_expenses" ("branch_id","invoice_number") WHERE invoice_number <> '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_expenses_branch_date_idx" ON "cash_expenses" ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_expenses_closing_idx" ON "cash_expenses" ("closing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_notifications_employee_idx" ON "cash_notifications" ("employee_id","is_read");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_cash_closings_period_unique_idx" ON "monthly_cash_closings" ("branch_id","period_year","period_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monthly_cash_closings_status_idx" ON "monthly_cash_closings" ("status","period_year","period_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_settlement_payments_settlement_idx" ON "provider_settlement_payments" ("settlement_id","payment_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_settlements_branch_period_idx" ON "provider_settlements" ("branch_id","period_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_settlements_provider_idx" ON "provider_settlements" ("provider_type","provider_name");
