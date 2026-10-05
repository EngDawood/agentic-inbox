/**
 * Writing email from Telegram: `/send` for a new email and the Forward
 * button on a notification.
 *
 * Both are short step-by-step chats. State lives in a per-chat draft
 * (see `TelegramDraft`), each text message fills in the current step, and
 * the email only goes out when the user taps Send on the preview.
 */

import { sendEmail } from "../email-sender";
import {
	getMailboxStub,
	listMailboxes,
	validateSender,
	SenderValidationError,
	generateMessageId,
	getEffectiveFromEmail,
	escapeHtml,
	stripHtmlToText,
	textToHtml,
	formatEmailDate,
} from "../lib/email-helpers";
import type { EmailFull } from "../lib/schemas";
import {
	sendMessage,
	editMessageText,
	answerCallbackQuery,
	escapeTelegramHtml,
	truncateText,
	getDraft,
	saveDraft,
	clearDraft,
	buildDraftCancelKeyboard,
	buildDraftPreviewKeyboard,
	TelegramAction,
	type InlineKeyboardButton,
	type TelegramConfig,
	type TelegramDraft,
	type TelegramMessageRef,
} from "../lib/telegram";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

type RateLimitStub = { checkSendRateLimit: () => Promise<string | null> };

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
/** Keeps the preview well under Telegram's 4096-character cap after escaping. */
const PREVIEW_BODY_LENGTH = 1500;

function parseRecipients(text: string): string[] | null {
	const list = text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
	if (list.length === 0 || !list.every((a) => EMAIL_RE.test(a))) return null;
	return list;
}

// ── Starting a draft ───────────────────────────────────────────────

export async function startSendDraft(env: Env, config: TelegramConfig, chatId: number): Promise<void> {
	const mailboxes = (await listMailboxes(env.BUCKET)).map((m) => m.email);
	if (mailboxes.length === 0) {
		await sendMessage(config, { chatId, text: "⚠️ No mailboxes exist yet. Create one in the dashboard first." });
		return;
	}

	// One mailbox means one obvious sender, so skip the question.
	if (mailboxes.length === 1) {
		await saveDraft(env.BUCKET, chatId, { kind: "send", step: "to", mailboxId: mailboxes[0], from: mailboxes[0] });
		await sendMessage(config, {
			chatId,
			text: `✉️ <b>New email</b> from ${escapeTelegramHtml(mailboxes[0])}\n\nWho is it to? Send the address (comma-separate several).`,
			replyMarkup: buildDraftCancelKeyboard(),
		});
		return;
	}

	await saveDraft(env.BUCKET, chatId, { kind: "send", step: "from", fromOptions: mailboxes });
	const buttons: InlineKeyboardButton[][] = mailboxes.map((email, i) => [
		{ text: email, callback_data: `${TelegramAction.DRAFT_FROM}${i}` },
	]);
	buttons.push(buildDraftCancelKeyboard().inline_keyboard[0]);
	await sendMessage(config, {
		chatId,
		text: "✉️ <b>New email</b>\n\nWhich address should it come from? Tap one, or type any address on your domain.",
		replyMarkup: { inline_keyboard: buttons },
	});
}

export async function startForwardDraft(
	env: Env,
	config: TelegramConfig,
	chatId: number,
	ref: TelegramMessageRef,
	notificationMessageId: number,
): Promise<void> {
	const subject = ref.subject || "";
	await saveDraft(env.BUCKET, chatId, {
		kind: "forward",
		step: "to",
		mailboxId: ref.mailboxId,
		// Forward from the address the mail was sent to, not the catchall.
		from: getEffectiveFromEmail(ref.recipient, ref.mailboxId),
		subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
		emailId: ref.emailId,
	});
	await sendMessage(config, {
		chatId,
		text: `↪️ <b>Forward</b> "${escapeTelegramHtml(truncateText(subject || "(no subject)", 120))}"\n\nWho should it go to? Send the address (comma-separate several).`,
		replyMarkup: buildDraftCancelKeyboard(),
		replyToMessageId: notificationMessageId,
	});
}

// ── Filling in steps ───────────────────────────────────────────────

