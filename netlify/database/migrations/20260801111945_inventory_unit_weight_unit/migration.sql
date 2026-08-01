ALTER TABLE "inventory_movements" ADD COLUMN "unit_weight_unit" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- الحركات القديمة كانت تُخزّن وزن الوحدة بوحدة المادة الخام، فتُوسم بوحدة صنفها
-- كي يبقى معناها كما هو تماماً تحت المعادلة الجديدة (وزن الوحدة بوحدة مستقلة).
UPDATE "inventory_movements" AS m
SET "unit_weight_unit" = i."unit"
FROM "inventory_items" AS i
WHERE m."item_id" = i."id"
  AND m."movement_type" = 'manufacture'
  AND m."unit_weight" > 0;--> statement-breakpoint
-- حركة إضافة المنتج النهائي تنسخ وزن الوحدة من حركة الخام المرتبطة بها،
-- فتأخذ وحدته منها لا من وحدة المنتج.
UPDATE "inventory_movements" AS m
SET "unit_weight_unit" = src."unit_weight_unit"
FROM "inventory_movements" AS src
WHERE m."linked_movement_id" = src."id"
  AND m."movement_type" = 'in'
  AND m."unit_weight" > 0;
