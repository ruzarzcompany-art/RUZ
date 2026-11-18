ALTER TABLE "provider_settlement_payments" ADD COLUMN "bank_transaction_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_settlement_payments_bank_tx_idx" ON "provider_settlement_payments" ("bank_transaction_id");
