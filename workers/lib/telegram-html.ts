/**
 * Email HTML to Telegram HTML.
 *
 * Telegram's `parse_mode: "HTML"` is not real HTML. It accepts a short tag
 * whitelist (`b i u s a code pre blockquote tg-spoiler`) and rejects the whole
 * message as malformed when anything else, an unbalanced tag, or a stray `<`
 * shows up. Feeding it raw email HTML therefore fails outright, and stripping
 * every tag to plain text throws away the one thing a notification exists to
 * carry: the link the sender wants you to open.
 *
 * So this module translates instead of stripping. It walks the email, drops
 * the parts that are never meant to be read (head, styles, scripts, Outlook
 * conditional fallbacks, hidden preheader text), decodes character entities,
 * re-escapes for Telegram, and maps the surviving structure onto the
 * whitelist. Links come through as real `<a href>` anchors.
 *
 * Two properties matter for correctness:
 *   - Escaping happens *after* entity decoding, so `&#x27;` becomes `'`
 *     rather than surviving as literal text in the message.
 *   - Output tags are always balanced, including when the source is not.
 *     Telegram has no error recovery.
 *
 * Security notes: `href` is restricted to http/https/mailto, so a
 * `javascript:` link in a hostile email cannot become a tappable button.
 * Anchor text is still attacker-controlled, since a phishing mail can label
 * its link anything, which is why notifications keep link previews disabled
 * and the address bar remains the reader's only ground truth.
 */

// -- Escaping -------------------------------------------------------

/**
 * Escape the three characters Telegram's HTML parse mode treats as markup.
 * Telegram only recognises a small tag whitelist, so this is the whole job.
 */
export function escapeTelegramHtml(text: string): string {
	if (!text) return "";
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// -- Entity decoding ------------------------------------------------

/**
 * The named entities that actually turn up in email. The full HTML5 table is
 * ~2200 names; this covers the punctuation, currency and Latin-1 range that
 * marketing templates emit, and anything unknown is left verbatim rather than
 * guessed at.
 */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
	hellip: "…", mdash: "—", ndash: "–", horbar: "―",
	lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
	sbquo: "‚", bdquo: "„", laquo: "«", raquo: "»",
	bull: "•", middot: "·", dagger: "†", permil: "‰",
	copy: "©", reg: "®", trade: "™", sect: "§", para: "¶",
	deg: "°", plusmn: "±", times: "×", divide: "÷", minus: "−",
	frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³",
	euro: "€", pound: "£", yen: "¥", cent: "¢", curren: "¤",
	iexcl: "¡", iquest: "¿", brvbar: "¦", micro: "µ", not: "¬",
	ordf: "ª", ordm: "º", szlig: "ß", uml: "¨", acute: "´",
	ensp: " ", emsp: " ", thinsp: " ",
	// Zero-width characters and soft hyphens are layout hints; they only add noise here.
	shy: "", zwnj: "", zwj: "", lrm: "", rlm: "",
};

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/**
 * Decode character references to the characters they stand for.
 *
 * Runs before escaping, never after: decoding escaped output would undo the
 * escape and hand Telegram live markup.
 */
export function decodeHtmlEntities(text: string): string {
	if (!text || !text.includes("&")) return text;
	return text.replace(ENTITY_RE, (match, body: string) => {
		if (body.charCodeAt(0) === 35 /* # */) {
			const hex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
			// Reject NUL, surrogates and out-of-range values: String.fromCodePoint
			// throws on those, and a lone surrogate would corrupt the output.
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
			if (code >= 0xd800 && code <= 0xdfff) return match;
			return String.fromCodePoint(code);
		}
		const named = NAMED_ENTITIES[body];
		return named === undefined ? match : named;
	});
}

// -- Tag tables -----------------------------------------------------

/** Source tags mapped onto Telegram's inline whitelist. */
const INLINE_MAP: Record<string, string> = {
	b: "b", strong: "b",
	i: "i", em: "i", cite: "i", dfn: "i", var: "i",
	u: "u", ins: "u",
	s: "s", strike: "s", del: "s",
	code: "code", kbd: "code", samp: "code", tt: "code",
	pre: "pre",
};

/** Tags whose entire subtree is discarded: never rendered, or never meant to be read. */
const DROP_SUBTREE = new Set([
	"head", "style", "script", "noscript", "title", "template",
	"iframe", "object", "embed", "applet", "svg", "canvas", "math",
	"select", "option", "textarea", "map", "video", "audio", "xml",
]);

const VOID_TAGS = new Set([
	"br", "img", "hr", "meta", "link", "input", "base", "col", "area",
	"source", "track", "wbr", "param",
]);

