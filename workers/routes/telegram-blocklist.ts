/**
 * Blocking senders from Telegram: `/senders` ranks who mails you most,
 * `/blocked` lists and unblocks, `/block` and `/unblock` take an address,
 * and the Block button on a notification blocks that email's sender.
 *
 * Lists with buttons can't put addresses in `callback_data` (64-byte cap),
 * so each list is snapshotted in R2 under its message ID and buttons carry
 * an index into it.
 */

import { getMailboxStub, listMailboxes } from "../lib/email-helpers";
import {
	blockSender,
	unblockSender,
	getBlocklist,
	normalizeAddress,
} from "../lib/blocklist";
import {
	sendMessage,
	editMessageText,
	answerCallbackQuery,
	escapeTelegramHtml,
	truncateText,
	TelegramAction,
	type InlineKeyboardButton,
	type TelegramConfig,
} from "../lib/telegram";
import type { Env } from "../types";

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const TOP_N = 10;
const BUTTON_LABEL_LENGTH = 40;

// ── Block / unblock ────────────────────────────────────────────────

/**
 * Add `address` to the blocklist and sweep its existing inbox mail into Spam
 * across every mailbox. Returns how many emails moved.
 */
export async function blockAndSweep(env: Env, address: string): Promise<number> {
	const sender = normalizeAddress(address);
	await blockSender(env.BUCKET, sender);
	const mailboxes = await listMailboxes(env.BUCKET);
	const moved = await Promise.all(
		mailboxes.map((m) => getMailboxStub(env, m.id).moveSenderToSpam(sender)),
	);
	return moved.reduce((a, b) => a + b, 0);
}

// ── List snapshots ─────────────────────────────────────────────────

type ListKind = "senders" | "blocked";

interface ListSnapshot {
	kind: ListKind;
	items: string[];
	/** Senders only: lookback window, so a re-render keeps the same title. */
	days?: number;
	stats?: Record<string, { total: number; recipients: number }>;
}

function snapshotKey(chatId: number, messageId: number): string {
	return `telegram/lists/${chatId}/${messageId}.json`;
}

async function saveSnapshot(env: Env, chatId: number, messageId: number, snap: ListSnapshot) {
	await env.BUCKET.put(snapshotKey(chatId, messageId), JSON.stringify(snap));
}

async function loadSnapshot(env: Env, chatId: number, messageId: number): Promise<ListSnapshot | null> {
	const obj = await env.BUCKET.get(snapshotKey(chatId, messageId));
	if (!obj) return null;
	try {
		return await obj.json<ListSnapshot>();
	} catch {
		return null;
	}
}

// ── Rendering ──────────────────────────────────────────────────────

function renderList(snap: ListSnapshot): { text: string; keyboard: InlineKeyboardButton[][] } {
	if (snap.kind === "senders") {
		if (snap.items.length === 0) {
			return { text: `No unblocked senders in the last ${snap.days} days.`, keyboard: [] };
		}
		const lines = snap.items.map((addr, i) => {
			const st = snap.stats?.[addr];
			const to = st && st.recipients > 1 ? `, to ${st.recipients} addresses` : "";
			return `${i + 1}. <code>${escapeTelegramHtml(truncateText(addr, 60))}</code>: ${st?.total ?? 0} emails${to}`;
		});
		return {
			text: [`<b>Top senders, last ${snap.days} days</b>`, "", ...lines, "", "Tap a sender to block it."].join("\n"),
			keyboard: snap.items.map((addr, i) => [
				{ text: `🚫 ${i + 1}. ${truncateText(addr, BUTTON_LABEL_LENGTH)}`, callback_data: `${TelegramAction.SENDER_BLOCK}${i}` },
			]),
		};
	}

	if (snap.items.length === 0) return { text: "No blocked senders.", keyboard: [] };
	const lines = snap.items.map((addr, i) => `${i + 1}. <code>${escapeTelegramHtml(truncateText(addr, 60))}</code>`);
	return {
		text: [`<b>Blocked senders (${snap.items.length})</b>`, "", ...lines, "", "Tap to unblock."].join("\n"),
		keyboard: snap.items.map((addr, i) => [
			{ text: `✅ ${i + 1}. ${truncateText(addr, BUTTON_LABEL_LENGTH)}`, callback_data: `${TelegramAction.SENDER_UNBLOCK}${i}` },
		]),
	};
}

// ── Commands ───────────────────────────────────────────────────────

