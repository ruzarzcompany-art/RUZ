ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "min_shift_hours" double precision DEFAULT 4 NOT NULL;
