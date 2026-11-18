ALTER TABLE "foodics_stock_docs" ADD COLUMN "invoice_date" date;--> statement-breakpoint
ALTER TABLE "foodics_stock_docs" ADD COLUMN "invoice_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "foodics_stock_docs" ADD COLUMN "stock_posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "source_ref" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "inventory_movements_source_ref_idx" ON "inventory_movements" ("source_ref");
