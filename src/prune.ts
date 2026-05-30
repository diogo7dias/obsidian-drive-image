import { App, Modal, Notice } from "obsidian";
import type DriveImagePlugin from "./main";
import { DriveFile, listFolderFiles, trashFile } from "./drive";

/**
 * Patterns that embed a Google Drive file ID in note text. We scan for ALL of them, not just
 * the lh3 embed URL the plugin emits, because a file referenced through any of these forms is
 * still in use. Erring broad is the safe direction: a false match keeps a file, a missed match
 * would trash a live image.
 *
 * Drive file IDs are made of [A-Za-z0-9_-]; the character class naturally stops at the `=w200`
 * size suffix lh3 URLs sometimes carry, at quotes, and at path separators.
 */
const ID_PATTERNS: RegExp[] = [
	/lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]+)/g,
	/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/g,
	/drive\.google\.com\/thumbnail\?[^)\s"']*\bid=([A-Za-z0-9_-]+)/g,
	/[?&]id=([A-Za-z0-9_-]+)/g,
];

/** Collect every Drive file ID referenced anywhere in a blob of text. */
export function extractDriveIds(text: string): Set<string> {
	const ids = new Set<string>();
	for (const re of ID_PATTERNS) {
		// Reset lastIndex: these are module-level /g regexes reused across calls.
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			if (m[1]) ids.add(m[1]);
		}
	}
	return ids;
}

export interface PruneScan {
	folderCount: number;
	usedIdCount: number;
	orphans: DriveFile[];
}

/**
 * Find files in the Drive folder that no note references any more.
 *
 * Reads the raw text of every markdown note (not the metadata cache) so external Drive URLs in
 * any form are seen, then diffs the folder listing against the set of referenced IDs.
 */
export async function findOrphans(
	plugin: DriveImagePlugin,
	onProgress: (msg: string) => void,
): Promise<PruneScan> {
	const { accessToken, folderId } = await plugin.resolveDriveContext();

	onProgress("listing Drive folder...");
	const files = await listFolderFiles(accessToken, folderId);

	onProgress("scanning notes...");
	const used = new Set<string>();
	const notes = plugin.app.vault.getMarkdownFiles();
	for (const note of notes) {
		const content = await plugin.app.vault.cachedRead(note);
		for (const id of extractDriveIds(content)) used.add(id);
	}

	const orphans = files.filter((f) => !used.has(f.id));
	return { folderCount: files.length, usedIdCount: used.size, orphans };
}

export interface TrashStats {
	trashed: number;
	errors: { name: string; message: string }[];
}

/** Move each orphan to Drive trash. Re-resolves the token so a long preview can't expire it. */
export async function trashOrphans(
	plugin: DriveImagePlugin,
	orphans: DriveFile[],
	onProgress: (msg: string) => void,
): Promise<TrashStats> {
	const { accessToken } = await plugin.resolveDriveContext();
	const stats: TrashStats = { trashed: 0, errors: [] };

	let done = 0;
	for (const f of orphans) {
		onProgress(`trashing ${++done}/${orphans.length}...`);
		try {
			await trashFile(accessToken, f.id);
			stats.trashed++;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			stats.errors.push({ name: f.name, message });
			console.error(`[drive-image] trash failed for ${f.name} (${f.id}):`, e);
		}
	}
	return stats;
}

export function formatBytes(bytes: number): string {
	if (bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const val = bytes / Math.pow(1024, i);
	return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

/**
 * Preview modal: lists every orphan (name + size) in a scrollable box with the count and total
 * size, so the user can spot a wrong match before anything is trashed.
 */
export class PruneConfirmModal extends Modal {
	constructor(
		app: App,
		private orphans: DriveFile[],
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		const total = this.orphans.reduce((sum, f) => sum + f.size, 0);

		contentEl.createEl("h2", { text: "Prune orphaned Drive images" });
		contentEl.createEl("p", {
			text:
				`${this.orphans.length} file(s) in your Drive folder (${formatBytes(total)}) are not ` +
				"referenced by any note. They will be moved to Drive trash (recoverable for ~30 days).",
		});

		const list = contentEl.createEl("div");
		list.style.maxHeight = "40vh";
		list.style.overflowY = "auto";
		list.style.border = "1px solid var(--background-modifier-border)";
		list.style.borderRadius = "6px";
		list.style.padding = "0.5em 0.75em";
		list.style.margin = "0.5em 0";
		list.style.fontFamily = "var(--font-monospace)";
		list.style.fontSize = "0.85em";

		for (const f of this.orphans) {
			const row = list.createEl("div");
			row.style.display = "flex";
			row.style.justifyContent = "space-between";
			row.style.gap = "1em";
			row.style.padding = "1px 0";
			row.createEl("span", { text: f.name });
			const size = row.createEl("span", { text: formatBytes(f.size) });
			size.style.opacity = "0.6";
			size.style.whiteSpace = "nowrap";
		}

		const btnRow = contentEl.createDiv();
		btnRow.style.display = "flex";
		btnRow.style.gap = "0.5em";
		btnRow.style.justifyContent = "flex-end";
		btnRow.style.marginTop = "1em";

		const cancel = btnRow.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();

		const trash = btnRow.createEl("button", { text: `Trash ${this.orphans.length} file(s)` });
		trash.classList.add("mod-warning");
		trash.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

export function notifyTrashResult(stats: TrashStats) {
	const lines = [`Trashed ${stats.trashed} orphaned image(s).`];
	if (stats.errors.length > 0) lines.push(`${stats.errors.length} error(s) — see console.`);
	new Notice("Drive Image: " + lines.join(" "), 10000);
	if (stats.errors.length > 0) {
		console.error("[drive-image] prune errors:", stats.errors);
	}
}
