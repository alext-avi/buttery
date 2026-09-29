CREATE TABLE "change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"label" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"connection_id" uuid,
	"cause_observation_id" uuid,
	"cause_proposal_id" uuid,
	"reverts_change_set_id" uuid,
	"reverted_by_change_set_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"change_set_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"lot_id" uuid,
	"food_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"cause_observation_id" uuid,
	"cause_proposal_op_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" text,
	"perishability" text NOT NULL,
	"shelf_life" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_location" text,
	"default_package" jsonb,
	"is_staple" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"household_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_household_id_tool_key_pk" PRIMARY KEY("household_id","tool","key")
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"food_id" uuid NOT NULL,
	"location" text NOT NULL,
	"state" text DEFAULT 'sealed' NOT NULL,
	"quantity" jsonb NOT NULL,
	"package" jsonb,
	"expires" jsonb,
	"printed_expiry_on" date,
	"acquired_on" date,
	"opened_on" date,
	"frozen_on" date,
	"thawed_on" date,
	"last_evidence_at" timestamp with time zone,
	"last_evidence_observation_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"connection_id" uuid,
	"payload" jsonb NOT NULL,
	"fingerprint" text,
	"near_key" text,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "observations_fingerprint" UNIQUE("household_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "proposal_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"source_line_id" text,
	"target_food_id" uuid,
	"target_lot_id" uuid,
	"payload" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"rationale" text,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"based_on_version" integer,
	"decision" text DEFAULT 'pending' NOT NULL,
	"applied_at" timestamp with time zone,
	"result_change_set_id" uuid,
	"reasoning_call_id" uuid,
	CONSTRAINT "proposal_ops_seq" UNIQUE("proposal_id","seq")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reasoning_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"function" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"path" text NOT NULL,
	"input_hash" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"valid" boolean NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_cause_observation_id_observations_id_fk" FOREIGN KEY ("cause_observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_cause_proposal_id_proposals_id_fk" FOREIGN KEY ("cause_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_change_set_id_change_sets_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_cause_observation_id_observations_id_fk" FOREIGN KEY ("cause_observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_cause_proposal_op_id_proposal_ops_id_fk" FOREIGN KEY ("cause_proposal_op_id") REFERENCES "public"."proposal_ops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foods" ADD CONSTRAINT "foods_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_ops" ADD CONSTRAINT "proposal_ops_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_ops" ADD CONSTRAINT "proposal_ops_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_ops" ADD CONSTRAINT "proposal_ops_target_food_id_foods_id_fk" FOREIGN KEY ("target_food_id") REFERENCES "public"."foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_ops" ADD CONSTRAINT "proposal_ops_target_lot_id_lots_id_fk" FOREIGN KEY ("target_lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reasoning_calls" ADD CONSTRAINT "reasoning_calls_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_sets_household_created" ON "change_sets" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "changes_lot" ON "changes" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "changes_set" ON "changes" USING btree ("change_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "foods_household_name" ON "foods" USING btree ("household_id","normalized_name");--> statement-breakpoint
CREATE INDEX "lots_household_status" ON "lots" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "lots_food" ON "lots" USING btree ("food_id");--> statement-breakpoint
CREATE INDEX "observations_near_key" ON "observations" USING btree ("household_id","near_key");