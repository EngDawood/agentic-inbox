/**
 * Telegram bot integration.
 *
 * Outbound: `notifyNewEmail` pushes a card to the configured chat whenever
 * mail lands in an inbox, with inline buttons for the common triage actions.
 *
 * Inbound: `handleTelegramWebhook` receives button taps and text replies.
 * Replying to a notification in Telegram sends a real, correctly-threaded
 * email through the same Resend path the web UI uses.
 *
 * Security: this endpoint is mounted ahead of the Cloudflare Access
 * middleware, because Telegram cannot present an Access JWT. It is therefore
 * gated on two independent checks — a shared secret header that Telegram
 * echoes on every delivery, and an allowlist of chat IDs. Both must pass
 * before anything touches a mailbox.
 */

import type { Context } from "hono";
import { sendEmail } from "../email-sender";
import {
	getMailboxStub,
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
	buildQuotedReplyBlock,
	resolveOriginalEmail,
	getEffectiveFromEmail,
	stripHtmlToText,
	textToHtml,
} from "../lib/email-helpers";
import type { EmailFull } from "../lib/schemas";
import {
	getTelegramConfig,
	isChatAllowed,
	notifyChatId,
	timingSafeEqual,
	sendMessage,
	answerCallbackQuery,
	formatNewEmailMessage,
	buildEmailKeyboard,
	escapeTelegramHtml,
	truncateText,
	fitEscaped,
	TELEGRAM_MESSAGE_LIMIT,
	putMessageRef,
	getMessageRef,
	TelegramAction,
	type TelegramConfig,
	type TelegramMessageRef,
} from "../lib/telegram";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

type RateLimitStub = { checkSendRateLimit: () => Promise<string | null> };

// ── Outbound: notify on new mail ───────────────────────────────────

/**
 * Push a new-email notification to Telegram.
 *
 * Best-effort by design: this runs inside `waitUntil` off the inbound mail
 * path, so a Telegram outage must never fail or retry mail delivery. All
 * errors are logged and swallowed.
 */
export async function notifyNewEmail(
	env: Env,
	params: {
		mailboxId: string;
		emailId: string;
		sender: string;
		recipient: string;
		subject: string;
		threadId: string;
		body: string;
		attachmentCount: number;
	},
): Promise<void> {
	const config = getTelegramConfig(env);
	if (!config) return;

	const chatId = notifyChatId(config);
	if (!chatId) return;

	// Per-mailbox opt-out, alongside the existing autoDraft/agentModel settings.
	try {
		const obj = await env.BUCKET.get(`mailboxes/${params.mailboxId}.json`);
		if (obj) {
			const settings = await obj.json<Record<string, unknown>>();
			if (settings.telegramNotify === false) return;
		}
	} catch {
		// Settings unreadable — fall through and notify anyway.
	}

	try {
		const text = formatNewEmailMessage({
			sender: params.sender,
			recipient: params.recipient,
			subject: params.subject,
			bodyText: stripHtmlToText(params.body),
			attachmentCount: params.attachmentCount,
		});

		const sent = await sendMessage(config, {
			chatId,
			text,
			replyMarkup: buildEmailKeyboard(),
		});

		const ref: TelegramMessageRef = {
			mailboxId: params.mailboxId,
			emailId: params.emailId,
			threadId: params.threadId,
			recipient: params.recipient,
			subject: params.subject,
			sender: params.sender,
		};
		await putMessageRef(env.BUCKET, chatId, sent.message_id, ref);
	} catch (e) {
		console.error("Telegram notification failed:", (e as Error).message);
	}
}

// ── Inbound: webhook ───────────────────────────────────────────────

interface TelegramChat {
	id: number;
}

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	text?: string;
	reply_to_message?: { message_id: number };
}

interface TelegramUpdate {
	message?: TelegramMessage;
	callback_query?: {
		id: string;
		data?: string;
		message?: TelegramMessage;
	};
}

