CREATE TABLE "document_identity_fields" (
	"id" serial PRIMARY KEY,
	"doc_key" text NOT NULL UNIQUE,
	"show_logo" boolean DEFAULT true NOT NULL,
	"show_company_name" boolean DEFAULT true NOT NULL,
	"show_company_name_en" boolean DEFAULT true NOT NULL,
	"show_commercial_register" boolean DEFAULT true NOT NULL,
	"show_tax_number" boolean DEFAULT true NOT NULL,
	"show_address" boolean DEFAULT true NOT NULL,
	"show_city" boolean DEFAULT true NOT NULL,
	"show_country" boolean DEFAULT true NOT NULL,
	"show_phone" boolean DEFAULT true NOT NULL,
	"show_email" boolean DEFAULT true NOT NULL,
	"show_website" boolean DEFAULT true NOT NULL,
	"show_header_note" boolean DEFAULT true NOT NULL,
	"show_footer" boolean DEFAULT true NOT NULL,
	"show_footer_note" boolean DEFAULT true NOT NULL,
	"show_signatures" boolean DEFAULT true NOT NULL,
	"show_watermark" boolean DEFAULT true NOT NULL,
	"updated_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_identity_fields" ADD CONSTRAINT "document_identity_fields_uEITDyXPsba5_fkey" FOREIGN KEY ("updated_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL;