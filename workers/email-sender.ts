// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Resend API (https://resend.com).
 *
 * Replaces the Cloudflare Email Service `send_email` binding which requires
 * Workers Paid plan. Uses RESEND_API_KEY secret instead.
 */

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

export async function sendEmail(
	env: { RESEND_API_KEY: string },
	params: SendEmailParams,
): Promise<{ messageId: string }> {
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
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(message),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Resend API error: ${response.status} ${err}`);
	}

	const data = await response.json<{ id: string }>();
	return { messageId: data.id };
}
