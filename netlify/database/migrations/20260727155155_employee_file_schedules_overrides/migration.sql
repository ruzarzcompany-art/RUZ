CREATE TABLE "employee_permission_overrides" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"permission_code" text NOT NULL,
	"effect" text DEFAULT 'allow' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"granted_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_schedules" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"shift_start" text DEFAULT '09:00' NOT NULL,
	"shift_end" text DEFAULT '17:00' NOT NULL,
	"daily_hours" double precision DEFAULT 8 NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"days_off_per_month" integer DEFAULT 4 NOT NULL,
	"off_days" text DEFAULT '' NOT NULL,
	"grace_minutes" integer DEFAULT 10 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "manager_employee_id" integer;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "nationality" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "national_id" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "department" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_slips" ADD COLUMN "expected_hours" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_slips" ADD COLUMN "late_minutes" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_permission_overrides_unique_idx" ON "employee_permission_overrides" ("employee_id","permission_code");--> statement-breakpoint
CREATE INDEX "employees_national_id_idx" ON "employees" ("national_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_schedules_employee_unique_idx" ON "work_schedules" ("employee_id");--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_manager_employee_id_employees_id_fkey" FOREIGN KEY ("manager_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "employee_permission_overrides" ADD CONSTRAINT "employee_permission_overrides_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "employee_permission_overrides" ADD CONSTRAINT "employee_permission_overrides_C21GK4S28G4H_fkey" FOREIGN KEY ("granted_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_updated_by_employee_id_employees_id_fkey" FOREIGN KEY ("updated_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;