/** Feed one text message into the chat's draft. */
export async function handleDraftInput(
	env: Env,
	config: TelegramConfig,
	chatId: number,
	draft: TelegramDraft,
	text: string,
): Promise<void> {
	switch (draft.step) {
		case "from": {
			const from = text.trim().toLowerCase();
			if (!EMAIL_RE.test(from)) {
				await sendMessage(config, { chatId, text: "That doesn't look like an email address. Try again, or tap one of the buttons." });
				return;
			}
			const mailboxId = await resolveMailboxFor(env, from);
			if (!mailboxId) {
				await sendMessage(config, { chatId, text: `⚠️ No mailbox exists for @${escapeTelegramHtml(from.split("@")[1])}. Pick one of the addresses above.` });
				return;
			}
			await setFromAndAskTo(env, config, chatId, draft, from, mailboxId);
			return;
		}
		case "to": {
			const to = parseRecipients(text);
			if (!to) {
				await sendMessage(config, { chatId, text: "That doesn't look like a valid address. Try again." });
				return;
			}
			if (draft.kind === "forward") {
				const next = { ...draft, to: to.join(", "), step: "preview" as const };
				await saveDraft(env.BUCKET, chatId, next);
				await sendPreview(env, config, chatId, next);
				return;
			}
			await saveDraft(env.BUCKET, chatId, { ...draft, to: to.join(", "), step: "subject" });
			await sendMessage(config, { chatId, text: "Subject?", replyMarkup: buildDraftCancelKeyboard() });
			return;
		}
		case "subject": {
			await saveDraft(env.BUCKET, chatId, { ...draft, subject: text, step: "body" });
			await sendMessage(config, { chatId, text: "Now the message.", replyMarkup: buildDraftCancelKeyboard() });
			return;
		}
		case "body": {
			const next = { ...draft, body: text, step: "preview" as const };
			await saveDraft(env.BUCKET, chatId, next);
			await sendPreview(env, config, chatId, next);
			return;
		}
		case "preview":
			await sendMessage(config, { chatId, text: "⬆️ Tap Send or Cancel on the preview above." });
			return;
	}
}

async function setFromAndAskTo(
	env: Env,
	config: TelegramConfig,
	chatId: number,
	draft: TelegramDraft,
	from: string,
	mailboxId: string,
): Promise<void> {
	await saveDraft(env.BUCKET, chatId, { ...draft, from, mailboxId, step: "to", fromOptions: undefined });
	await sendMessage(config, {
		chatId,
		text: `From ${escapeTelegramHtml(from)}.\n\nWho is it to? Send the address (comma-separate several).`,
		replyMarkup: buildDraftCancelKeyboard(),
	});
}

/**
 * Pick the mailbox that stores the sent copy: the address's own mailbox if
 * it has one, else the catchall, else any mailbox on the same domain.
 */
async function resolveMailboxFor(env: Env, from: string): Promise<string | null> {
	const domain = from.split("@")[1];
	const mailboxes = (await listMailboxes(env.BUCKET)).map((m) => m.email.toLowerCase());
	if (mailboxes.includes(from)) return from;
	const catchall = env.CATCHALL_MAILBOX?.toLowerCase();
	if (catchall && catchall.split("@")[1] === domain && mailboxes.includes(catchall)) return catchall;
	return mailboxes.find((m) => m.split("@")[1] === domain) ?? null;
}

async function sendPreview(env: Env, config: TelegramConfig, chatId: number, draft: TelegramDraft): Promise<void> {
	let bodyText = draft.body ?? "";
	if (draft.kind === "forward") {
		const original = await loadForwardOriginal(env, draft);
		bodyText = original ? stripHtmlToText(original.body || "") : "(original email not found)";
	}

	const title = draft.kind === "forward" ? "↪️ <b>Forward preview</b>" : "📤 <b>Preview</b>";
	const lines = [
		title,
		"",
		`<b>From:</b> ${escapeTelegramHtml(draft.from ?? "")}`,
		`<b>To:</b> ${escapeTelegramHtml(draft.to ?? "")}`,
		`<b>Subject:</b> ${escapeTelegramHtml(truncateText(draft.subject || "(no subject)", 200))}`,
		"",
		`<blockquote>${escapeTelegramHtml(truncateText(bodyText, PREVIEW_BODY_LENGTH)) || "(empty)"}</blockquote>`,
	];
	await sendMessage(config, { chatId, text: lines.join("\n"), replyMarkup: buildDraftPreviewKeyboard() });
}

// ── Draft buttons ──────────────────────────────────────────────────

/**
 * Handle Send, Cancel, and From taps. Returns false for any other action so
 * the caller can treat it as a notification button.
 */
