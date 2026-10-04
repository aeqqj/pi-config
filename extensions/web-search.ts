import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 10;
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const USER_AGENT = "Pi-Web-Search/1.0 (keyless DuckDuckGo HTML search)";

export interface SearchResult {
	rank: number;
	title: string;
	url: string;
	snippet: string;
}

class SearchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SearchError";
	}
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	bull: "•",
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
	rsquo: "’",
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

function attribute(attributes: string, name: string): string | undefined {
	const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, "i").exec(
		attributes,
	);
	const value = match?.[1] ?? match?.[2] ?? match?.[3];
	return value === undefined ? undefined : decodeHtmlEntities(value);
}

function hasClass(attributes: string, className: string): boolean {
	return (attribute(attributes, "class") ?? "").split(/\s+/).includes(className);
}

export function cleanHtmlText(value: string): string {
	return decodeHtmlEntities(
		value
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<br\b[^>]*>/gi, " ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function findClassText(html: string, className: string): string {
	const elements = /<([a-z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
	let match: RegExpExecArray | null;
	while ((match = elements.exec(html))) {
		if (hasClass(match[2] ?? "", className)) return cleanHtmlText(match[3] ?? "");
	}
	return "";
}

/** Unwrap a DuckDuckGo tracking link and keep only ordinary credential-free HTTP(S) URLs. */
export function normalizeDuckDuckGoTarget(href: string): string | undefined {
	let target: URL;
	try {
		target = new URL(decodeHtmlEntities(href), DDG_HTML_URL);
		const host = target.hostname.toLowerCase().replace(/\.$/, "");
		if ((host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) && /^\/l\/?$/.test(target.pathname)) {
			const unwrapped = target.searchParams.get("uddg");
			if (!unwrapped) return undefined;
			target = new URL(unwrapped);
		}
	} catch {
		return undefined;
	}
	if (!/^https?:$/.test(target.protocol) || target.username || target.password || !target.hostname) return undefined;
	target.hash = "";
	return target.href;
}

export function parseDuckDuckGoResults(html: string, limit = DEFAULT_LIMIT): SearchResult[] {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new SearchError(`Result limit must be an integer from 1 to ${MAX_LIMIT}.`);
	}

	const links: Array<{ attributes: string; body: string; end: number; start: number }> = [];
	const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
	let match: RegExpExecArray | null;
	while ((match = anchors.exec(html))) {
		if (hasClass(match[1] ?? "", "result__a")) {
			links.push({ attributes: match[1] ?? "", body: match[2] ?? "", start: match.index, end: anchors.lastIndex });
		}
	}

	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < links.length && results.length < limit; index += 1) {
		const link = links[index]!;
		const href = attribute(link.attributes, "href");
		const url = href ? normalizeDuckDuckGoTarget(href) : undefined;
		const title = cleanHtmlText(link.body).slice(0, 300);
		if (!url || !title || seen.has(url)) continue;
		const nextStart = links[index + 1]?.start ?? html.length;
		const snippet = findClassText(html.slice(link.end, nextStart), "result__snippet").slice(0, 600);
		seen.add(url);
		results.push({ rank: results.length + 1, title, url, snippet });
	}
	return results;
}

async function readLimitedResponse(response: Response): Promise<string> {
	if (!response.body) throw new SearchError("DuckDuckGo returned an empty response.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		bytes += value.byteLength;
		if (bytes > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new SearchError("DuckDuckGo response exceeded the 1 MiB limit.");
		}
		chunks.push(value);
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

async function withTimeout<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
	if (signal.aborted) throw new SearchError("Web search cancelled.");
	const controller = new AbortController();
	const cancel = () => controller.abort(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), TIMEOUT_MS);
	try {
		return await work(controller.signal);
	} catch (error) {
		if (controller.signal.aborted) {
			const timedOut = controller.signal.reason instanceof Error && controller.signal.reason.name === "TimeoutError";
			throw new SearchError(timedOut ? "Web search timed out." : "Web search cancelled.");
		}
		if (error instanceof SearchError) throw error;
		throw new SearchError("Web search request failed.");
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

export async function searchDuckDuckGo(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
	const normalized = query.trim();
	if (!normalized) throw new SearchError("Search query must not be empty.");
	if (normalized.length > 500) throw new SearchError("Search query must not exceed 500 characters.");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new SearchError(`Result limit must be an integer from 1 to ${MAX_LIMIT}.`);
	}

	return await withTimeout(signal, async (requestSignal) => {
		const url = new URL(DDG_HTML_URL);
		url.searchParams.set("q", normalized);
		const response = await fetch(url, {
			signal: requestSignal,
			redirect: "error",
			headers: { accept: "text/html, application/xhtml+xml", "user-agent": USER_AGENT },
		});
		if (!response.ok) throw new SearchError(`DuckDuckGo returned HTTP ${response.status}.`);
		const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
			throw new SearchError("DuckDuckGo returned a non-HTML response.");
		}
		return parseDuckDuckGoResults(await readLimitedResponse(response), limit);
	});
}

const SEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: { type: "string", minLength: 1, maxLength: 500, description: "Search query" },
		limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Result count (default 5)" },
	},
	required: ["query"],
	additionalProperties: false,
} as const;

export default function registerWebSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web-search",
		label: "Web Search",
		description: "Search DuckDuckGo HTML without an API key. Returns ranked titles, URLs, and snippets.",
		parameters: SEARCH_PARAMETERS as any,
		exposure: "direct",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_toolCallId, params: { query: string; limit?: number }, signal) {
			const results = await searchDuckDuckGo(params.query, params.limit ?? DEFAULT_LIMIT, signal);
			const text = results.length
				? results.map((result) => `${result.rank}. ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`).join("\n\n")
				: "No search results found.";
			return { content: [{ type: "text" as const, text }], details: { query: params.query.trim(), results } };
		},
	});
}
