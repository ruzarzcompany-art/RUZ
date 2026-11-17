CREATE TABLE "bank_transactions" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"tx_date" date NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"credit" double precision DEFAULT 0 NOT NULL,
	"debit" double precision DEFAULT 0 NOT NULL,
	"balance" double precision,
	"counterparty" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"fingerprint" text NOT NULL,
	"uploaded_by_employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_rules" (
	"id" serial PRIMARY KEY,
	"branch_id" integer NOT NULL,
	"counterparty" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"mapped_name" text DEFAULT '' NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_uploaded_by_employee_id_employees_id_fk" FOREIGN KEY ("uploaded_by_employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_fp_idx" ON "bank_transactions" USING btree ("branch_id","fingerprint");
--> statement-breakpoint
CREATE INDEX "bank_transactions_branch_date_idx" ON "bank_transactions" USING btree ("branch_id","tx_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_rules_branch_cp_idx" ON "bank_rules" USING btree ("branch_id","counterparty");
