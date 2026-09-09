// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;

	// Resend fallback for outbound mail, used when a Cloudflare Email Service
	// send fails. Optional: drop it to run on the EMAIL binding alone. Set via
	// `wrangler secret put`, so `wrangler types` cannot infer it and it must be
	// declared here for sendEmail() to typecheck.
	RESEND_API_KEY?: string;

	// Telegram bot integration. All optional — when the token or chat ID is
	// missing the integration disables itself and mail flow is unaffected.
	/** Bot token from @BotFather. Secret. */
	TELEGRAM_BOT_TOKEN?: string;
	/** Comma-separated chat IDs. The first receives notifications; all may act. */
	TELEGRAM_CHAT_ID?: string;
	/** Shared secret echoed by Telegram on every webhook delivery. Secret. */
	TELEGRAM_WEBHOOK_SECRET?: string;
}
