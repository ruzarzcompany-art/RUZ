ALTER TABLE "foodics_stock_docs" ADD COLUMN "supplier_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "foodics_stock_docs" ADD COLUMN "supplier_rep" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "foodics_stock_docs" ADD COLUMN "supplier_phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "foodics_stock_docs" ADD COLUMN "entered_by" text DEFAULT '' NOT NULL;
