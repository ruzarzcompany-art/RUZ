ALTER TABLE "inventory_movements" ADD COLUMN "produced_item_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "produced_units" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "unit_weight" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "linked_movement_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_produced_item_id_inventory_items_id_fkey" FOREIGN KEY ("produced_item_id") REFERENCES "inventory_items"("id") ON DELETE SET NULL;