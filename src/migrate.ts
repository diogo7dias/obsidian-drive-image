import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type DriveImagePlugin from "./main";
import { SessionExpiredError } from "./errorlog";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "heif", "bmp"]);

function mimeFromExt(ext: string): string {
	switch (ext.toLowerCase()) {
		case "png": return "image/png";
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "gif": return "image/gif";
		case "webp": return "image/webp";
		case "svg": return "image/svg+xml";
		case "heic": return "image/heic";
		case "heif": return "image/heif";
		case "bmp": return "image/bmp";
		default: return "application/octet-stream";
	}
}

interface MigrateStats {
	notesScanned: number;
	imagesFound: number;
	uploaded: number;
	referencesRewritten: number;
	localsDeleted: number;
	errors: { file: string; message: string }[];
}

/**
 * Walk every markdown note, find local image embeds, upload each unique image to Drive once,
 * rewrite all references to the public URL, and optionally delete the local file.
 *
 * Uses Obsidian's metadataCache so both ![[wikilink]] and ![](markdown) embeds are handled,
 * and link resolution matches what Obsidian itself does (name-only links resolve vault-wide).
 */
export async function migrateVaultImages(
	plugin: DriveImagePlugin,
	deleteLocals: boolean,
	onProgress: (msg: string) => void,
): Promise<MigrateStats> {
	const app = plugin.app;
	const stats: MigrateStats = {
		notesScanned: 0,
		imagesFound: 0,
		uploaded: 0,
		referencesRewritten: 0,
		localsDeleted: 0,
		errors: [],
	};

	const markdownFiles = app.vault.getMarkdownFiles();

	// Map of resolved image TFile.path -> Drive URL (so each image uploads only once).
	const uploadedUrls = new Map<string, string>();
	// Track which image files had every reference successfully rewritten (safe to delete).
	const fullyMigrated = new Map<string, boolean>();

	// Breadcrumbs for the crash dump: if the loop throws unexpectedly, these tell us
	// exactly which note/image was in hand when the metal cracked.
	let currentNote: string | null = null;
	let currentTarget: string | null = null;

	try {
	for (const note of markdownFiles) {
		stats.notesScanned++;
		currentNote = note.path;
		const cache = app.metadataCache.getFileCache(note);
		if (!cache?.embeds || cache.embeds.length === 0) continue;

		// Collect unique embed "original" strings in this note that point at local images.
		const replacements = new Map<string, string>(); // original embed text -> replacement markdown
		// original embed text -> resolved image path, so the rewrite-error path can mark
		// the right images as not-fully-migrated without re-parsing link text.
		const originalToPath = new Map<string, string>();

		for (const embed of cache.embeds) {
			const target = app.metadataCache.getFirstLinkpathDest(embed.link, note.path);
			if (!(target instanceof TFile)) continue;
			const ext = target.extension.toLowerCase();
			if (!IMAGE_EXTS.has(ext)) continue;

			currentTarget = target.path;
			stats.imagesFound++;

			let url = uploadedUrls.get(target.path);
			if (!url) {
				try {
					onProgress(`Uploading ${target.name}...`);
					const buf = await app.vault.readBinary(target);
					const filename = `${crypto.randomUUID()}.${ext}`;
					url = await plugin.uploadBuffer(buf, mimeFromExt(ext), filename);
					uploadedUrls.set(target.path, url);
					fullyMigrated.set(target.path, true);
					stats.uploaded++;
				} catch (e) {
					// Dead session will fail every remaining image identically — abort the whole
					// run so the user gets one clean "sign in again" instead of N error rows.
					if (e instanceof SessionExpiredError) throw e;
					const message = e instanceof Error ? e.message : String(e);
					stats.errors.push({ file: target.path, message });
					fullyMigrated.set(target.path, false);
					console.error(`[drive-image] migrate upload failed for ${target.path}:`, e);
					continue; // leave this embed untouched
				}
			}

			replacements.set(embed.original, `![](${url})`);
			originalToPath.set(embed.original, target.path);
		}

		if (replacements.size === 0) continue;

		// Rewrite the note content. Replace exact embed-original strings.
		try {
			let content = await app.vault.read(note);
			for (const [original, replacement] of replacements) {
				content = content.split(original).join(replacement);
				stats.referencesRewritten++;
			}
			await app.vault.modify(note, content);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			stats.errors.push({ file: note.path, message });
			console.error(`[drive-image] migrate rewrite failed for ${note.path}:`, e);
			// Mark involved images as not-fully-migrated so we never delete their locals.
			for (const path of originalToPath.values()) {
				fullyMigrated.set(path, false);
			}
		}
	}
	} catch (e) {
		// Session expiry is expected and handled by the command layer — do not dump it.
		// Any other crash: capture where we were, then rethrow so the command shows its notice.
		if (!(e instanceof SessionExpiredError)) {
			await plugin.logError("migrate (hard crash in scan loop)", e, {
				currentNote,
				currentTarget,
				stats,
			});
		}
		throw e;
	}

	// Optionally delete local files that uploaded AND had every reference rewritten cleanly.
	if (deleteLocals) {
		for (const [path, ok] of fullyMigrated) {
			if (!ok) continue;
			const f = app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) {
				try {
					await app.fileManager.trashFile(f);
					stats.localsDeleted++;
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					stats.errors.push({ file: path, message: `delete failed: ${message}` });
					console.error(`[drive-image] migrate delete failed for ${path}:`, e);
				}
			}
		}
	}

	// Soft failures: the run finished but some files could not be uploaded/rewritten/deleted.
	// Dump them too — "completed with errors" is still a failure from the user's seat.
	if (stats.errors.length > 0) {
		await plugin.logError(
			"migrate (completed with per-file errors)",
			new Error(`${stats.errors.length} file(s) failed during migrate`),
			{ stats },
		);
	}

	return stats;
}

