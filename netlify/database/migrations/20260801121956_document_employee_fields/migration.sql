ALTER TABLE "document_identity_fields" ADD COLUMN "show_job_title" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_identity_fields" ADD COLUMN "show_department" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_identity_fields" ADD COLUMN "show_branch" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_identity_fields" ADD COLUMN "show_manager" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_identity_fields" ADD COLUMN "show_hired_at" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_identity_fields" ADD COLUMN "show_employee_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "document_identity_fields" ADD COLUMN "show_employee_phone" boolean DEFAULT true NOT NULL;