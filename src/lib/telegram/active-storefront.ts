import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  telegramActiveStorefront,
  telegramStorefrontLock,
  type TelegramStorefrontInputMode,
  type TelegramStorefrontRoute,
} from "@/db/schema";

export type ActiveStorefrontBinding = {
  storeId: string;
  connectionId: string;
  botId: number;
  telegramUserId: number;
  telegramChatId: number;
};

export type ActiveStorefront = {
  messageId: number;
  hasMedia: boolean;
  route: TelegramStorefrontRoute;
  inputMode: TelegramStorefrontInputMode;
  inputPromptMessageId: number | null;
  revision: number;
  lastUpdateId: number;
};

export const STOREFRONT_LOCK_LEASE_MS = 45_000;

export class StorefrontScopeBusyError extends Error {
  constructor() {
    super("Another storefront update is currently being processed");
    this.name = "StorefrontScopeBusyError";
  }
}

function keyFilter(binding: ActiveStorefrontBinding) {
  return and(
    eq(telegramActiveStorefront.storeId, binding.storeId),
    eq(
      telegramActiveStorefront.connectionId,
      binding.connectionId,
    ),
    eq(telegramActiveStorefront.botId, binding.botId),
    eq(
      telegramActiveStorefront.telegramUserId,
      binding.telegramUserId,
    ),
    eq(
      telegramActiveStorefront.telegramChatId,
      binding.telegramChatId,
    ),
  );
}

function keyColumns(binding: ActiveStorefrontBinding) {
  return {
    storeId: binding.storeId,
    connectionId: binding.connectionId,
    botId: binding.botId,
    telegramUserId: binding.telegramUserId,
    telegramChatId: binding.telegramChatId,
  };
}

/**
 * Reads the current active screen for an already verified scope. A missing row
 * simply means no active message has been recorded yet.
 */
export async function readActiveStorefront(
  db: Database,
  binding: ActiveStorefrontBinding,
): Promise<ActiveStorefront | null> {
  const [row] = await db
    .select({
      messageId: telegramActiveStorefront.activeMessageId,
      hasMedia: telegramActiveStorefront.hasMedia,
      route: telegramActiveStorefront.route,
      inputMode: telegramActiveStorefront.inputMode,
      inputPromptMessageId: telegramActiveStorefront.inputPromptMessageId,
      revision: telegramActiveStorefront.revision,
      lastUpdateId: telegramActiveStorefront.lastUpdateId,
    })
    .from(telegramActiveStorefront)
    .where(keyFilter(binding))
    .limit(1);

  if (!row) return null;

  return {
    messageId: row.messageId,
    hasMedia: row.hasMedia,
    route: row.route as TelegramStorefrontRoute,
    inputMode: row.inputMode as TelegramStorefrontInputMode,
    inputPromptMessageId: row.inputPromptMessageId ?? null,
    revision: row.revision,
    lastUpdateId: row.lastUpdateId,
  };
}

/**
 * Records a successfully rendered storefront screen. The write is fenced by
 * the Telegram update id: a delayed, older update cannot replace the state of
 * a newer screen even if it reaches the server late.
 *
 * The input mode is consumed by a rendered screen. Explicit prompts record
 * their pending mode separately.
 */
export async function recordActiveStorefront(
  db: Database,
  binding: ActiveStorefrontBinding,
  input: {
    messageId: number;
    hasMedia: boolean;
    route: TelegramStorefrontRoute;
    revision: number;
    updateId: number;
  },
): Promise<void> {
  const now = new Date();

  await db
    .insert(telegramActiveStorefront)
    .values({
      ...keyColumns(binding),
      activeMessageId: input.messageId,
      hasMedia: input.hasMedia,
      route: input.route,
      inputMode: "none",
      inputPromptMessageId: null,
      revision: input.revision,
      lastUpdateId: input.updateId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        telegramActiveStorefront.storeId,
        telegramActiveStorefront.connectionId,
        telegramActiveStorefront.botId,
        telegramActiveStorefront.telegramUserId,
        telegramActiveStorefront.telegramChatId,
      ],
      set: {
        activeMessageId: input.messageId,
        hasMedia: input.hasMedia,
        route: input.route,
        inputMode: "none",
        inputPromptMessageId: null,
        revision: input.revision,
        lastUpdateId: input.updateId,
        updatedAt: now,
      },
      where: sql`${telegramActiveStorefront.lastUpdateId} <= ${input.updateId}`,
    });
}

