CREATE TABLE "advances" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"request_date" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"deduct_from_payroll" boolean DEFAULT true NOT NULL,
	"deduction_month" text,
	"decision_note" text DEFAULT '' NOT NULL,
	"decided_by_employee_id" integer,
	"decided_at" timestamp with time zone,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY,
	"actor_employee_id" integer,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer,
	"before_json" text,
	"after_json" text,
	"reason" text DEFAULT '' NOT NULL,
	"ip_address" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonuses" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"bonus_date" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"contract_number" text NOT NULL UNIQUE,
	"job_title" text DEFAULT '' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"basic_salary" double precision DEFAULT 0 NOT NULL,
	"allowances_total" double precision DEFAULT 0 NOT NULL,
	"probation_months" integer DEFAULT 3 NOT NULL,
	"working_hours" text DEFAULT '8 ساعات يومياً / 6 أيام أسبوعياً' NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"signed_at" date,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custody_items" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"item_name" text NOT NULL,
	"item_type" text DEFAULT 'other' NOT NULL,
	"serial_number" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"estimated_value" double precision DEFAULT 0 NOT NULL,
	"issued_at" date NOT NULL,
	"due_return_at" date,
	"returned_at" date,
	"condition_note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "face_templates" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"algorithm" text DEFAULT 'face-api:faceRecognitionNet@1.7' NOT NULL,
	"dimensions" integer DEFAULT 128 NOT NULL,
	"encrypted_template" text NOT NULL,
	"key_version" text DEFAULT 'v1' NOT NULL,
	"enrolled_by_employee_id" integer,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"leave_type" text DEFAULT 'annual' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"days" double precision DEFAULT 0 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_note" text DEFAULT '' NOT NULL,
	"decided_by_employee_id" integer,
	"decided_at" timestamp with time zone,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overtime_requests" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"work_date" date NOT NULL,
	"hours" double precision DEFAULT 0 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_note" text DEFAULT '' NOT NULL,
	"decided_by_employee_id" integer,
	"decided_at" timestamp with time zone,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_slips" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"basic_salary" double precision DEFAULT 0 NOT NULL,
	"allowances_total" double precision DEFAULT 0 NOT NULL,
	"overtime_hours" double precision DEFAULT 0 NOT NULL,
	"overtime_amount" double precision DEFAULT 0 NOT NULL,
	"bonuses_amount" double precision DEFAULT 0 NOT NULL,
	"advances_amount" double precision DEFAULT 0 NOT NULL,
	"deducted_hours" double precision DEFAULT 0 NOT NULL,
	"hours_deduction_amount" double precision DEFAULT 0 NOT NULL,
	"other_deductions" double precision DEFAULT 0 NOT NULL,
	"worked_hours" double precision DEFAULT 0 NOT NULL,
	"net_pay" double precision DEFAULT 0 NOT NULL,
	"hourly_rate" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"generated_by_employee_id" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_definitions" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"basic_salary" double precision DEFAULT 0 NOT NULL,
	"housing_allowance" double precision DEFAULT 0 NOT NULL,
	"transport_allowance" double precision DEFAULT 0 NOT NULL,
	"other_allowances" double precision DEFAULT 0 NOT NULL,
	"hourly_rate" double precision,
	"contract_hours_per_month" double precision DEFAULT 240 NOT NULL,
	"overtime_multiplier" double precision DEFAULT 1.5 NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"effective_from" date,
	"note" text DEFAULT '' NOT NULL,
	"updated_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" serial PRIMARY KEY,
	"voucher_number" text NOT NULL UNIQUE,
	"type" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"voucher_date" date NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"employee_id" integer,
	"method" text DEFAULT 'cash' NOT NULL,
	"beneficiary_name" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "source" text DEFAULT 'device' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "face_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "face_distance" double precision;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "created_by_employee_id" integer;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "corrected_by_employee_id" integer;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "original_server_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "deducted_hours" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "advances_employee_idx" ON "advances" ("employee_id","request_date");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_time_idx" ON "audit_logs" ("actor_employee_id","created_at");--> statement-breakpoint
CREATE INDEX "bonuses_employee_idx" ON "bonuses" ("employee_id","bonus_date");--> statement-breakpoint
CREATE INDEX "contracts_employee_idx" ON "contracts" ("employee_id");--> statement-breakpoint
CREATE INDEX "custody_items_employee_idx" ON "custody_items" ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "face_templates_employee_unique_idx" ON "face_templates" ("employee_id");--> statement-breakpoint
CREATE INDEX "leave_requests_employee_idx" ON "leave_requests" ("employee_id","start_date");--> statement-breakpoint
CREATE INDEX "overtime_requests_employee_idx" ON "overtime_requests" ("employee_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_slips_period_unique_idx" ON "payroll_slips" ("employee_id","period_year","period_month");--> statement-breakpoint
CREATE UNIQUE INDEX "salary_definitions_employee_unique_idx" ON "salary_definitions" ("employee_id");--> statement-breakpoint
CREATE INDEX "vouchers_type_date_idx" ON "vouchers" ("type","voucher_date");--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_decided_by_employee_id_employees_id_fkey" FOREIGN KEY ("decided_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "advances" ADD CONSTRAINT "advances_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_corrected_by_employee_id_employees_id_fkey" FOREIGN KEY ("corrected_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_employee_id_employees_id_fkey" FOREIGN KEY ("actor_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "custody_items" ADD CONSTRAINT "custody_items_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custody_items" ADD CONSTRAINT "custody_items_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "face_templates" ADD CONSTRAINT "face_templates_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "face_templates" ADD CONSTRAINT "face_templates_enrolled_by_employee_id_employees_id_fkey" FOREIGN KEY ("enrolled_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_employee_id_employees_id_fkey" FOREIGN KEY ("decided_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_decided_by_employee_id_employees_id_fkey" FOREIGN KEY ("decided_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payroll_slips" ADD CONSTRAINT "payroll_slips_generated_by_employee_id_employees_id_fkey" FOREIGN KEY ("generated_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "salary_definitions" ADD CONSTRAINT "salary_definitions_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "salary_definitions" ADD CONSTRAINT "salary_definitions_updated_by_employee_id_employees_id_fkey" FOREIGN KEY ("updated_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;