/**
 * Handle a Telegram webhook delivery.
 *
 * Returns 200 for anything it understands (Telegram retries non-2xx, and a
 * retry storm on a malformed update helps nobody) and 403 for anything that
 * fails authentication.
 */
export async function handleTelegramWebhook(
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	const config = getTelegramConfig(c.env);
	if (!config) return c.json({ error: "Telegram is not configured" }, 404);

	// Fail closed: without a configured secret there is no way to tell a real
	// Telegram delivery from anyone else who found the URL.
	if (!config.webhookSecret) {
		console.error("Telegram webhook rejected: TELEGRAM_WEBHOOK_SECRET is not set");
		return c.json({ error: "Webhook secret is not configured" }, 403);
	}

	const presented = c.req.header("x-telegram-bot-api-secret-token") ?? "";
	if (!timingSafeEqual(presented, config.webhookSecret)) {
		return c.json({ error: "Invalid webhook secret" }, 403);
	}

	let update: TelegramUpdate;
	try {
		update = await c.req.json<TelegramUpdate>();
	} catch {
		return c.json({ ok: true });
	}

	try {
		if (update.callback_query) {
			await handleCallbackQuery(c.env, config, update.callback_query);
		} else if (update.message) {
			await handleIncomingMessage(c.env, config, update.message);
		}
	} catch (e) {
		console.error("Telegram webhook handling failed:", (e as Error).message);
	}

	return c.json({ ok: true });
}

// ── Button taps ────────────────────────────────────────────────────

async function handleCallbackQuery(
	env: Env,
	config: TelegramConfig,
	query: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
	const message = query.message;
	if (!message) return;

	if (!isChatAllowed(config, message.chat.id)) {
		await answerCallbackQuery(config, query.id, "This chat is not authorised.");
		return;
	}

	const ref = await getMessageRef(env.BUCKET, message.chat.id, message.message_id);
	if (!ref) {
		await answerCallbackQuery(config, query.id, "This email is no longer tracked.");
		return;
	}

	const stub = getMailboxStub(env, ref.mailboxId);

	switch (query.data) {
		case TelegramAction.READ: {
			await stub.updateEmail(ref.emailId, { read: true });
			await answerCallbackQuery(config, query.id, "Marked as read");
			return;
		}
		case TelegramAction.STAR: {
			await stub.updateEmail(ref.emailId, { starred: true });
			await answerCallbackQuery(config, query.id, "Starred");
			return;
		}
		case TelegramAction.ARCHIVE: {
			const moved = await stub.moveEmail(ref.emailId, Folders.ARCHIVE);
			await answerCallbackQuery(config, query.id, moved ? "Archived" : "Archive folder not found");
			return;
		}
		case TelegramAction.BODY: {
			const email = (await stub.getEmail(ref.emailId)) as EmailFull | null;
			await answerCallbackQuery(config, query.id, email ? "Sending full body" : "Email not found");
			if (!email) return;

			const plain = stripHtmlToText(email.body || "") || "(empty body)";
			// Budget the plain text against the escaped heading, then escape.
			// Truncating the assembled HTML could split a tag or an entity.
			const heading = `<b>${escapeTelegramHtml(truncateText(email.subject || "(no subject)", 120))}</b>`;
			const bodyBudget = TELEGRAM_MESSAGE_LIMIT - heading.length - 2;
			await sendMessage(config, {
				chatId: message.chat.id,
				text: `${heading}\n\n${fitEscaped(plain, bodyBudget)}`,
				replyToMessageId: message.message_id,
			});
			return;
		}
		default:
			await answerCallbackQuery(config, query.id, "Unknown action");
	}
}

// ── Text messages ──────────────────────────────────────────────────