/**
 * Confirmation modal. Explains the operation and offers delete-locals vs keep-locals.
 */
export class MigrateConfirmModal extends Modal {
	constructor(
		app: App,
		private onConfirm: (deleteLocals: boolean) => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Migrate local images to Drive" });

		contentEl.createEl("p", {
			text:
				"Scans every note for locally-stored image embeds, uploads each image to your " +
				"Drive folder, and rewrites the embeds to public Drive URLs. Each unique image " +
				"uploads only once even if used in several notes.",
		});
		contentEl.createEl("p", {
			text:
				"Run a backup or commit first if you want a rollback point. Notes will be modified " +
				"in place.",
		});

		new Setting(contentEl)
			.setName("Delete local files after migrating")
			.setDesc(
				"Move successfully-migrated local image files to system trash to shrink the vault. " +
				"Only files whose every reference was rewritten cleanly are deleted.",
			);

		const btnRow = contentEl.createDiv();
		btnRow.style.display = "flex";
		btnRow.style.gap = "0.5em";
		btnRow.style.justifyContent = "flex-end";
		btnRow.style.marginTop = "1em";

		const cancel = btnRow.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();

		const keep = btnRow.createEl("button", { text: "Migrate, keep locals" });
		keep.onclick = () => {
			this.close();
			this.onConfirm(false);
		};

		const del = btnRow.createEl("button", { text: "Migrate & delete locals" });
		del.classList.add("mod-cta");
		del.onclick = () => {
			this.close();
			this.onConfirm(true);
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

export function summarize(stats: MigrateStats): string {
	const lines = [
		`Migrated ${stats.uploaded} image(s) across ${stats.notesScanned} note(s).`,
		`${stats.referencesRewritten} reference(s) rewritten.`,
	];
	if (stats.localsDeleted > 0) lines.push(`${stats.localsDeleted} local file(s) trashed.`);
	if (stats.errors.length > 0) lines.push(`${stats.errors.length} error(s) — see console.`);
	return lines.join(" ");
}

export function notifyResult(stats: MigrateStats) {
	new Notice("Drive Image: " + summarize(stats), 10000);
	if (stats.errors.length > 0) {
		console.error("[drive-image] migration errors:", stats.errors);
	}
}
