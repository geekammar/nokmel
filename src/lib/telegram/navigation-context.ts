import "server-only";

import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  telegramNavigationContext,
  type TelegramNavigationRoute,
} from "@/db/schema";
import { isNavigationToken, UUID_REGEX } from "./tokens";

/**
 * Best-effort return context for the managed Telegram storefront.
 *
 * A callback only carries a short opaque token. The row it points to is bound
 * to the already verified store, bot connection, bot id, private chat and
 * buyer. Another store, bot, chat or buyer cannot resolve it, so a copied or
 * stale callback falls back to a safe scoped screen instead of leaking the
 * origin.
 *
 * This is intentionally narrower than the eventual active-message lifecycle:
 * it stores only navigation scope (list/category/search page), never cart
 * contents, checkout details, orders, receipts or raw callback data.
 */
export type NavigationBinding = {
  storeId: string;
  connectionId: string;
  botId: number;
  telegramUserId: number;
  telegramChatId: number;
};

export type NavigationDestination =
  | { route: "home" }
  | { route: "products"; page: number }
  | { route: "categories"; page: number }
  | { route: "category"; categoryId: string; page: number }
  | { route: "search"; query: string; page: number };

export type NavigationLookup =
  | { status: "found"; destination: NavigationDestination }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "invalid" };

export const NAVIGATION_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NAVIGATION_TOKEN_BYTES = 9;
export const NAVIGATION_CONTEXT_PRUNE_BATCH_SIZE = 25;
const SEARCH_QUERY_LIMIT = 80;

function newNavigationToken(): string {
  return crypto.randomBytes(NAVIGATION_TOKEN_BYTES).toString("base64url");
}

function validPage(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 99999;
}

function validSearchQuery(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    Array.from(value).length <= SEARCH_QUERY_LIMIT
  );
}

function destinationColumns(destination: NavigationDestination): {
  route: TelegramNavigationRoute;
  page: number;
  query: string | null;
  categoryId: string | null;
} {
  switch (destination.route) {
    case "home":
      return { route: "home", page: 1, query: null, categoryId: null };
    case "products":
      if (!validPage(destination.page)) throw new Error("Invalid navigation page");
      return {
        route: "products",
        page: destination.page,
        query: null,
        categoryId: null,
      };
    case "categories":
      if (!validPage(destination.page)) throw new Error("Invalid navigation page");
      return {
        route: "categories",
        page: destination.page,
        query: null,
        categoryId: null,
      };
    case "category":
      if (!validPage(destination.page) || !UUID_REGEX.test(destination.categoryId)) {
        throw new Error("Invalid navigation category context");
      }
      return {
        route: "category",
        page: destination.page,
        query: null,
        categoryId: destination.categoryId,
      };
    case "search":
      if (!validPage(destination.page) || !validSearchQuery(destination.query)) {
        throw new Error("Invalid navigation search context");
      }
      return {
        route: "search",
        page: destination.page,
        query: destination.query,
        categoryId: null,
      };
  }
}

/**
 * Bounded, indexed cleanup of expired navigation rows.
 *
 * Normal storefront traffic triggers this before a new context is written.
 * The delete is capped at {@link NAVIGATION_CONTEXT_PRUNE_BATCH_SIZE} rows per
 * call and walks the dedicated `expires_at` index, so it never performs an
 * unbounded scan or delete inside a Telegram handler. Rows belonging to a buyer
 * who never returns are therefore still eligible on the next context write by
 * any storefront visitor.
 *
 * Expiry is enforced by `readNavigationContext` independently of cleanup. If
 * traffic stops, expired rows can remain physically present, but they can
 * never resolve a callback; cleanup resumes on the next normal context write.
 * A failed prune is maintenance noise and must not block the current screen or
 * its context write.
 */
export async function pruneExpiredNavigationContexts(
  db: Database,
  now = new Date(),
): Promise<void> {
  try {
    await db.execute(sql`
      DELETE FROM ${telegramNavigationContext}
      WHERE ctid IN (
        SELECT ctid
        FROM ${telegramNavigationContext}
        WHERE expires_at <= ${now.toISOString()}::timestamptz
        ORDER BY expires_at
        LIMIT ${NAVIGATION_CONTEXT_PRUNE_BATCH_SIZE}
      )
    `);
  } catch {
    // Cleanup is best effort; reads still reject expired rows by timestamp.
  }
}

/**
 * Persists the origin before the screen is rendered and returns the opaque
 * token placed on its product buttons. A normal successful render triggers the
 * bounded global cleanup described above before inserting the new row.
 */
export async function rememberNavigationContext(
  db: Database,
  binding: NavigationBinding,
  destination: NavigationDestination,
): Promise<string> {
  const columns = destinationColumns(destination);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + NAVIGATION_CONTEXT_TTL_MS);

  await pruneExpiredNavigationContexts(db, now);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const navigationToken = newNavigationToken();
    const [inserted] = await db
      .insert(telegramNavigationContext)
      .values({
        storeId: binding.storeId,
        connectionId: binding.connectionId,
        botId: binding.botId,
        telegramUserId: binding.telegramUserId,
        telegramChatId: binding.telegramChatId,
        navigationToken,
        ...columns,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ navigationToken: telegramNavigationContext.navigationToken });

    if (inserted) return navigationToken;
  }

  throw new Error("Could not allocate a navigation context token");
}

function destinationFromRow(row: {
  route: string;
  page: number;
  query: string | null;
  categoryId: string | null;
}): NavigationDestination | null {
  if (!validPage(row.page)) return null;

  switch (row.route) {
    case "home":
      return row.query === null && row.categoryId === null
        ? { route: "home" }
        : null;
    case "products":
      return row.query === null && row.categoryId === null
        ? { route: "products", page: row.page }
        : null;
    case "categories":
      return row.query === null && row.categoryId === null
        ? { route: "categories", page: row.page }
        : null;
    case "category":
      return row.query === null &&
        row.categoryId !== null &&
        UUID_REGEX.test(row.categoryId)
        ? { route: "category", categoryId: row.categoryId, page: row.page }
        : null;
    case "search":
      return row.categoryId === null &&
        row.query !== null &&
        validSearchQuery(row.query)
        ? { route: "search", query: row.query, page: row.page }
        : null;
    default:
      return null;
  }
}

export async function readNavigationContext(
  db: Database,
  binding: NavigationBinding,
  navigationToken: string,
): Promise<NavigationLookup> {
  if (!isNavigationToken(navigationToken)) return { status: "missing" };

  const [row] = await db
    .select({
      route: telegramNavigationContext.route,
      page: telegramNavigationContext.page,
      query: telegramNavigationContext.query,
      categoryId: telegramNavigationContext.categoryId,
      expiresAt: telegramNavigationContext.expiresAt,
    })
    .from(telegramNavigationContext)
    .where(
      and(
        eq(telegramNavigationContext.storeId, binding.storeId),
        eq(telegramNavigationContext.connectionId, binding.connectionId),
        eq(telegramNavigationContext.botId, binding.botId),
        eq(telegramNavigationContext.telegramUserId, binding.telegramUserId),
        eq(telegramNavigationContext.telegramChatId, binding.telegramChatId),
        eq(telegramNavigationContext.navigationToken, navigationToken),
      ),
    )
    .limit(1);

  if (!row) return { status: "missing" };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };

  const destination = destinationFromRow(row);
  return destination
    ? { status: "found", destination }
    : { status: "invalid" };
}