async function handleIncomingMessage(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
): Promise<void> {
	const chatId = message.chat.id;
	const text = message.text?.trim();
	if (!text) return;

	// `/id` is answered before the allowlist check so a new operator can
	// discover the chat ID they need to configure. It reveals nothing else.
	if (text === "/id" || text.startsWith("/id@")) {
		await sendMessage(config, {
			chatId,
			text: `Chat ID: <code>${escapeTelegramHtml(String(chatId))}</code>`,
		});
		return;
	}

	if (!isChatAllowed(config, chatId)) {
		await sendMessage(config, {
			chatId,
			text: "This chat is not authorised. Add its ID to TELEGRAM_CHAT_ID to enable it.",
		});
		return;
	}

	if (text === "/start" || text === "/help" || text.startsWith("/help@") || text.startsWith("/start@")) {
		await sendMessage(config, {
			chatId,
			text: [
				"<b>Agentic Inbox bot</b>",
				"",
				"New mail arrives here automatically.",
				"",
				"• Tap the buttons on a notification to mark read, star, archive, or show the full body.",
				"• <b>Reply</b> to a notification to answer it by email.",
				"",
				"<code>/id</code> — show this chat's ID",
			].join("\n"),
		});
		return;
	}

	// Anything else only means something as a reply to a notification.
	const replyTo = message.reply_to_message?.message_id;
	if (!replyTo) return;

	const ref = await getMessageRef(env.BUCKET, chatId, replyTo);
	if (!ref) {
		await sendMessage(config, {
			chatId,
			text: "That message is no longer tracked, so I can't tell which email to reply to.",
			replyToMessageId: message.message_id,
		});
		return;
	}

	const result = await sendEmailReply(env, ref, text);
	await sendMessage(config, {
		chatId,
		text: result.ok
			? `✅ Replied to ${escapeTelegramHtml(result.to)}`
			: `⚠️ ${escapeTelegramHtml(result.error)}`,
		replyToMessageId: message.message_id,
	});
}

// ── Sending the reply ──────────────────────────────────────────────

type ReplyResult = { ok: true; to: string } | { ok: false; error: string };

/**
 * Send a reply to the email a notification pointed at.
 *
 * Mirrors the threading and bookkeeping of `handleReplyEmail` in
 * routes/reply-forward.ts: resolve the original, build the References chain,
 * record the message in Sent, then hand off to Resend.
 */
async function sendEmailReply(
	env: Env,
	ref: TelegramMessageRef,
	replyText: string,
): Promise<ReplyResult> {
	const stub = getMailboxStub(env, ref.mailboxId);

	const rawOriginal = (await stub.getEmail(ref.emailId)) as EmailFull | null;
	if (!rawOriginal) return { ok: false, error: "Original email not found" };

	const original = await resolveOriginalEmail(stub, rawOriginal);
	const { originalMsgId, references, threadId } = buildReferencesChain(original);

	const to = original.sender;
	if (!to) return { ok: false, error: "Original email has no sender to reply to" };

	// Answer from the address the mail was actually sent to, not the catchall.
	const from = getEffectiveFromEmail(original.recipient || ref.recipient, ref.mailboxId);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, ref.mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return { ok: false, error: e.message };
		throw e;
	}

	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) return { ok: false, error: rateLimitError };

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const baseSubject = original.subject || "";
	const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;
	const html = `${textToHtml(replyText)}${buildQuotedReplyBlock({
		date: original.date,
		sender: original.sender,
		body: original.body ?? undefined,
	})}`;
	const now = new Date().toISOString();

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: null,
			bcc: null,
			date: now,
			body: html,
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id: threadId,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: fromEmail },
				{ key: "to", value: toStr },
				{ key: "subject", value: subject },
				{ key: "date", value: now },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
				...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
				...(references.length > 0
					? [{ key: "references", value: references.map((r) => `<${r}>`).join(" ") }]
					: []),
			]),
		},
		[],
	);

	await stub.markThreadRead(threadId);

	try {
		await sendEmail(env, {
			to: toStr,
			from: fromEmail,
			subject,
			html,
			text: replyText,
			headers: buildThreadingHeaders(originalMsgId, references),
		});
	} catch (e) {
		return { ok: false, error: `Delivery failed: ${(e as Error).message}` };
	}

	return { ok: true, to: toStr };
}