/** How many line breaks a block boundary asks for. */
const BLOCK_BREAKS: Record<string, number> = {
	p: 2, table: 2, ul: 2, ol: 2, dl: 2, hr: 2, pre: 2, blockquote: 2,
	section: 2, article: 2, header: 2, footer: 2, main: 2, aside: 2,
	figure: 2, address: 2, form: 2, fieldset: 2,
	h1: 2, h2: 2, h3: 2, h4: 2, h5: 2, h6: 2,
	div: 1, tr: 1, li: 1, dt: 1, dd: 1, center: 1, caption: 1, legend: 1,
};

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Non-breaking spaces of every width. They read as spaces, so they collapse
 * with the surrounding whitespace instead of surviving as odd gaps.
 */
const NBSP_RE = new RegExp("[\\u00a0\\u2007\\u202f]", "gu");

/** Layout cells: a space keeps words apart without turning tables into ladders. */
const SPACE_TAGS = new Set(["td", "th"]);

/**
 * Matches one tag, tolerating `>` inside quoted attribute values.
 * Comments, doctypes and processing instructions are removed before this runs.
 */
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

function getAttribute(attrs: string, name: string): string | null {
	const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
	const m = re.exec(attrs);
	if (!m) return null;
	return m[1] ?? m[2] ?? m[3] ?? "";
}

/**
 * Is this element invisible in a mail client?
 *
 * Preheader text, the hidden line templates stuff at the top of the body to
 * control the inbox preview, is the main target. It is real text in the
 * markup, so tag stripping happily emits it, which is where stray fragments
 * in a notification come from.
 */
function isHiddenElement(attrs: string): boolean {
	if (/(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)) return true;
	const style = getAttribute(attrs, "style");
	if (!style) return false;
	const s = style.toLowerCase().replace(/\s+/g, "");
	return (
		s.includes("display:none") ||
		s.includes("visibility:hidden") ||
		s.includes("mso-hide:all") ||
		/font-size:0(?![.\d])/.test(s) ||
		/max-height:0(?![.\d])/.test(s) ||
		/opacity:0(?![.\d])/.test(s)
	);
}

/**
 * Accept only schemes that are safe to hand a reader as a tappable link.
 * Everything else (javascript:, data:, or a relative path that cannot resolve
 * outside the original mail client) loses its anchor and keeps its text.
 */
