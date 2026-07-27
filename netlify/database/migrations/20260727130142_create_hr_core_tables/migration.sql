CREATE TABLE "attendance_logs" (
	"id" serial PRIMARY KEY,
	"employee_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"type" text NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"client_reported_time" timestamp with time zone,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_meters" double precision,
	"distance_meters" double precision,
	"within_geofence" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"device_info" text DEFAULT '' NOT NULL,
	"ip_address" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" serial PRIMARY KEY,
	"code" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"radius_meters" integer DEFAULT 150 NOT NULL,
	"timezone" text DEFAULT 'Asia/Riyadh' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY,
	"employee_code" text NOT NULL UNIQUE,
	"full_name" text NOT NULL,
	"email" text,
	"phone" text,
	"password_hash" text NOT NULL,
	"role_id" integer,
	"branch_id" integer,
	"job_title" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"hired_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" serial PRIMARY KEY,
	"code" text NOT NULL UNIQUE,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" integer,
	"permission_id" integer,
	CONSTRAINT "role_permissions_pkey" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"name_ar" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY,
	"token_id" text NOT NULL UNIQUE,
	"employee_id" integer NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"ip_address" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attendance_logs_employee_time_idx" ON "attendance_logs" ("employee_id","server_time");--> statement-breakpoint
CREATE INDEX "attendance_logs_branch_time_idx" ON "attendance_logs" ("branch_id","server_time");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_email_unique_idx" ON "employees" ("email");--> statement-breakpoint
CREATE INDEX "employees_branch_idx" ON "employees" ("branch_id");--> statement-breakpoint
CREATE INDEX "sessions_employee_idx" ON "sessions" ("employee_id");--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_employee_id_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE;