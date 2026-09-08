// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound email with a provider fallback.
 *
 * Primary path is the Cloudflare Email Service `send_email` binding. Sending
 * to arbitrary recipients requires Workers Paid and a verified sending domain.
 * Email Service is in public beta, so a failed send falls back to the Resend
 * API (https://resend.com) when RESEND_API_KEY is configured.
 *
 * Callers see one function and never learn which provider delivered.
 */

import type { Env } from "./types";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

export interface SendEmailResult {
	messageId: string;
	/** Which provider actually delivered. Useful in logs when a fallback fired. */
	provider: "cloudflare" | "resend";
}

// ── Cloudflare Email Service ───────────────────────────────────────

/**
 * Map our attachment shape onto the binding's discriminated union, which
 * requires `contentId` on inline parts and forbids it on regular ones.
 */
function toCloudflareAttachments(
	attachments: NonNullable<SendEmailParams["attachments"]>,
): EmailAttachment[] {
	return attachments.map((att) =>
		att.disposition === "inline"
			? {
					disposition: "inline" as const,
					// Inline parts are referenced by cid: in the HTML; fall back to
					// the filename so a missing contentId cannot fail the whole send.
					contentId: att.contentId || att.filename,
					filename: att.filename,
					type: att.type,
					content: att.content,
				}
			: {
					disposition: "attachment" as const,
					filename: att.filename,
					type: att.type,
					content: att.content,
				},
	);
}

async function sendViaCloudflare(
	binding: SendEmail,
	params: SendEmailParams,
): Promise<SendEmailResult> {
	// The builder takes the same structured fields we already accept, so
	// `from`, `replyTo`, `cc`/`bcc` and `headers` pass through unchanged.
	const result = await binding.send({
		to: params.to,
		from: params.from,
		subject: params.subject,
		...(params.html ? { html: params.html } : {}),
		...(params.text ? { text: params.text } : {}),
		...(params.cc ? { cc: params.cc } : {}),
		...(params.bcc ? { bcc: params.bcc } : {}),
		...(params.replyTo ? { replyTo: params.replyTo } : {}),
		...(params.headers && Object.keys(params.headers).length > 0
			? { headers: params.headers }
			: {}),
		...(params.attachments && params.attachments.length > 0
			? { attachments: toCloudflareAttachments(params.attachments) }
			: {}),
	});

	return { messageId: result.messageId, provider: "cloudflare" };
}

// ── Resend ─────────────────────────────────────────────────────────

async function sendViaResend(
	apiKey: string,
	params: SendEmailParams,
): Promise<SendEmailResult> {
	// Resend requires `from` as a plain string; an {email, name} object is rejected.
	const fromStr =
		typeof params.from === "string"
			? params.from
			: `${params.from.name} <${params.from.email}>`;

	const message: Record<string, unknown> = {
		to: Array.isArray(params.to) ? params.to : [params.to],
		from: fromStr,
		subject: params.subject,
	};

	if (params.html) message.html = params.html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = Array.isArray(params.cc) ? params.cc : [params.cc];
	if (params.bcc) message.bcc = Array.isArray(params.bcc) ? params.bcc : [params.bcc];
	if (params.replyTo) message.reply_to = params.replyTo;

	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			content_type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(message),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Resend API error: ${response.status} ${err}`);
	}

	const data = await response.json<{ id: string }>();
	return { messageId: data.id, provider: "resend" };
}

// ── Dispatch ───────────────────────────────────────────────────────

/**
 * Send an email, preferring Cloudflare Email Service and falling back to Resend.
 *
 * The fallback only covers a *failed* send. A message Cloudflare accepts and
 * then bounces is not retried here — that would risk delivering twice.
 */
export async function sendEmail(
	env: Env,
	params: SendEmailParams,
): Promise<SendEmailResult> {
	const binding = env.EMAIL;
	const resendKey = env.RESEND_API_KEY;

	if (binding) {
		try {
			return await sendViaCloudflare(binding, params);
		} catch (e) {
			if (!resendKey) throw e;
			console.error(
				"Cloudflare Email Service send failed, falling back to Resend:",
				(e as Error).message,
			);
		}
	}

	if (!resendKey) {
		throw new Error(
			"No outbound email provider available: the EMAIL send_email binding is missing and RESEND_API_KEY is not set",
		);
	}

	return sendViaResend(resendKey, params);
}
