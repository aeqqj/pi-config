import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_CHARS = 30_000;
export const MAX_CHARS = 100_000;
const MAX_URL_CHARS = 8_192;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "Pi-Web-Fetch/1.0 (read-only public web text fetcher)";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TEXT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);

class WebFetchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebFetchError";
	}
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	bull: "•",
	copy: "©",
	gt: ">",
	hellip: "…",
	laquo: "«",
	ldquo: "“",
	lsquo: "‘",
	lt: "<",
	mdash: "—",
	middot: "·",
	nbsp: " ",
	ndash: "–",
	quot: '"',
	raquo: "»",
	rdquo: "”",
	reg: "®",
	rsquo: "’",
	trade: "™",
};

export function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z][a-z\d]{1,31});/gi, (whole, entity: string) => {
		if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
		const hex = entity[1]?.toLowerCase() === "x";
		const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
		return Number.isFinite(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
			? String.fromCodePoint(point)
			: "�";
	});
}

function ipv4Parts(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
	const numbers = parts.map(Number);
	return numbers.every((part) => part >= 0 && part <= 255) ? numbers : undefined;
}

function expandIpv6(address: string): number[] | undefined {
	if (address.includes("%")) return undefined;
	let input = address.toLowerCase();
	if (input.includes(".")) {
		const lastColon = input.lastIndexOf(":");
		const ipv4 = ipv4Parts(input.slice(lastColon + 1));
		if (!ipv4) return undefined;
		input = `${input.slice(0, lastColon)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
	}
	const halves = input.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
	const fields = [...left, ...Array(missing).fill("0"), ...right];
	if (fields.length !== 8 || fields.some((field) => !/^[\da-f]{1,4}$/.test(field))) return undefined;
	return fields.map((field) => Number.parseInt(field, 16));
}

/** A deliberately conservative check for obvious private, local, documentation, multicast, and reserved IP space. */
export function isBlockedIp(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		const parts = ipv4Parts(address);
		if (!parts) return true;
		const [a, b, c] = parts as [number, number, number, number];
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0 && c === 0) ||
			(a === 192 && b === 0 && c === 2) ||
			(a === 192 && b === 88 && c === 99) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 198 && b === 51 && c === 100) ||
			(a === 203 && b === 0 && c === 113) ||
			a >= 224
		);
	}
	if (family === 6) {
		const fields = expandIpv6(address);
		if (!fields) return true;
		const [first, second] = fields;
		const allZero = fields.every((field) => field === 0);
		const loopback = fields.slice(0, 7).every((field) => field === 0) && fields[7] === 1;
		if (allZero || loopback || (first! & 0xfe00) === 0xfc00 || (first! & 0xffc0) === 0xfe80 || (first! & 0xff00) === 0xff00) {
			return true;
		}
		if (first === 0x2001 && (second === 0 || second === 0x0db8)) return true;
		const mapped = fields.slice(0, 5).every((field) => field === 0) && fields[5] === 0xffff;
		if (mapped) {
			const ipv4 = `${fields[6]! >> 8}.${fields[6]! & 255}.${fields[7]! >> 8}.${fields[7]! & 255}`;
			return isBlockedIp(ipv4);
		}
		// Deprecated IPv4-compatible addresses (::/96) are special-use even
		// when their embedded IPv4 value would otherwise be public.
		if (fields.slice(0, 6).every((field) => field === 0)) return true;
	}
	return family === 0;
}

export function parsePublicUrl(input: string): URL {
	if (typeof input !== "string" || input.length < 1 || input.length > MAX_URL_CHARS) {
		throw new WebFetchError(`URL must be between 1 and ${MAX_URL_CHARS} characters.`);
	}
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new WebFetchError("URL must be an absolute HTTP(S) URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebFetchError("Only HTTP(S) URLs are allowed.");
	if (url.username || url.password) throw new WebFetchError("URLs containing credentials are not allowed.");
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
	if (!hostname) throw new WebFetchError("URL must contain a hostname.");
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".lan") ||
		hostname.endsWith(".home")
	) {
		throw new WebFetchError("Local hostnames are not allowed.");
	}
	if (isIP(hostname) && isBlockedIp(hostname)) throw new WebFetchError("Private or special IP addresses are not allowed.");
	url.hash = "";
	return url;
}

function cancellationError(signal: AbortSignal): WebFetchError {
	const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
	return new WebFetchError(timedOut ? "Web fetch timed out." : "Web fetch cancelled.");
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw cancellationError(signal);
	return await new Promise<T>((resolve, reject) => {
		const cancel = () => reject(cancellationError(signal));
		signal.addEventListener("abort", cancel, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", cancel);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", cancel);
				reject(error);
			},
		);
	});
}

/** DNS is checked immediately before each request. This intentionally does not pin the later socket lookup. */
export async function validatePublicTarget(url: URL, signal: AbortSignal): Promise<void> {
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
	if (isIP(hostname)) return;
	let answers: Awaited<ReturnType<typeof lookup>>;
	try {
		answers = await raceWithSignal(lookup(hostname, { all: true, verbatim: true }), signal);
	} catch (error) {
		if (error instanceof WebFetchError) throw error;
		throw new WebFetchError("Unable to resolve the requested hostname.");
	}
	if (!Array.isArray(answers) || answers.length === 0) throw new WebFetchError("The requested hostname did not resolve.");
	if (answers.some(({ address }) => isBlockedIp(address))) {
		throw new WebFetchError("The requested hostname resolves to a private or special IP address.");
	}
}

function removeBlocks(html: string, pattern: RegExp): string {
	let previous: string;
	let output = html;
	do {
		previous = output;
		output = output.replace(pattern, "\n");
	} while (output !== previous);
	return output;
}

function normalizeText(value: string): string {
	const lines = value
		.replace(/\r\n?/g, "\n")
		.replace(/\u00a0/g, " ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.split("\n")
		.map((line) => line.replace(/[\t\f\v ]+/g, " ").trim());
	const output: string[] = [];
	for (const line of lines) {
		if (line || output.at(-1) !== "") output.push(line);
	}
	while (output[0] === "") output.shift();
	while (output.at(-1) === "") output.pop();
	return output.join("\n");
}

export function extractReadableHtml(html: string): { title: string; text: string } {
	const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html) ?? /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
	const title = normalizeText(decodeHtmlEntities((titleMatch?.[1] ?? "").replace(/<[^>]+>/g, " "))).slice(0, 500);
	let body = html.replace(/<!--[\s\S]*?-->/g, " ");
	body = removeBlocks(body, /<(script|style|noscript|template|svg|canvas|iframe|object|embed|head|nav|aside|footer|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi);
	body = removeBlocks(
		body,
		/<([a-z][\w:-]*)\b(?=[^>]*(?:class|id)\s*=\s*["'][^"']*(?<![\w-])(?:cookie-banner|cookie-consent|advertisement|breadcrumbs?|sidebar|social-share)(?![\w-])[^"']*["'])[^>]*>[\s\S]*?<\/\1\s*>/gi,
	);
	body = body
		.replace(/<br\b[^>]*\/?\s*>/gi, "\n")
		.replace(/<\/(?:address|article|blockquote|div|h[1-6]|li|main|p|pre|section|table|tr)\s*>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n• ")
		.replace(/<[^>]+>/g, " ");
	const text = normalizeText(decodeHtmlEntities(body));
	if (!text) throw new WebFetchError("The page did not contain readable text.");
	return { title, text };
}

function parseContentType(value: string | null): { charset: string; mediaType: string } {
	if (!value) throw new WebFetchError("Response did not include a Content-Type header.");
	const parts = value.split(";");
	const mediaType = parts.shift()?.trim().toLowerCase() ?? "";
	if (!TEXT_TYPES.has(mediaType)) throw new WebFetchError("Only HTML and plain-text responses are supported.");
	let charset = "utf-8";
	for (const part of parts) {
		const match = /^\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/i.exec(part);
		charset = (match?.[1] ?? match?.[2] ?? match?.[3] ?? charset).toLowerCase();
	}
	if (!/^[a-z\d._-]{1,40}$/i.test(charset)) throw new WebFetchError("Response declared an invalid text charset.");
	return { charset, mediaType };
}

async function readLimitedBody(response: Response): Promise<{ body: Uint8Array; truncated: boolean }> {
	if (!response.body) throw new WebFetchError("Response did not contain a body.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		const remaining = MAX_BODY_BYTES - bytes;
		if (value.byteLength > remaining) {
			if (remaining > 0) chunks.push(value.subarray(0, remaining));
			bytes = MAX_BODY_BYTES;
			truncated = true;
			await reader.cancel().catch(() => undefined);
			break;
		}
		chunks.push(value);
		bytes += value.byteLength;
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body, truncated };
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	const characters = Array.from(text);
	return characters.length > maxChars
		? { text: characters.slice(0, maxChars).join("").trimEnd(), truncated: true }
		: { text, truncated: false };
}

export interface FetchedPage {
	title: string;
	finalUrl: string;
	status: number;
	contentType: string;
	text: string;
	redirects: number;
	truncated: boolean;
}

export async function fetchReadablePage(input: string, maxChars: number, signal: AbortSignal): Promise<FetchedPage> {
	if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_CHARS) {
		throw new WebFetchError(`maxChars must be an integer from 1 to ${MAX_CHARS}.`);
	}
	let current = parsePublicUrl(input);
	const seen = new Set<string>();
	let redirects = 0;
	while (true) {
		if (seen.has(current.href)) throw new WebFetchError("Redirect loop detected.");
		seen.add(current.href);
		await validatePublicTarget(current, signal);
		let response: Response;
		try {
			response = await fetch(current, {
				signal,
				redirect: "manual",
				headers: { accept: "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8", "user-agent": USER_AGENT },
			});
		} catch {
			if (signal.aborted) throw cancellationError(signal);
			throw new WebFetchError("Web request failed.");
		}
		if (REDIRECTS.has(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			const location = response.headers.get("location");
			if (!location) throw new WebFetchError(`HTTP ${response.status} redirect omitted its Location header.`);
			if (redirects >= MAX_REDIRECTS) throw new WebFetchError(`Too many redirects (maximum ${MAX_REDIRECTS}).`);
			try {
				current = parsePublicUrl(new URL(location, current).href);
			} catch (error) {
				if (error instanceof WebFetchError) throw error;
				throw new WebFetchError("Server returned an invalid redirect URL.");
			}
			redirects += 1;
			continue;
		}

		const { charset, mediaType } = parseContentType(response.headers.get("content-type"));
		const received = await readLimitedBody(response);
		let decoded: string;
		try {
			decoded = new TextDecoder(charset).decode(received.body);
		} catch {
			throw new WebFetchError(`Unsupported text charset: ${charset}.`);
		}
		const readable =
			mediaType === "text/plain"
				? { title: "", text: normalizeText(decoded) }
				: extractReadableHtml(decoded);
		if (!readable.text) throw new WebFetchError("Response did not contain readable text.");
		const limited = truncateText(readable.text, maxChars);
		return {
			title: readable.title,
			finalUrl: current.href,
			status: response.status,
			contentType: mediaType,
			text: limited.text,
			redirects,
			truncated: received.truncated || limited.truncated,
		};
	}
}

async function withTimeout<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
	if (signal.aborted) throw cancellationError(signal);
	const controller = new AbortController();
	const cancel = () => controller.abort(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), TIMEOUT_MS);
	try {
		return await work(controller.signal);
	} catch (error) {
		if (controller.signal.aborted) throw cancellationError(controller.signal);
		if (error instanceof WebFetchError) throw error;
		throw new WebFetchError("Web fetch failed.");
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

const FETCH_PARAMETERS = {
	type: "object",
	properties: {
		url: { type: "string", minLength: 1, maxLength: MAX_URL_CHARS, description: "Absolute public HTTP(S) URL" },
		maxChars: {
			type: "integer",
			minimum: 1,
			maximum: MAX_CHARS,
			description: `Maximum text characters to return (default ${DEFAULT_MAX_CHARS})`,
		},
	},
	required: ["url"],
	additionalProperties: false,
} as const;

export default function registerWebFetch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description:
			"Fetch readable HTML or plain text from a public HTTP(S) URL. Revalidates DNS before redirects and applies body/output limits.",
		parameters: FETCH_PARAMETERS as any,
		exposure: "direct",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_toolCallId, params: { url: string; maxChars?: number }, signal) {
			const page = await withTimeout(signal, (requestSignal) =>
				fetchReadablePage(params.url, params.maxChars ?? DEFAULT_MAX_CHARS, requestSignal),
			);
			const text = [
				`Title: ${page.title || "(untitled)"}`,
				`Final URL: ${page.finalUrl}`,
				`Status: ${page.status}`,
				`Content type: ${page.contentType}`,
				`Truncated: ${page.truncated ? "yes" : "no"}`,
				"",
				page.text,
			].join("\n");
			return { content: [{ type: "text" as const, text }], details: page };
		},
	});
}