function safeHref(raw: string): string | null {
	// Strip whitespace and control characters: both are used to smuggle a
	// disallowed scheme past a prefix check.
	const url = decodeHtmlEntities(raw).trim().replace(/[\s\p{Cc}]/gu, "");
	if (!url || url.length > 2000) return null;
	if (!/^(?:https?:\/\/|mailto:)/i.test(url)) return null;
	return escapeTelegramHtml(url).replace(/"/g, "&quot;");
}

// -- Conversion -----------------------------------------------------

export interface TelegramHtmlOptions {
	/**
	 * Emit `<blockquote>` for quoted sections. Off when the caller already
	 * wraps the result in a blockquote, because Telegram cannot nest them.
	 */
	allowBlockquote?: boolean;
}

/** Guard against pathological inputs; email bodies this long are machine-generated. */
const MAX_INPUT = 300_000;

/** Does this body contain markup, or is it plain text that merely contains a `<`? */
const HTML_HINT_RE =
	/<!--|<!doctype|<\/?(?:html|head|body|div|p|br|hr|table|thead|tbody|tr|td|th|caption|span|a|img|b|strong|i|em|u|s|strike|del|ins|ul|ol|li|dl|dt|dd|h[1-6]|font|center|blockquote|pre|code|style|script|meta|link|title|section|article|header|footer|main|aside|figure|form|label|small|sub|sup)(?:\s[^>]*)?\/?>/i;

interface Frame {
	/** Source tag name, used to find the matching close. */
	src: string;
	/** Telegram tag emitted for it, or null when the tag only affected layout. */
	out: string | null;
	/** This element is dropped, so everything inside it is dropped too. */
	hidden: boolean;
}

/**
 * Tags a browser closes implicitly when the key tag opens. Email HTML leaves
 * these open constantly, and without the rule a `<head>` that is never closed
 * would swallow the whole message.
 */
const IMPLIED_CLOSE: Record<string, string[]> = {
	body: ["head"],
	p: ["p"],
	li: ["li"],
	tr: ["tr", "td", "th"],
	td: ["td", "th"],
	th: ["td", "th"],
	dt: ["dt", "dd"],
	dd: ["dt", "dd"],
};

/** An implied close never reaches past one of these. */
const IMPLIED_BOUNDARY = new Set([
	"table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "dl",
	"div", "blockquote", "body", "form", "section", "article", "li",
]);

/**
 * Convert an email body to Telegram-safe HTML.
 *
 * Accepts plain-text bodies too: an email with no markup keeps its line
 * breaks instead of being flattened into one paragraph.
 */
export function emailHtmlToTelegramHtml(input: string, options: TelegramHtmlOptions = {}): string {
	if (!input) return "";
	const allowBlockquote = options.allowBlockquote !== false;
	const source = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;

	// A body with no real markup is plain text: escape it and keep its line
	// structure. Matching on known tag names rather than on any `<` keeps a
	// plain-text mail that happens to mention `<something>` out of the HTML
	// path, where its line breaks would be collapsed away.
	if (!HTML_HINT_RE.test(source)) {
		return escapeTelegramHtml(decodeHtmlEntities(source))
			.replace(/\r\n?/g, "\n")
			.replace(/[^\S\n]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	// Comments first. This removes `<!--[if mso]>...<![endif]-->` fallback
	// blocks whole, while leaving the content of downlevel-revealed
	// `<!--[if !mso]><!-->` blocks in place, since each of its markers is a
	// separate comment.
	const html = source
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<![^>]*>/g, "")
		.replace(/<\?[^>]*>/g, "");

	const parts: string[] = [];
	const stack: Frame[] = [];
	let pendingBreaks = 0;
	let pendingSpace = false;
	let hasContent = false;
	let anchorDepth = 0;
	let quoteDepth = 0;
	let preDepth = 0;
	let literalDepth = 0;
	let hiddenDepth = 0;

	const flushPending = () => {
		if (pendingBreaks > 0) {
			parts.push("\n".repeat(pendingBreaks));
			pendingBreaks = 0;
			pendingSpace = false;
		} else if (pendingSpace) {
			parts.push(" ");
			pendingSpace = false;
		}
	};

	const requestBreak = (n: number) => {
		if (!hasContent) return; // never open with blank lines
		pendingBreaks = Math.max(pendingBreaks, n);
	};

	const requestSpace = () => {
		if (hasContent && pendingBreaks === 0) pendingSpace = true;
	};

	const emitText = (escaped: string) => {
		flushPending();
		parts.push(escaped);
		hasContent = true;
	};

	const openOut = (tag: string) => {
		flushPending();
		parts.push(`<${tag}>`);
	};

	const handleText = (raw: string) => {
		if (!raw || hiddenDepth > 0) return;
		const decoded = decodeHtmlEntities(raw).replace(NBSP_RE, " ");
		if (preDepth > 0) {
			const kept = decoded.replace(/\r\n?/g, "\n");
			if (kept) emitText(escapeTelegramHtml(kept));
			return;
		}
		const collapsed = decoded.replace(/\s+/g, " ");
		if (collapsed === " ") {
			// Inter-element whitespace: remember it, but never let it start a line.
			requestSpace();
			return;
		}
		const text = !hasContent || pendingBreaks > 0 ? collapsed.replace(/^ /, "") : collapsed;
		if (text) emitText(escapeTelegramHtml(text));
	};

	const popFrame = (frame: Frame) => {
		if (frame.hidden) hiddenDepth--;
		if (!frame.out) return;
		parts.push(`</${frame.out}>`);
		if (frame.out === "a") anchorDepth--;
		if (frame.out === "blockquote") quoteDepth--;
		if (frame.out === "pre") preDepth--;
		if (frame.out === "pre" || frame.out === "code") literalDepth--;
	};

	/**
	 * Unwind the stack to the matching open tag. Elements left dangling above it
	 * were never closed by the sender; closing them here is what keeps the output
	 * balanced, and what stops a hidden element that is never closed from
	 * swallowing the rest of the email.
	 */
	const handleClose = (name: string) => {
		if (VOID_TAGS.has(name)) return;

		let index = -1;
		for (let i = stack.length - 1; i >= 0; i--) {
			if (stack[i].src === name) {
				index = i;
				break;
			}
		}
		if (index < 0) return; // a close with no open: ignore it
		for (let i = stack.length - 1; i >= index; i--) popFrame(stack[i]);
		stack.length = index;

		if (hiddenDepth > 0) return;
		if (SPACE_TAGS.has(name)) {
			requestSpace();
			return;
		}
		const breaks = BLOCK_BREAKS[name];
		if (breaks) requestBreak(breaks);
	};

	/** Apply the implicit end tags a browser would, before opening `name`. */
	const closeImplied = (name: string) => {
		const targets = IMPLIED_CLOSE[name];
		if (!targets) return;
		for (let i = stack.length - 1; i >= 0; i--) {
			const src = stack[i].src;
			if (targets.includes(src)) {
				handleClose(src);
				return;
			}
			if (IMPLIED_BOUNDARY.has(src)) return;
		}
	};

	const handleOpen = (name: string, attrs: string, selfClosing: boolean) => {
		const isVoid = selfClosing || VOID_TAGS.has(name);
		if (!isVoid) closeImplied(name);

		if (DROP_SUBTREE.has(name) || name.includes(":") || isHiddenElement(attrs)) {
			// Everything nested inside is dropped with it. Depth is tracked on the
			// stack rather than by tag name, so a close tag for any enclosing
			// element ends the drop.
			if (!isVoid) {
				stack.push({ src: name, out: null, hidden: true });
				hiddenDepth++;
			}
			return;
		}

		if (hiddenDepth > 0) {
			if (!isVoid) stack.push({ src: name, out: null, hidden: false });
			return;
		}

		if (name === "br") {
			// `<br><br>` is a paragraph break in practice, so these accumulate
			// rather than collapsing the way nested block tags do.
			if (hasContent) pendingBreaks = Math.min(pendingBreaks + 1, 2);
			return;
		}

		if (name === "img") {
			// Images cannot be inlined. Alt text is only worth keeping inside a
			// link, where it is often the entire label of an image button.
			if (anchorDepth > 0) {
				const alt = (getAttribute(attrs, "alt") || "").trim();
				if (alt) handleText(alt);
			}
			return;
		}

		if (SPACE_TAGS.has(name)) {
			requestSpace();
			stack.push({ src: name, out: null, hidden: false });
			return;
		}

		const breaks = BLOCK_BREAKS[name];
		if (breaks) requestBreak(breaks);
		if (name === "li") emitText("\u2022 ");
		if (isVoid) return;

		if (literalDepth > 0) {
			// Telegram's <pre> and <code> are literal blocks: markup inside them
			// is not parsed, so emit their contents as text only.
			stack.push({ src: name, out: null, hidden: false });
			return;
		}

		if (name === "a") {
			// Telegram cannot nest anchors, and neither can HTML.
			const href = anchorDepth > 0 ? null : safeHref(getAttribute(attrs, "href") || "");
			if (href) {
				flushPending();
				parts.push(`<a href="${href}">`);
				anchorDepth++;
				stack.push({ src: name, out: "a", hidden: false });
			} else {
				stack.push({ src: name, out: null, hidden: false });
			}
			return;
		}

		if (name === "blockquote") {
			if (allowBlockquote && quoteDepth === 0) {
				openOut("blockquote");
				quoteDepth++;
				stack.push({ src: name, out: "blockquote", hidden: false });
			} else {
				stack.push({ src: name, out: null, hidden: false });
			}
			return;
		}

		if (HEADINGS.has(name)) {
			openOut("b");
			stack.push({ src: name, out: "b", hidden: false });
			return;
		}

		const inline = INLINE_MAP[name];
		if (inline && !stack.some((f) => f.out === inline)) {
			// Telegram tolerates nesting but not a tag inside itself.
			openOut(inline);
			if (inline === "pre") preDepth++;
			if (inline === "pre" || inline === "code") literalDepth++;
			stack.push({ src: name, out: inline, hidden: false });
			return;
		}

		stack.push({ src: name, out: null, hidden: false });
	};

	let lastIndex = 0;
	TAG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TAG_RE.exec(html)) !== null) {
		const between = html.slice(lastIndex, match.index);
		lastIndex = TAG_RE.lastIndex;

		if (between) handleText(between);

		const name = match[2].toLowerCase();
		const attrs = match[3] || "";
		if (match[1] === "/") handleClose(name);
		else handleOpen(name, attrs, attrs.endsWith("/"));
	}
	handleText(html.slice(lastIndex));

	for (let i = stack.length - 1; i >= 0; i--) popFrame(stack[i]);

	let result = parts.join("");
	// Drop tags that ended up wrapping nothing: an anchor around a stripped
	// tracking pixel, a <b> around whitespace.
	let previous: string;
	do {
		previous = result;
		result = result
			.replace(/<(b|i|u|s|code|pre|blockquote)>(\s*)<\/\1>/g, "$2")
			.replace(/<a href="[^"]*">(\s*)<\/a>/g, "$1");
	} while (result !== previous);

	return result.replace(/\n{3,}/g, "\n\n").replace(/[^\S\n]+\n/g, "\n").trim();
}

