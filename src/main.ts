import { Editor, MarkdownView, Notice, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	DeviceCodeModal,
	DriveImageSettings,
	DriveImageSettingTab,
} from "./settings";
import {
	OAuthError,
	pollDeviceToken,
	refreshAccessToken,
	startDeviceCode,
	TokenBundle,
} from "./oauth";
import {
	DriveError,
	embedUrl,
	makeAnyoneReader,
	resolveFolderId,
	uploadImage,
} from "./drive";
import { migrateVaultImages, MigrateConfirmModal, notifyResult } from "./migrate";
import { findOrphans, notifyTrashResult, PruneConfirmModal, trashOrphans } from "./prune";

const LOCAL_FALLBACK_DIR = "attachments";

export default class DriveImagePlugin extends Plugin {
	settings: DriveImageSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new DriveImageSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on("editor-paste", this.handlePaste.bind(this)),
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", this.handleDrop.bind(this)),
		);

		this.addCommand({
			id: "migrate-local-images",
			name: "Migrate local images to Drive",
			callback: () => {
				if (!this.isSignedIn()) {
					new Notice("Drive Image: sign in first (Settings → Drive Image).");
					return;
				}
				new MigrateConfirmModal(this.app, async (deleteLocals) => {
					const progress = new Notice("Drive Image: starting migration...", 0);
					try {
						const stats = await migrateVaultImages(this, deleteLocals, (msg) =>
							progress.setMessage("Drive Image: " + msg),
						);
						progress.hide();
						notifyResult(stats);
					} catch (e) {
						progress.hide();
						const msg = e instanceof Error ? e.message : String(e);
						new Notice("Drive Image: migration failed. " + msg, 10000);
						console.error("[drive-image] migration crashed:", e);
					}
				}).open();
			},
		});

		this.addCommand({
			id: "prune-orphan-images",
			name: "Prune orphaned Drive images",
			callback: () => {
				if (!this.isSignedIn()) {
					new Notice("Drive Image: sign in first (Settings → Drive Image).");
					return;
				}
				this.runPrune();
			},
		});
	}

	private async runPrune() {
		const progress = new Notice("Drive Image: scanning for orphans...", 0);
		let scan;
		try {
			scan = await findOrphans(this, (msg) => progress.setMessage("Drive Image: " + msg));
		} catch (e) {
			progress.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice("Drive Image: orphan scan failed. " + msg, 10000);
			console.error("[drive-image] prune scan crashed:", e);
			return;
		}
		progress.hide();

		if (scan.orphans.length === 0) {
			new Notice(
				`Drive Image: no orphans. All ${scan.folderCount} Drive file(s) are still referenced.`,
				8000,
			);
			return;
		}

		new PruneConfirmModal(this.app, scan.orphans, async () => {
			const p = new Notice("Drive Image: trashing orphans...", 0);
			try {
				const stats = await trashOrphans(this, scan.orphans, (msg) =>
					p.setMessage("Drive Image: " + msg),
				);
				p.hide();
				notifyTrashResult(stats);
			} catch (e) {
				p.hide();
				const msg = e instanceof Error ? e.message : String(e);
				new Notice("Drive Image: trashing failed. " + msg, 10000);
				console.error("[drive-image] prune trash crashed:", e);
			}
		}).open();
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<DriveImageSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ---- Sign-in flow ----

	async startSignIn() {
		const { clientId, clientSecret } = this.settings;
		if (!clientId || !clientSecret) return;

		let device;
		try {
			device = await startDeviceCode(clientId);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice("Drive Image: device-code request failed. " + msg);
			return;
		}

		const modal = new DeviceCodeModal(this.app, device.user_code, device.verification_url, () => {
			// no-op; polling loop checks modal.isCancelled
		});
		modal.open();

		const deadline = Date.now() + device.expires_in * 1000;
		let interval = Math.max(device.interval, 5) * 1000;

		while (Date.now() < deadline) {
			if (modal.isCancelled()) {
				new Notice("Drive Image: sign-in cancelled.");
				return;
			}
			await sleep(interval);
			if (modal.isCancelled()) return;

			let result;
			try {
				result = await pollDeviceToken(clientId, clientSecret, device.device_code);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice("Drive Image: token poll failed. " + msg);
				modal.close();
				return;
			}

			if (result.status === "ok" && result.bundle) {
				this.settings.tokens = result.bundle;
				this.settings.folderId = null; // force re-resolve
				await this.saveSettings();
				modal.close();
				new Notice("Drive Image: signed in.");
				return;
			}
			if (result.status === "slow_down") interval += 5000;
			if (result.status === "denied" || result.status === "expired" || result.status === "error") {
				modal.close();
				new Notice("Drive Image: sign-in failed (" + result.status + ").");
				return;
			}
			// pending → loop
		}

		modal.close();
		new Notice("Drive Image: sign-in timed out.");
	}

	// ---- Paste/drop handling ----

	private async handlePaste(evt: ClipboardEvent, editor: Editor, view: MarkdownView) {
		const file = pickImageFromClipboard(evt.clipboardData);
		if (!file) return;
		evt.preventDefault();
		await this.processImage(file, editor, view);
	}

	private async handleDrop(evt: DragEvent, editor: Editor, view: MarkdownView) {
		const file = pickImageFromDataTransfer(evt.dataTransfer);
		if (!file) return;
		evt.preventDefault();
		await this.processImage(file, editor, view);
	}

	private async processImage(file: File, editor: Editor, view: MarkdownView) {
		const uuid = randomUuid();
		const ext = extFromMime(file.type) ?? "png";
		const filename = `${uuid}.${ext}`;

		const placeholder = `![](drive-image-uploading:${uuid})`;
		editor.replaceSelection(placeholder);

		const buf = await file.arrayBuffer();

		try {
			const url = await this.uploadBuffer(buf, file.type || "image/png", filename);
			replaceInEditor(editor, placeholder, `![](${url})`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[drive-image] upload failed:", e);
			await this.fallbackToLocal(buf, filename, view, editor, placeholder);
			new Notice("Drive Image: upload failed, saved locally. " + msg);
		}
	}

	/**
	 * Upload a buffer to Drive, make it public, return the embed URL.
	 * Shared by paste-flow and the bulk migrate command. Throws on any failure.
	 */
	async uploadBuffer(buf: ArrayBuffer, mimeType: string, filename: string): Promise<string> {
		if (!this.isSignedIn()) {
			throw new Error("not signed in — open Settings → Drive Image to sign in.");
		}
		const accessToken = await this.getAccessToken();
		const folderId = await this.ensureFolder(accessToken);
		const uploaded = await uploadImage(accessToken, buf, mimeType, filename, folderId);
		await makeAnyoneReader(accessToken, uploaded.id);
		return embedUrl(uploaded.id);
	}

	private async fallbackToLocal(
		buf: ArrayBuffer,
		filename: string,
		view: MarkdownView,
		editor: Editor,
		placeholder: string,
	) {
		const dir = LOCAL_FALLBACK_DIR;
		await this.ensureVaultFolder(dir);
		const path = `${dir}/${filename}`;
		try {
			await this.app.vault.createBinary(path, buf);
		} catch (e) {
			// File may already exist if user pastes same buffer twice (unlikely w/ uuid).
			console.error("[drive-image] local save failed:", e);
		}
		replaceInEditor(editor, placeholder, `![[${path}]]`);
	}

	private async ensureVaultFolder(path: string) {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) return;
		try {
			await this.app.vault.createFolder(path);
		} catch (e) {
			// Race: created between check and create. Swallow.
		}
	}

	// ---- Auth helpers ----

	private isSignedIn(): boolean {
		return !!this.settings.tokens?.refresh_token;
	}

	private async getAccessToken(): Promise<string> {
		const t = this.settings.tokens;
		if (!t || !t.refresh_token) throw new Error("not signed in");

		if (Date.now() < t.expires_at && t.access_token) {
			return t.access_token;
		}
		// Refresh
		try {
			const refreshed = await refreshAccessToken(
				this.settings.clientId,
				this.settings.clientSecret,
				t.refresh_token,
			);
			this.settings.tokens = refreshed;
			await this.saveSettings();
			return refreshed.access_token;
		} catch (e) {
			if (e instanceof OAuthError) throw e;
			throw e;
		}
	}

	private async ensureFolder(accessToken: string): Promise<string> {
		if (this.settings.folderId) return this.settings.folderId;
		const id = await resolveFolderId(accessToken, this.settings.folderName);
		this.settings.folderId = id;
		await this.saveSettings();
		return id;
	}

	/**
	 * Public Drive context for commands that talk to the API directly (e.g. orphan prune):
	 * a fresh access token plus the resolved folder ID. Throws if not signed in.
	 */
	async resolveDriveContext(): Promise<{ accessToken: string; folderId: string }> {
		const accessToken = await this.getAccessToken();
		const folderId = await this.ensureFolder(accessToken);
		return { accessToken, folderId };
	}
}

