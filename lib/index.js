import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
/** Membership test over {@link AUDIO_EXTS}. */
const AUDIO_EXT_SET = /* @__PURE__ */ new Set([
	"mp3",
	"wav",
	"wave",
	"ogg",
	"oga",
	"opus",
	"flac",
	"m4a",
	"aac",
	"wma",
	"aif",
	"aiff",
	"amr",
	"ape",
	"caf",
	"mka"
]);
/**
* Whether one path carries an extension this plugin previews.
* @param path - absolute or relative path (case-insensitive; extension only).
* @returns true when the trailing extension is one of {@link AUDIO_EXTS}.
*/
function isAudioPath(path) {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 && AUDIO_EXT_SET.has(name.slice(dot + 1).toLowerCase());
}
/** Media types served by the host route, by extension. */
const AUDIO_TYPES = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	wave: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	flac: "audio/flac",
	m4a: "audio/mp4",
	aac: "audio/aac",
	wma: "audio/x-ms-wma",
	aif: "audio/aiff",
	aiff: "audio/aiff",
	amr: "audio/amr",
	ape: "audio/x-ape",
	caf: "audio/x-caf",
	mka: "audio/x-matroska"
};
/**
* Content type for one audio path.
* @param path - path whose trailing extension selects the type.
* @returns the audio media type, or `application/octet-stream` for an
*   extension outside {@link AUDIO_EXTS}.
*/
function contentTypeForAudio(path) {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return "application/octet-stream";
	return AUDIO_TYPES[path.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
//#endregion
//#region src/audio-route.ts
/**
* The plugin's HTTP surface: a read-only, Range-capable media route for audio
* files, plus a metadata probe. Two endpoints under one prefix:
*
*   GET  /audio-preview/meta?sessionId&path&cwd   → JSON file facts (size, mime)
*   GET  /audio-preview/media?sessionId&path&cwd  → bytes, honors `Range` (206)
*   HEAD /audio-preview/media?...                 → headers only (size probe)
*
* Why not better-sidebar's own `/sidebar/file` media route? It reads the whole
* file into memory, answers a plain `200` without `Accept-Ranges` (so a
* browser disables scrubbing and a long recording cannot be jumped around
* in), and is capped by that plugin's 20 MB `mediaLimit`. A waveform player
* needs none of those constraints: this route streams with
* `createReadStream`, honors `Range` (open-ended and suffix forms included)
* and answers `416` with a `Content-Range` header naming the full size when a
* range cannot be satisfied.
*
* Requests carry a sessionId that must resolve to an attached or persisted
* Host session. The committed cwd (or stored header before attach) resolves
* relative paths. Client cwd hints never grant access or create a session.
* Absolute paths retain the desktop file-preview contract; the Host connection
* authenticates every request. Only supported audio extensions are served.
*
* @module @huanlin/dsh-plugin-better-sidebar-plugin-audio/audio-route
*/
/** Prefix both endpoints live under. */
const ROUTE_PREFIX = "/audio-preview";
/** Metadata probe endpoint (JSON). */
const META_PATH = `${ROUTE_PREFIX}/meta`;
/** Media endpoint (bytes, Range-capable). */
const MEDIA_PATH = `${ROUTE_PREFIX}/media`;
/** Wire error with a stable code, mirroring better-sidebar's error envelope. */
var AudioRouteError = class extends Error {
	/** Stable machine code (`forbidden` / `bad-request` / `unsupported-media` / …). */
	code;
	/** HTTP status to answer with. */
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.name = "AudioRouteError";
		this.code = code;
		this.status = status;
	}
};
/**
* Parse a single `Range` header against a known size.
* @param raw - the raw header value, or undefined when absent.
* @param size - file size in bytes.
* @returns `null` when no range is present or the header is unparsable (per
*   RFC 9110 an unparsable Range header is ignored and the whole file served),
*   `'unsatisfiable'` when the range lies outside the file, or the inclusive
*   `{ start, end }` byte window. Multi-range requests are answered with the
*   first range only, which the spec explicitly permits.
*/
function parseRange(raw, size) {
	if (raw === void 0) return null;
	const match = /^bytes=(.+)$/i.exec(raw.trim());
	if (match === null) return null;
	const first = (match[1] ?? "").split(",")[0]?.trim() ?? "";
	if (first === "") return null;
	if (first.startsWith("-")) {
		const suffix = Number(first.slice(1));
		if (!Number.isInteger(suffix) || suffix <= 0) return null;
		if (size === 0) return "unsatisfiable";
		if (suffix >= size) return {
			start: 0,
			end: size - 1
		};
		return {
			start: size - suffix,
			end: size - 1
		};
	}
	const dash = first.indexOf("-");
	if (dash <= 0) return null;
	const startText = first.slice(0, dash);
	const endText = first.slice(dash + 1);
	const start = Number(startText);
	const end = endText === "" ? size - 1 : Number(endText);
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) return null;
	if (start >= size || end < start) return "unsatisfiable";
	return {
		start,
		end: Math.min(end, size - 1)
	};
}
/**
* Resolve one request path against a base directory.
* @param raw - the `path` query parameter (absolute, relative, or `~`-anchored).
* @param cwd - base directory for relative paths.
* @returns the absolute, lexically normalized path.
* @throws {AudioRouteError} when the parameter is empty.
*/
function resolveMediaPath(raw, cwd) {
	if (raw === "") throw new AudioRouteError("bad-request", "path is required");
	let value = raw;
	if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) value = join(homedir(), value.slice(1));
	return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}
