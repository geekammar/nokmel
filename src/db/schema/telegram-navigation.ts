import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { category } from "./catalog";
import { telegramConnection } from "./telegram-connections";
import { store } from "./tenant";

/**
 * `telegram_navigation_context` — the return context of one storefront screen.
 *
 * An inline-keyboard callback can only carry 64 bytes and must never carry raw
 * search terms or buyer data. The keyboard therefore carries a short opaque
 * token, and the server resolves it against this table using the already
 * verified store, connection, bot, private chat and buyer identity.
 *
 * The row is deliberately not an active-message lifecycle or a cart/order
 * record: it only remembers which list, category or search page the buyer was
 * viewing. Cart contents, checkout state, orders and receipts stay in their
 * existing commerce tables.
 */
export type TelegramNavigationRoute =
  | "home"
  | "products"
  | "categories"
  | "category"
  | "search";

export const telegramNavigationContext = pgTable(
  "telegram_navigation_context",
  {
    storeId: uuid("store_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    botId: bigint("bot_id", { mode: "number" }).notNull(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    navigationToken: text("navigation_token").notNull(),
    route: text("route").notNull(),
    page: integer("page").notNull().default(1),
    query: text("query"),
    categoryId: uuid("category_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "telegram_navigation_context_pkey",
      columns: [
        table.storeId,
        table.connectionId,
        table.botId,
        table.telegramUserId,
        table.telegramChatId,
        table.navigationToken,
      ],
    }),
    index("telegram_navigation_context_expires_idx").on(table.expiresAt),
    index("telegram_navigation_context_category_idx").on(table.categoryId),
    foreignKey({
      name: "telegram_navigation_context_store_fk",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "telegram_navigation_context_connection_fk",
      columns: [table.connectionId],
      foreignColumns: [telegramConnection.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "telegram_navigation_context_category_fk",
      columns: [table.categoryId],
      foreignColumns: [category.id],
    }).onDelete("cascade"),
    check(
      "telegram_navigation_context_route_check",
      sql`${table.route} IN ('home', 'products', 'categories', 'category', 'search')`,
    ),
    check(
      "telegram_navigation_context_page_check",
      sql`${table.page} >= 1 AND ${table.page} <= 99999`,
    ),
    check(
      "telegram_navigation_context_bot_positive_check",
      sql`${table.botId} > 0`,
    ),
    check(
      "telegram_navigation_context_user_positive_check",
      sql`${table.telegramUserId} > 0`,
    ),
    check(
      "telegram_navigation_context_chat_positive_check",
      sql`${table.telegramChatId} > 0`,
    ),
    check(
      "telegram_navigation_context_query_length_check",
      sql`${table.query} IS NULL OR char_length(${table.query}) BETWEEN 1 AND 80`,
    ),
    check(
      "telegram_navigation_context_route_payload_check",
      sql`(
        (${table.route} = 'search' AND ${table.query} IS NOT NULL AND ${table.categoryId} IS NULL)
        OR (${table.route} = 'category' AND ${table.categoryId} IS NOT NULL AND ${table.query} IS NULL)
        OR (${table.route} IN ('home', 'products', 'categories') AND ${table.query} IS NULL AND ${table.categoryId} IS NULL)
      )`,
    ),
  ],
);
