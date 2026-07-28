CREATE TABLE "password_reset_requests" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"requested_identifier" text DEFAULT '' NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_channel" text DEFAULT '' NOT NULL,
	"delivered_to" text DEFAULT '' NOT NULL,
	"issued_by_employee_id" integer,
	"ip_address" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_flags" (
	"id" serial PRIMARY KEY,
	"flag_key" text NOT NULL UNIQUE,
	"flag_value" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"set_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "face_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "password_reset_employee_idx" ON "password_reset_requests" ("employee_id","created_at");--> statement-breakpoint
CREATE INDEX "password_reset_status_idx" ON "password_reset_requests" ("status","created_at");--> statement-breakpoint
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_issued_by_employee_id_employees_id_fkey" FOREIGN KEY ("issued_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "system_flags" ADD CONSTRAINT "system_flags_set_by_employee_id_employees_id_fkey" FOREIGN KEY ("set_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;