/**
* Resolve the session's authoritative working directory.
* @param ctx - Host session, persistence and working-directory services.
* @param sessionId - An existing attached or persisted session.
* @returns The trusted cwd; unknown sessions are refused.
*/
async function sessionCwdOf(ctx, sessionId) {
	const session = ctx.sessions?.get(sessionId);
	let cwd = session === void 0 ? void 0 : ctx.get?.("workingDirectory")?.get(session) ?? session.header?.cwd;
	if (session === void 0) try {
		cwd = (await ctx.get?.("sessionPersistence")?.stat(sessionId))?.header.cwd;
	} catch {
		throw new AudioRouteError("session-not-found", "session is unavailable", 404);
	}
	if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new AudioRouteError("session-not-found", "session has no valid working directory", 404);
	return cwd;
}
/** Answer one wire error (or destroy the response when headers already went out). */
function writeError(response, status, code, message) {
	if (response.headersSent) {
		response.destroy();
		return;
	}
	const body = Buffer.from(JSON.stringify({
		ok: false,
		error: {
			code,
			message
		}
	}), "utf8");
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store"
	});
	response.end(body);
}
/** Answer one JSON value. */
function writeJson(response, status, value) {
	const body = Buffer.from(JSON.stringify({
		ok: true,
		value
	}), "utf8");
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store"
	});
	response.end(body);
}
/** Read one query parameter as a non-empty string. */
function requireParam(url, name) {
	const value = url.searchParams.get(name);
	if (value === null || value === "") throw new AudioRouteError("bad-request", `${name} is required`);
	return value;
}
/**
* Resolve, validate and stat the file one request names.
* @param url - the parsed request URL.
* @param ctx - the host context slice.
* @returns the absolute path and its file facts.
* @throws {AudioRouteError} for a missing parameter, a non-audio path, a
*   missing file, or a non-regular file.
*/
async function statRequestedFile(url, ctx) {
	const sessionId = requireParam(url, "sessionId");
	const path = resolveMediaPath(requireParam(url, "path"), await sessionCwdOf(ctx, sessionId));
	if (!isAudioPath(path)) {
		const name = basename(path);
		const dot = name.lastIndexOf(".");
		const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
		throw new AudioRouteError("unsupported-media", ext === "" ? "this route serves audio files only" : `this route serves audio files only (got .${ext})`, 403);
	}
	let info;
	try {
		info = await stat(path);
	} catch {
		throw new AudioRouteError("fs-error", `cannot read "${path}"`, 404);
	}
	if (!info.isFile()) throw new AudioRouteError("fs-error", `"${path}" is not a regular file`, 400);
	return {
		path,
		name: basename(path),
		size: info.size,
		mime: contentTypeForAudio(path)
	};
}
/** Answer the metadata probe. */
async function handleMeta(url, ctx, response) {
	writeJson(response, 200, await statRequestedFile(url, ctx));
}
/** Answer a media request, streaming either the whole file or the requested range. */
async function handleMedia(url, ctx, request, response) {
	const facts = await statRequestedFile(url, ctx);
	if (request.aborted || response.destroyed) return;
	const range = parseRange(request.headers.range, facts.size);
	const headers = {
		"content-type": facts.mime,
		"accept-ranges": "bytes",
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff"
	};
	if (range === "unsatisfiable") {
		response.writeHead(416, {
			...headers,
			"content-range": `bytes */${facts.size}`
		});
		response.end();
		return;
	}
	const start = range === null ? 0 : range.start;
	const end = range === null ? facts.size - 1 : range.end;
	const length = range === null ? facts.size : end - start + 1;
	if (range !== null) headers["content-range"] = `bytes ${start}-${end}/${facts.size}`;
	headers["content-length"] = String(length);
	response.writeHead(range === null ? 200 : 206, headers);
	if (request.method === "HEAD" || facts.size === 0) {
		response.end();
		return;
	}
	const stream = createReadStream(facts.path, {
		start,
		end
	});
	response.once("close", () => stream.destroy());
	stream.on("error", (error) => {
		if (!response.headersSent) writeError(response, 500, "fs-error", error.message);
		else response.destroy();
	});
	stream.pipe(response);
}
/**
* Dispatch one request against the prefix route.
* @param request - node request.
* @param response - node response.
* @param ctx - the host context slice.
*/
async function handleAudioRequest(request, response, ctx) {
	if (ctx.connection === void 0 || ctx.connection.requestRejection(request) !== void 0) {
		writeError(response, 403, "forbidden", "refused by the Host connection policy");
		return;
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { allow: "GET, HEAD" });
		response.end();
		return;
	}
	const url = new URL(request.url ?? "/", "http://dsh.internal");
	const pathname = url.pathname.replace(/\/+$/, "");
	try {
		if (pathname === META_PATH) {
			await handleMeta(url, ctx, response);
			return;
		}
		if (pathname === MEDIA_PATH) {
			await handleMedia(url, ctx, request, response);
			return;
		}
		writeError(response, 404, "not-found", `unknown route ${url.pathname}`);
	} catch (error) {
		if (error instanceof AudioRouteError) writeError(response, error.status, error.code, error.message);
		else writeError(response, 500, "internal", error instanceof Error ? error.message : String(error));
	}
}
/**
* Register the media routes on the host webserver.
* @param ctx - the host context slice.
* @returns the disposer that unregisters the route.
*/
function registerAudioRoutes(ctx) {
	const webServer = ctx.webServer;
	if (webServer === void 0) return () => {};
	return webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: (request, response) => {
			handleAudioRequest(request, response, ctx);
		}
	});
}
//#endregion
//#region src/index.ts
/** Plugin identity for cordis.yml rows / loader diagnostics. */
const name = "dsh-plugin-better-sidebar-plugin-audio";
/**
* Services required before mounting: the webserver (the media route), the
* session store (the authoritative cwd of the requesting session) and the web
* connection (the Host authentication and browser policy).
*/
const inject = [
	"webServer",
	"sessions",
	"connection"
];
/**
* Mount the media route.
* @param ctx - the host plugin context (services ready per {@link inject}).
*/
function apply(ctx) {
	const service = ctx;
	ctx.effect(() => registerAudioRoutes(service), "dsh-audio-preview: media routes");
}
//#endregion
export { apply, inject, name };
