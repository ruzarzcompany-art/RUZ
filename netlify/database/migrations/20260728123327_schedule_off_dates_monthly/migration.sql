CREATE TABLE "schedule_off_dates" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"off_date" date NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_schedules" ADD COLUMN "off_mode" text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_off_dates_unique_idx" ON "schedule_off_dates" ("employee_id","off_date");--> statement-breakpoint
CREATE INDEX "schedule_off_dates_date_idx" ON "schedule_off_dates" ("off_date");--> statement-breakpoint
ALTER TABLE "schedule_off_dates" ADD CONSTRAINT "schedule_off_dates_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_off_dates" ADD CONSTRAINT "schedule_off_dates_created_by_employee_id_employees_id_fkey" FOREIGN KEY ("created_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;