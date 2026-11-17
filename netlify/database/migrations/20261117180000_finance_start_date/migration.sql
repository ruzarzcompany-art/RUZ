CREATE TABLE "finance_settings" (
	"branch_id" integer PRIMARY KEY NOT NULL,
	"start_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
