import { Platform, normalizePath } from "obsidian";
import type DriveImagePlugin from "./main";

/**
 * Where the human-readable crash dump lands. Vault root so it is trivial to find
 * and open on mobile, and shareable as plain markdown. Entries are appended, so a
 * sequence of failures builds a history rather than overwriting the last clue.
 */
export const ERROR_LOG_PATH = "DRIVE EXTENSION ERROR.md";

/** Friendly, expected message shown when the Drive session has expired/been revoked. */
export const SESSION_EXPIRED_MSG =
	"Drive session expired. Open Settings → Drive Image and sign in again.";

/**
 * Thrown when the OAuth refresh token is dead (invalid_grant). This is an EXPECTED,
 * user-actionable condition — not a crash — so callers show a clean prompt and skip the
 * error-log dump. Google expires refresh tokens for apps in "Testing" status after 7 days.
 */
export class SessionExpiredError extends Error {
	constructor(message: string = SESSION_EXPIRED_MSG) {
		super(message);
		this.name = "SessionExpiredError";
	}
}

function nowIso(): string {
	// new Date() with no args is fine inside the plugin runtime (this is not a workflow script).
	return new Date().toISOString();
}

function errToParts(err: unknown): { name: string; message: string; stack: string } {
	if (err instanceof Error) {
		return {
			name: err.name || "Error",
			message: err.message || String(err),
			stack: err.stack || "(no stack)",
		};
	}
	return { name: "NonError", message: String(err), stack: "(no stack)" };
}

function safeJson(data: unknown): string {
	try {
		return JSON.stringify(data, null, 2);
	} catch (e) {
		return `(could not serialize data: ${e instanceof Error ? e.message : String(e)})`;
	}
}

function platformLine(): string {
	const flags: string[] = [];
	if (Platform.isDesktop) flags.push("desktop");
	if (Platform.isMobile) flags.push("mobile");
	if (Platform.isIosApp) flags.push("ios");
	if (Platform.isAndroidApp) flags.push("android");
	const ua = typeof navigator !== "undefined" ? navigator.userAgent : "(no navigator)";
	return `${flags.join(", ") || "unknown"} — ${ua}`;
}

/**
 * Append one structured failure entry to the vault-root error log.
 *
 * NEVER throws: a logger that crashes while logging would hide the very bug we are
 * chasing. Any failure to write is swallowed (and mirrored to console as a last resort).
 *
 * @param operation short label for what was running, e.g. "migrate", "paste upload", "prune scan".
 * @param error    the thrown value.
 * @param data     optional context dump (stats so far, current file, ids) — anything that helps.
 */
export async function logError(
	plugin: DriveImagePlugin,
	operation: string,
	error: unknown,
	data?: Record<string, unknown>,
): Promise<void> {
	try {
		const { name, message, stack } = errToParts(error);
		const version = plugin.manifest?.version ?? "unknown";

		const entry = [
			`## ${nowIso()} — ${operation}`,
			``,
			`- **Plugin version:** ${version}`,
			`- **Platform:** ${platformLine()}`,
			`- **Error:** ${name}: ${message}`,
			``,
			`**Stack:**`,
			"```",
			stack,
			"```",
			``,
			`**Context data:**`,
			"```json",
			safeJson(data ?? {}),
			"```",
			``,
			`---`,
			``,
		].join("\n");

		const path = normalizePath(ERROR_LOG_PATH);
		const adapter = plugin.app.vault.adapter;

		let existing = "";
		if (await adapter.exists(path)) {
			existing = await adapter.read(path);
		} else {
			existing =
				`# Drive Image — Error Log\n\n` +
				`Auto-generated crash dumps. Share this file with whoever debugs the plugin, ` +
				`then delete it once fixed. Newest entries are appended at the bottom.\n\n`;
		}

		await adapter.write(path, existing + entry);
	} catch (writeErr) {
		// Last resort only. Do not let logging failures mask or replace the real error.
		console.error("[drive-image] failed to write error log:", writeErr, "original:", error);
	}
}
