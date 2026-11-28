CREATE TABLE "telegram_navigation_context" (
	"store_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"bot_id" bigint NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"navigation_token" text NOT NULL,
	"route" text NOT NULL,
	"page" integer DEFAULT 1 NOT NULL,
	"query" text,
	"category_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_navigation_context_pkey" PRIMARY KEY("store_id","connection_id","bot_id","telegram_user_id","telegram_chat_id","navigation_token"),
	CONSTRAINT "telegram_navigation_context_route_check" CHECK ("telegram_navigation_context"."route" IN ('home', 'products', 'categories', 'category', 'search')),
	CONSTRAINT "telegram_navigation_context_page_check" CHECK ("telegram_navigation_context"."page" >= 1 AND "telegram_navigation_context"."page" <= 99999),
	CONSTRAINT "telegram_navigation_context_bot_positive_check" CHECK ("telegram_navigation_context"."bot_id" > 0),
	CONSTRAINT "telegram_navigation_context_user_positive_check" CHECK ("telegram_navigation_context"."telegram_user_id" > 0),
	CONSTRAINT "telegram_navigation_context_chat_positive_check" CHECK ("telegram_navigation_context"."telegram_chat_id" > 0),
	CONSTRAINT "telegram_navigation_context_query_length_check" CHECK ("telegram_navigation_context"."query" IS NULL OR char_length("telegram_navigation_context"."query") BETWEEN 1 AND 80),
	CONSTRAINT "telegram_navigation_context_route_payload_check" CHECK ((
        ("telegram_navigation_context"."route" = 'search' AND "telegram_navigation_context"."query" IS NOT NULL AND "telegram_navigation_context"."category_id" IS NULL)
        OR ("telegram_navigation_context"."route" = 'category' AND "telegram_navigation_context"."category_id" IS NOT NULL AND "telegram_navigation_context"."query" IS NULL)
        OR ("telegram_navigation_context"."route" IN ('home', 'products', 'categories') AND "telegram_navigation_context"."query" IS NULL AND "telegram_navigation_context"."category_id" IS NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "telegram_navigation_context" ADD CONSTRAINT "telegram_navigation_context_store_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_navigation_context" ADD CONSTRAINT "telegram_navigation_context_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."telegram_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_navigation_context" ADD CONSTRAINT "telegram_navigation_context_category_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_navigation_context_scope_expiry_idx" ON "telegram_navigation_context" USING btree ("store_id","connection_id","bot_id","telegram_user_id","telegram_chat_id","expires_at");--> statement-breakpoint
CREATE INDEX "telegram_navigation_context_category_idx" ON "telegram_navigation_context" USING btree ("category_id");