/**
 * Adopts a message the buyer is already interacting with before the handler
 * knows which screen will be rendered. This is used for a callback that arrives
 * on a newer message than the recorded active one (for example after a state
 * write failed) and for prompt-only actions that must keep that message active.
 */
export async function adoptActiveStorefront(
  db: Database,
  binding: ActiveStorefrontBinding,
  input: {
    messageId: number;
    hasMedia: boolean;
    updateId: number;
    route?: TelegramStorefrontRoute;
  },
): Promise<void> {
  const now = new Date();

  await db
    .insert(telegramActiveStorefront)
    .values({
      ...keyColumns(binding),
      activeMessageId: input.messageId,
      hasMedia: input.hasMedia,
      route: input.route ?? "storefront",
      inputMode: "none",
      inputPromptMessageId: null,
      revision: 1,
      lastUpdateId: input.updateId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        telegramActiveStorefront.storeId,
        telegramActiveStorefront.connectionId,
        telegramActiveStorefront.botId,
        telegramActiveStorefront.telegramUserId,
        telegramActiveStorefront.telegramChatId,
      ],
      set: {
        activeMessageId: input.messageId,
        hasMedia: input.hasMedia,
        revision: sql`${telegramActiveStorefront.revision} + 1`,
        lastUpdateId: input.updateId,
        updatedAt: now,
      },
      where: sql`${telegramActiveStorefront.lastUpdateId} <= ${input.updateId}`,
    });
}

/**
 * Marks the next expected text input (search, phone, address or transfer
 * reference). The active screen itself does not change.
 */
export async function setActiveStorefrontInputMode(
  db: Database,
  binding: ActiveStorefrontBinding,
  input: {
    inputMode: TelegramStorefrontInputMode;
    promptMessageId?: number | null;
    updateId: number;
  },
): Promise<void> {
  await db
    .update(telegramActiveStorefront)
    .set({
      inputMode: input.inputMode,
      inputPromptMessageId: input.promptMessageId ?? null,
      lastUpdateId: input.updateId,
      updatedAt: new Date(),
    })
    .where(
      and(
        keyFilter(binding),
        sql`${telegramActiveStorefront.lastUpdateId} <= ${input.updateId}`,
      ),
    );
}

/**
 * Claims the short-lived per-scope lease before any decision or Telegram
 * side effect. The caller must hold this lease until its send/edit completes.
 */
export async function acquireStorefrontLock(
  db: Database,
  binding: ActiveStorefrontBinding,
  ownerToken: string,
  leaseMs = STOREFRONT_LOCK_LEASE_MS,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);

  const [row] = await db
    .insert(telegramStorefrontLock)
    .values({
      ...keyColumns(binding),
      ownerToken,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        telegramStorefrontLock.storeId,
        telegramStorefrontLock.connectionId,
        telegramStorefrontLock.botId,
        telegramStorefrontLock.telegramUserId,
        telegramStorefrontLock.telegramChatId,
      ],
      set: {
        ownerToken,
        expiresAt,
        updatedAt: now,
      },
      where: sql`${telegramStorefrontLock.expiresAt} <= ${now.toISOString()}::timestamptz OR ${telegramStorefrontLock.ownerToken} = ${ownerToken}`,
    })
    .returning({ ownerToken: telegramStorefrontLock.ownerToken });

  return row?.ownerToken === ownerToken;
}

/**
 * Releases the lease only when this handler still owns it. A failed delete is
 * harmless: the lease expires and the next update can reclaim it.
 */
export async function releaseStorefrontLock(
  db: Database,
  binding: ActiveStorefrontBinding,
  ownerToken: string,
): Promise<void> {
  await db
    .delete(telegramStorefrontLock)
    .where(
      and(
        eq(telegramStorefrontLock.storeId, binding.storeId),
        eq(telegramStorefrontLock.connectionId, binding.connectionId),
        eq(telegramStorefrontLock.botId, binding.botId),
        eq(telegramStorefrontLock.telegramUserId, binding.telegramUserId),
        eq(telegramStorefrontLock.telegramChatId, binding.telegramChatId),
        eq(telegramStorefrontLock.ownerToken, ownerToken),
      ),
    );
}