export async function handleDraftCallback(
	env: Env,
	config: TelegramConfig,
	queryId: string,
	data: string,
	chatId: number,
	messageId: number,
): Promise<boolean> {
	if (data === TelegramAction.DRAFT_CANCEL) {
		await clearDraft(env.BUCKET, chatId);
		await answerCallbackQuery(config, queryId, "Cancelled");
		await editMessageText(config, { chatId, messageId, text: "❌ <i>Draft cancelled.</i>" }).catch(() => {});
		return true;
	}

	if (data.startsWith(TelegramAction.DRAFT_FROM)) {
		const draft = await getDraft(env.BUCKET, chatId);
		const from = draft?.step === "from" ? draft.fromOptions?.[Number(data.slice(TelegramAction.DRAFT_FROM.length))] : undefined;
		if (!draft || !from) {
			await answerCallbackQuery(config, queryId, "This draft has expired. Start again with /send.");
			return true;
		}
		await answerCallbackQuery(config, queryId, from);
		await setFromAndAskTo(env, config, chatId, draft, from, from);
		return true;
	}

	if (data === TelegramAction.DRAFT_SEND) {
		const draft = await getDraft(env.BUCKET, chatId);
		if (!draft || draft.step !== "preview") {
			await answerCallbackQuery(config, queryId, "This draft has expired.");
			await editMessageText(config, { chatId, messageId, text: "⌛ <i>This draft has expired.</i>" }).catch(() => {});
			return true;
		}
		// Clear before sending so a double tap can't send twice.
		await clearDraft(env.BUCKET, chatId);
		await answerCallbackQuery(config, queryId, "Sending…");

		const result = await deliverDraft(env, draft);
		if (!result.ok) {
			// Put the draft back so the user can retry, unless a copy is
			// already in Sent and a retry would store a second one.
			if (!result.stored) await saveDraft(env.BUCKET, chatId, draft);
			await sendMessage(config, { chatId, text: `⚠️ ${escapeTelegramHtml(result.error)}` });
			return true;
		}
		const verb = draft.kind === "forward" ? "Forwarded" : "Sent";
		await editMessageText(config, {
			chatId,
			messageId,
			text: `✅ <b>${verb}</b> to ${escapeTelegramHtml(result.to)}\n<b>Subject:</b> ${escapeTelegramHtml(truncateText(draft.subject || "(no subject)", 200))}`,
		});
		return true;
	}

	return false;
}

// ── Sending ────────────────────────────────────────────────────────

async function loadForwardOriginal(env: Env, draft: TelegramDraft): Promise<EmailFull | null> {
	if (!draft.mailboxId || !draft.emailId) return null;
	return (await getMailboxStub(env, draft.mailboxId).getEmail(draft.emailId)) as EmailFull | null;
}

/** Same layout as the web compose form's forward block. */
function buildForwardBlock(original: EmailFull): { html: string; text: string } {
	const plainBody = stripHtmlToText(original.body || "");
	const date = formatEmailDate(original.date || "");
	const html = `<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${escapeHtml(original.sender || "")}<br><strong>Date:</strong> ${escapeHtml(date)}<br><strong>Subject:</strong> ${escapeHtml(original.subject || "")}<br><br>${escapeHtml(plainBody).replace(/\n/g, "<br>")}</div>`;
	const text = [
		"---------- Forwarded message ----------",
		`From: ${original.sender || ""}`,
		`Date: ${date}`,
		`Subject: ${original.subject || ""}`,
		"",
		plainBody,
	].join("\n");
	return { html, text };
}

/** `stored` says whether a copy already landed in Sent, so a retry would duplicate it. */
type DeliverResult = { ok: true; to: string } | { ok: false; error: string; stored: boolean };

/**
 * Store the email in Sent and hand it to Resend. Mirrors the bookkeeping of
 * `handleForwardEmail` in routes/reply-forward.ts, minus attachments.
 */
async function deliverDraft(env: Env, draft: TelegramDraft): Promise<DeliverResult> {
	if (!draft.mailboxId || !draft.from || !draft.to) return { ok: false, error: "Draft is incomplete", stored: false };

	let html: string;
	let text: string;
	if (draft.kind === "forward") {
		const original = await loadForwardOriginal(env, draft);
		if (!original) return { ok: false, error: "Original email not found", stored: false };
		({ html, text } = buildForwardBlock(original));
	} else {
		html = textToHtml(draft.body ?? "");
		text = draft.body ?? "";
	}

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(draft.to.split(", "), draft.from, draft.mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return { ok: false, error: e.message, stored: false };
		throw e;
	}

	const stub = getMailboxStub(env, draft.mailboxId);
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) return { ok: false, error: rateLimitError, stored: false };

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const subject = draft.subject ?? "";
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
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: fromEmail },
				{ key: "to", value: toStr },
				{ key: "subject", value: subject },
				{ key: "date", value: now },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
			]),
		},
		[],
	);

	try {
		await sendEmail(env, { to: draft.to.split(", "), from: fromEmail, subject, html, text });
	} catch (e) {
		return { ok: false, error: `Delivery failed: ${(e as Error).message}`, stored: true };
	}
	return { ok: true, to: toStr };
}
