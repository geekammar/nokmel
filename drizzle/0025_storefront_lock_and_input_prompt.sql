CREATE TABLE "telegram_storefront_lock" (
	"store_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"bot_id" bigint NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"owner_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_storefront_lock_pkey" PRIMARY KEY("store_id","connection_id","bot_id","telegram_user_id","telegram_chat_id"),
	CONSTRAINT "telegram_storefront_lock_owner_check" CHECK (char_length("telegram_storefront_lock"."owner_token") BETWEEN 1 AND 128),
	CONSTRAINT "telegram_storefront_lock_bot_positive_check" CHECK ("telegram_storefront_lock"."bot_id" > 0),
	CONSTRAINT "telegram_storefront_lock_user_positive_check" CHECK ("telegram_storefront_lock"."telegram_user_id" > 0),
	CONSTRAINT "telegram_storefront_lock_chat_positive_check" CHECK ("telegram_storefront_lock"."telegram_chat_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "telegram_active_storefront" ADD COLUMN "input_prompt_message_id" bigint;--> statement-breakpoint
ALTER TABLE "telegram_storefront_lock" ADD CONSTRAINT "telegram_storefront_lock_store_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_storefront_lock" ADD CONSTRAINT "telegram_storefront_lock_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."telegram_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_active_storefront" ADD CONSTRAINT "telegram_active_storefront_prompt_positive_check" CHECK ("telegram_active_storefront"."input_prompt_message_id" IS NULL OR "telegram_active_storefront"."input_prompt_message_id" > 0);