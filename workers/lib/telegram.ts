/**
 * Telegram Bot API client and message formatting.
 *
 * Powers two directions:
 *   - outbound: push a notification to a chat when new mail lands in the inbox
 *   - inbound:  map a Telegram message back to the email it announced, so
 *               button taps and text replies can act on that email
 *
 * The bot token is a secret and appears in the request URL, so it must never
 * reach a log line. Errors raised here quote the API method, never the URL.
 */

import type { Env } from "../types";

// ── Config ─────────────────────────────────────────────────────────

export interface TelegramConfig {
	botToken: string;
	/** Comma-separated chat IDs. The first is the notification target; all are allowed to act. */
	chatIds: string;
	webhookSecret?: string;
}

/**
 * Read Telegram config from the environment.
 * Returns null when the integration is not configured, which disables it
 * silently rather than failing inbound mail delivery.
 */
export function getTelegramConfig(env: Env): TelegramConfig | null {
	const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
	const chatIds = env.TELEGRAM_CHAT_ID?.trim();
	if (!botToken || !chatIds) return null;
	return {
		botToken,
		chatIds,
		webhookSecret: env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
	};
}

/** Every chat allowed to drive the bot. */
export function allowedChatIds(config: TelegramConfig): string[] {
	return config.chatIds.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The chat that receives new-email notifications (the first configured one). */
export function notifyChatId(config: TelegramConfig): string {
	return allowedChatIds(config)[0] ?? "";
}

export function isChatAllowed(config: TelegramConfig, chatId: string | number): boolean {
	return allowedChatIds(config).includes(String(chatId));
}

// ── Constant-time comparison ───────────────────────────────────────

/**
 * Compare two strings without leaking length-independent timing.
 * Used for the webhook secret so a wrong guess can't be tuned byte by byte.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const aBytes = new TextEncoder().encode(a);
	const bBytes = new TextEncoder().encode(b);
	// Length is compared explicitly; the XOR loop below runs over a fixed span
	// so equal-length candidates all cost the same.
	if (aBytes.length !== bBytes.length) return false;
	let diff = 0;
	for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
	return diff === 0;
}

// ── Bot API ────────────────────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org";

async function callTelegram<T>(
	config: TelegramConfig,
	method: string,
	payload: Record<string, unknown>,
): Promise<T> {
	const response = await fetch(`${TELEGRAM_API}/bot${config.botToken}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	const data = await response.json<{ ok: boolean; result?: T; description?: string }>();
	if (!response.ok || !data.ok) {
		// Deliberately omits the URL — it carries the bot token.
		throw new Error(`Telegram ${method} failed: ${response.status} ${data.description ?? ""}`.trim());
	}
	return data.result as T;
}

export interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

export async function sendMessage(
	config: TelegramConfig,
	params: {
		chatId: string | number;
		text: string;
		replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
		replyToMessageId?: number;
	},
): Promise<{ message_id: number }> {
	return callTelegram(config, "sendMessage", {
		chat_id: params.chatId,
		text: params.text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
		...(params.replyToMessageId ? { reply_to_message_id: params.replyToMessageId } : {}),
	});
}

export async function answerCallbackQuery(
	config: TelegramConfig,
	callbackQueryId: string,
	text: string,
): Promise<void> {
	await callTelegram(config, "answerCallbackQuery", {
		callback_query_id: callbackQueryId,
		text,
	});
}

// ── Formatting ─────────────────────────────────────────────────────

/** Telegram rejects messages over 4096 characters. */
const TELEGRAM_MAX_MESSAGE = 4096;

/**
 * Escape the three characters Telegram's HTML parse mode treats as markup.
 * Telegram only recognises a small tag whitelist, so this is the whole job.
 */
export function escapeTelegramHtml(text: string): string {
	if (!text) return "";
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Trim plain text to a length.
 *
 * Always truncate *before* escaping and before wrapping in tags. Cutting
 * assembled markup risks slicing through a tag or an entity like `&amp;`,
 * which Telegram rejects as malformed HTML.
 */
export function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1)}…`;
}

/** Telegram's hard per-message ceiling, for callers assembling their own text. */
export const TELEGRAM_MESSAGE_LIMIT = TELEGRAM_MAX_MESSAGE;

/**
 * Escape `plain` so the result fits within `budget` characters.
 *
 * Escaping expands: a string of `&` grows fivefold. Estimating the pre-escape
 * length therefore either overshoots the limit or wastes most of the budget on
 * ordinary text, so shrink and re-measure until the escaped form actually fits.
 * Returns escaped, Telegram-safe HTML that never ends mid-entity.
 */
export function fitEscaped(plain: string, budget: number): string {
	if (budget <= 0) return "";
	let candidate = plain;
	let escaped = escapeTelegramHtml(candidate);
	while (escaped.length > budget && candidate.length > 0) {
		// Scale by the observed expansion ratio, then step down to guarantee
		// progress even when the ratio rounds to the current length.
		const ratio = budget / escaped.length;
		const next = Math.min(
			Math.floor(candidate.length * ratio),
			candidate.length - 1,
		);
		candidate = candidate.slice(0, Math.max(next, 0));
		escaped = escapeTelegramHtml(candidate);
	}
	return escaped;
}

const SNIPPET_LENGTH = 500;
/** Headers are unbounded in the wire format, so cap them to keep the total in range. */
const HEADER_FIELD_LENGTH = 120;

/**
 * Render the new-email notification body.
 * `bodyText` should already be stripped to plain text.
 */
export function formatNewEmailMessage(email: {
	sender: string;
	recipient: string;
	subject: string;
	bodyText: string;
	attachmentCount: number;
}): string {
	const lines = [
		"📬 <b>New email</b>",
		"",
		`<b>From:</b> ${escapeTelegramHtml(truncateText(email.sender, HEADER_FIELD_LENGTH))}`,
		`<b>To:</b> ${escapeTelegramHtml(truncateText(email.recipient, HEADER_FIELD_LENGTH))}`,
		`<b>Subject:</b> ${escapeTelegramHtml(truncateText(email.subject || "(no subject)", HEADER_FIELD_LENGTH))}`,
	];

	if (email.attachmentCount > 0) {
		const plural = email.attachmentCount === 1 ? "" : "s";
		lines.push(`<b>Attachments:</b> ${email.attachmentCount} file${plural}`);
	}

	const footer = "<i>Reply to this message to answer by email.</i>";
	const snippet = email.bodyText.slice(0, SNIPPET_LENGTH);
	const truncated = email.bodyText.length > SNIPPET_LENGTH;

	if (snippet.trim()) {
		// Headers are capped, but escaping can still expand them fivefold, so
		// fit the snippet against whatever budget genuinely remains. If nothing
		// is left the block is dropped rather than cut mid-markup.
		const chrome = `\n\n<blockquote>…</blockquote>\n\n${footer}`;
		const budget = TELEGRAM_MAX_MESSAGE - lines.join("\n").length - chrome.length;
		const fitted = fitEscaped(snippet, budget);
		if (fitted) {
			lines.push("", `<blockquote>${fitted}${truncated || fitted.length < snippet.length ? "…" : ""}</blockquote>`);
		}
	}

	lines.push("", footer);

	return lines.join("\n");
}

/** Action verbs carried in `callback_data`, kept short to stay under the 64-byte cap. */
export const TelegramAction = {
	READ: "read",
	STAR: "star",
	ARCHIVE: "arch",
	BODY: "body",
} as const;

export function buildEmailKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
	return {
		inline_keyboard: [
			[
				{ text: "✅ Mark read", callback_data: TelegramAction.READ },
				{ text: "⭐ Star", callback_data: TelegramAction.STAR },
			],
			[
				{ text: "📄 Full body", callback_data: TelegramAction.BODY },
				{ text: "📦 Archive", callback_data: TelegramAction.ARCHIVE },
			],
		],
	};
}

// ── Message → email mapping ────────────────────────────────────────

/**
 * What a notification message points at. Stored in R2 so a later button tap
 * or text reply can resolve the email without stuffing state into
 * `callback_data`, which Telegram caps at 64 bytes.
 */
export interface TelegramMessageRef {
	mailboxId: string;
	emailId: string;
	threadId: string;
	/** Original envelope recipients — used to pick the reply-from for a catchall mailbox. */
	recipient: string;
	subject: string;
	sender: string;
}

function messageRefKey(chatId: string | number, messageId: number): string {
	return `telegram/messages/${chatId}/${messageId}.json`;
}

export async function putMessageRef(
	bucket: R2Bucket,
	chatId: string | number,
	messageId: number,
	ref: TelegramMessageRef,
): Promise<void> {
	await bucket.put(messageRefKey(chatId, messageId), JSON.stringify(ref));
}

export async function getMessageRef(
	bucket: R2Bucket,
	chatId: string | number,
	messageId: number,
): Promise<TelegramMessageRef | null> {
	const obj = await bucket.get(messageRefKey(chatId, messageId));
	if (!obj) return null;
	try {
		return await obj.json<TelegramMessageRef>();
	} catch {
		return null;
	}
}
