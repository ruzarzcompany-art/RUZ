ALTER TABLE "provider_settlements" ADD COLUMN IF NOT EXISTS "contract_rate" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_settlements" ADD COLUMN IF NOT EXISTS "expected_amount" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_settlements" ADD COLUMN IF NOT EXISTS "actual_deducted" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_settlements" ADD COLUMN IF NOT EXISTS "variance_amount" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_settlements" ADD COLUMN IF NOT EXISTS "carried_in_amount" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_settlements" ADD COLUMN IF NOT EXISTS "carried_out_amount" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_settlements" ADD COLUMN IF NOT EXISTS "carried_from_month" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_settlements" ADD COLUMN IF NOT EXISTS "carried_to_month" text DEFAULT '' NOT NULL;--> statement-breakpoint
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
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_settlement_payments_settlement_idx" ON "provider_settlement_payments" ("settlement_id","payment_date");