// ---- Helpers ----

function pickImageFromClipboard(data: DataTransfer | null): File | null {
	if (!data) return null;
	for (const item of Array.from(data.items)) {
		if (item.kind === "file" && item.type.startsWith("image/")) {
			const f = item.getAsFile();
			if (f) return f;
		}
	}
	return null;
}

function pickImageFromDataTransfer(data: DataTransfer | null): File | null {
	if (!data) return null;
	for (const f of Array.from(data.files)) {
		if (f.type.startsWith("image/")) return f;
	}
	return null;
}

function extFromMime(mime: string): string | null {
	const m = mime.toLowerCase();
	if (m === "image/png") return "png";
	if (m === "image/jpeg" || m === "image/jpg") return "jpg";
	if (m === "image/gif") return "gif";
	if (m === "image/webp") return "webp";
	if (m === "image/svg+xml") return "svg";
	if (m === "image/heic") return "heic";
	if (m === "image/heif") return "heif";
	if (m === "image/bmp") return "bmp";
	return null;
}

function randomUuid(): string {
	return crypto.randomUUID();
}

function replaceInEditor(editor: Editor, needle: string, replacement: string) {
	const content = editor.getValue();
	const idx = content.indexOf(needle);
	if (idx < 0) return;
	const from = editor.offsetToPos(idx);
	const to = editor.offsetToPos(idx + needle.length);
	editor.replaceRange(replacement, from, to);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