export async function handleSendersCommand(
	env: Env,
	config: TelegramConfig,
	chatId: number,
	arg: string,
): Promise<void> {
	const requested = Number.parseInt(arg, 10);
	const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_DAYS) : DEFAULT_DAYS;
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

	const [mailboxes, blocked] = await Promise.all([listMailboxes(env.BUCKET), getBlocklist(env.BUCKET)]);
	const blockedSet = new Set(blocked.map((b) => b.address));

	// A sender can reach several mailboxes, so merge before ranking.
	const merged = new Map<string, { total: number; recipients: number }>();
	const perMailbox = await Promise.all(
		mailboxes.map((m) => getMailboxStub(env, m.id).getTopSenders(since, 100)),
	);
	for (const rows of perMailbox) {
		for (const row of rows) {
			const prev = merged.get(row.sender) ?? { total: 0, recipients: 0 };
			merged.set(row.sender, { total: prev.total + row.total, recipients: prev.recipients + row.recipients });
		}
	}

	const ranked = [...merged.entries()]
		.filter(([sender]) => !blockedSet.has(sender))
		.sort((a, b) => b[1].total - a[1].total)
		.slice(0, TOP_N);

	const snap: ListSnapshot = {
		kind: "senders",
		items: ranked.map(([sender]) => sender),
		days,
		stats: Object.fromEntries(ranked),
	};
	const { text, keyboard } = renderList(snap);
	const sent = await sendMessage(config, {
		chatId,
		text,
		...(keyboard.length ? { replyMarkup: { inline_keyboard: keyboard } } : {}),
	});
	if (keyboard.length) await saveSnapshot(env, chatId, sent.message_id, snap);
}

export async function handleBlockedCommand(env: Env, config: TelegramConfig, chatId: number): Promise<void> {
	const snap: ListSnapshot = {
		kind: "blocked",
		items: (await getBlocklist(env.BUCKET)).map((b) => b.address).sort(),
	};
	const { text, keyboard } = renderList(snap);
	const sent = await sendMessage(config, {
		chatId,
		text,
		...(keyboard.length ? { replyMarkup: { inline_keyboard: keyboard } } : {}),
	});
	if (keyboard.length) await saveSnapshot(env, chatId, sent.message_id, snap);
}

export async function handleBlockCommand(env: Env, config: TelegramConfig, chatId: number, arg: string): Promise<void> {
	const address = normalizeAddress(arg);
	if (!EMAIL_RE.test(address)) {
		await sendMessage(config, { chatId, text: "Usage: <code>/block name@example.com</code>" });
		return;
	}
	const moved = await blockAndSweep(env, address);
	await sendMessage(config, {
		chatId,
		text: `🚫 Blocked <code>${escapeTelegramHtml(address)}</code>. ${moved} existing email${moved === 1 ? "" : "s"} moved to Spam.`,
	});
}

export async function handleUnblockCommand(env: Env, config: TelegramConfig, chatId: number, arg: string): Promise<void> {
	const address = normalizeAddress(arg);
	if (!EMAIL_RE.test(address)) {
		await sendMessage(config, { chatId, text: "Usage: <code>/unblock name@example.com</code>" });
		return;
	}
	const removed = await unblockSender(env.BUCKET, address);
	await sendMessage(config, {
		chatId,
		text: removed
			? `✅ Unblocked <code>${escapeTelegramHtml(address)}</code>. Mail already in Spam stays there.`
			: `<code>${escapeTelegramHtml(address)}</code> was not blocked.`,
	});
}

// ── Button taps ────────────────────────────────────────────────────

/** Returns true when `data` was a list button and has been handled. */
export async function handleBlocklistCallback(
	env: Env,
	config: TelegramConfig,
	queryId: string,
	data: string,
	chatId: number,
	messageId: number,
): Promise<boolean> {
	const isBlock = data.startsWith(TelegramAction.SENDER_BLOCK);
	const isUnblock = data.startsWith(TelegramAction.SENDER_UNBLOCK);
	if (!isBlock && !isUnblock) return false;

	const prefix = isBlock ? TelegramAction.SENDER_BLOCK : TelegramAction.SENDER_UNBLOCK;
	const snap = await loadSnapshot(env, chatId, messageId);
	const index = Number(data.slice(prefix.length));
	const address = snap?.items[index];
	if (!snap || !address || snap.kind !== (isBlock ? "senders" : "blocked")) {
		await answerCallbackQuery(config, queryId, "This list has expired. Run the command again.");
		return true;
	}

	if (isBlock) {
		const moved = await blockAndSweep(env, address);
		await answerCallbackQuery(config, queryId, `Blocked. ${moved} moved to Spam.`);
	} else {
		await unblockSender(env.BUCKET, address);
		await answerCallbackQuery(config, queryId, "Unblocked");
	}

	// Re-render without the handled entry so the remaining buttons keep working.
	snap.items.splice(index, 1);
	const { text, keyboard } = renderList(snap);
	await editMessageText(config, {
		chatId,
		messageId,
		text,
		replyMarkup: { inline_keyboard: keyboard },
	}).catch((e) => console.error("Telegram list re-render failed:", (e as Error).message));
	await saveSnapshot(env, chatId, messageId, snap);
	return true;
}
