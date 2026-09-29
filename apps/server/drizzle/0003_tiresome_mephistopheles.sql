ALTER TABLE "observations" ADD COLUMN "possible_duplicate_of" uuid;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "uncertainties" jsonb DEFAULT '[]'::jsonb NOT NULL;