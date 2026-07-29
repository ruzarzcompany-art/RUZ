CREATE TABLE "cashier_closing_lines" (
	"id" serial PRIMARY KEY,
	"closing_id" integer NOT NULL,
	"category" text DEFAULT 'network' NOT NULL,
	"label" text NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "advances" ADD COLUMN "installment_months" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "cashier_closings" ADD COLUMN "foodics_sales" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "face_templates" ADD COLUMN "slot" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "price_mode" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
DROP INDEX "face_templates_employee_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "face_templates_employee_unique_idx" ON "face_templates" ("employee_id","slot");--> statement-breakpoint
CREATE INDEX "cashier_closing_lines_closing_idx" ON "cashier_closing_lines" ("closing_id","category");--> statement-breakpoint
ALTER TABLE "cashier_closing_lines" ADD CONSTRAINT "cashier_closing_lines_closing_id_cashier_closings_id_fkey" FOREIGN KEY ("closing_id") REFERENCES "cashier_closings"("id") ON DELETE CASCADE;