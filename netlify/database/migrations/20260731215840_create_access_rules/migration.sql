CREATE TABLE "access_rules" (
	"id" serial PRIMARY KEY,
	"scope_type" text NOT NULL,
	"employee_id" integer,
	"scope_key" text NOT NULL,
	"module_key" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"granted_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "access_rules_scope_module_unique_idx" ON "access_rules" ("scope_type","scope_key","module_key");--> statement-breakpoint
CREATE INDEX "access_rules_scope_idx" ON "access_rules" ("scope_type","scope_key");--> statement-breakpoint
CREATE INDEX "access_rules_employee_idx" ON "access_rules" ("employee_id");--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_granted_by_employee_id_employees_id_fkey" FOREIGN KEY ("granted_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;