// -- Length fitting -------------------------------------------------

const ELLIPSIS = "…";

/** Entities occupy several characters in the markup but read as one. */
function visibleLength(escaped: string): number {
	return escaped.replace(/&(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/g, " ").length;
}

/** Readable characters in a fragment, counting neither tags nor entity padding. */
function visibleTextLength(html: string): number {
	let total = 0;
	let lastIndex = 0;
	TAG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TAG_RE.exec(html)) !== null) {
		total += visibleLength(html.slice(lastIndex, match.index));
		lastIndex = TAG_RE.lastIndex;
	}
	return total + visibleLength(html.slice(lastIndex));
}

export interface FitOptions {
	/** Hard cap on the returned string, markup included. */
	maxLength: number;
	/** Cap on readable characters, ignoring markup. Defaults to unlimited. */
	maxVisible?: number;
}

/**
 * Trim Telegram HTML to a length without breaking it.
 *
 * Cutting assembled markup with `slice` can land inside a tag, inside an
 * entity, or between the halves of a surrogate pair, and can leave tags open,
 * all of which Telegram rejects outright. This walks the markup instead,
 * keeps room for the closing tags it still owes, and closes them on the way
 * out.
 */
export function fitTelegramHtml(
	html: string,
	options: FitOptions,
): { text: string; truncated: boolean } {
	const { maxLength, maxVisible = Number.POSITIVE_INFINITY } = options;
	if (!html) return { text: "", truncated: false };
	if (maxLength <= 0) return { text: "", truncated: true };

	// Decide up front whether anything has to go. Knowing the answer lets the
	// walk below reserve room for the ellipsis on every step, which is what
	// guarantees the result fits even when the cut lands on a tag boundary.
	if (html.length <= maxLength && visibleTextLength(html) <= maxVisible) {
		return { text: html, truncated: false };
	}
	const reserve = ELLIPSIS.length;

	const open: string[] = [];
	const parts: string[] = [];
	let length = 0;
	let visible = 0;
	let closingCost = 0;

	const closeAll = () => {
		for (let i = open.length - 1; i >= 0; i--) parts.push(`</${open[i]}>`);
		open.length = 0;
	};

	const cut = (chunk: string): void => {
		const room = maxLength - length - closingCost - ELLIPSIS.length;
		const visibleRoom = maxVisible - visible;
		let kept = chunk.slice(0, Math.max(0, Math.min(room, visibleRoom)));
		// Never end inside an entity or on half a surrogate pair.
		kept = kept.replace(/&[#a-zA-Z0-9]*$/, "");
		const lastCode = kept.charCodeAt(kept.length - 1);
		if (lastCode >= 0xd800 && lastCode <= 0xdbff) kept = kept.slice(0, -1);
		// Prefer a word boundary when one is close enough to the cut.
		const space = kept.lastIndexOf(" ");
		if (space > kept.length * 0.6) kept = kept.slice(0, space);
		const trimmed = kept.replace(/\s+$/, "");
		if (trimmed) parts.push(trimmed);
		parts.push(ELLIPSIS);
		closeAll();
	};

	const takeText = (chunk: string): boolean => {
		if (!chunk) return true;
		const chunkVisible = visibleLength(chunk);
		if (
			length + chunk.length + closingCost + reserve <= maxLength &&
			visible + chunkVisible <= maxVisible
		) {
			parts.push(chunk);
			length += chunk.length;
			visible += chunkVisible;
			return true;
		}
		cut(chunk);
		return false;
	};

	let lastIndex = 0;
	TAG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = TAG_RE.exec(html)) !== null) {
		if (!takeText(html.slice(lastIndex, match.index))) {
			return { text: parts.join(""), truncated: true };
		}
		lastIndex = TAG_RE.lastIndex;

		const tag = match[0];
		const name = match[2].toLowerCase();
		if (match[1] === "/") {
			parts.push(tag);
			length += tag.length;
			closingCost -= tag.length;
			open.pop();
			continue;
		}
		const closeTag = `</${name}>`;
		if (length + tag.length + closingCost + closeTag.length + reserve > maxLength) {
			parts.push(ELLIPSIS);
			closeAll();
			return { text: parts.join(""), truncated: true };
		}
		parts.push(tag);
		length += tag.length;
		closingCost += closeTag.length;
		open.push(name);
	}

	if (!takeText(html.slice(lastIndex))) return { text: parts.join(""), truncated: true };
	closeAll();
	return { text: parts.join(""), truncated: false };
}
