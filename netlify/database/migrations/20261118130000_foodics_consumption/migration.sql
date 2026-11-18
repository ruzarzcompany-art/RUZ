CREATE TABLE "foodics_consumption_days" (
	"branch_id" integer NOT NULL,
	"business_date" date NOT NULL,
	"lines" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "foodics_consumption_days_key_idx" ON "foodics_consumption_days" ("branch_id","business_date");--> statement-breakpoint
ALTER TABLE "foodics_consumption_days" ADD CONSTRAINT "foodics_consumption_days_branch_id_branches_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE;
