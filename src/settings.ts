import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type DriveImagePlugin from "./main";
import { TokenBundle } from "./oauth";

export interface DriveImageSettings {
	clientId: string;
	clientSecret: string;
	folderName: string;
	folderId: string | null;
	tokens: TokenBundle | null;
}

export const DEFAULT_SETTINGS: DriveImageSettings = {
	clientId: "",
	clientSecret: "",
	folderName: "nue-attachments",
	folderId: null,
	tokens: null,
};

export class DriveImageSettingTab extends PluginSettingTab {
	plugin: DriveImagePlugin;

	constructor(app: App, plugin: DriveImagePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Drive Image" });

		const signedIn = !!this.plugin.settings.tokens?.refresh_token;
		const status = containerEl.createEl("p");
		status.setText(signedIn ? "Status: signed in" : "Status: not signed in");

		new Setting(containerEl)
			.setName("Google OAuth client ID")
			.setDesc("From your Google Cloud project. See README for setup.")
			.addText((text) =>
				text
					.setPlaceholder("xxxxxxxx.apps.googleusercontent.com")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (v) => {
						this.plugin.settings.clientId = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Google OAuth client secret")
			.setDesc("From your Google Cloud project.")
			.addText((text) => {
				text.inputEl.type = "password";
				return text
					.setPlaceholder("GOCSPX-...")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (v) => {
						this.plugin.settings.clientSecret = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Drive folder name")
			.setDesc("Folder in your Drive where images are uploaded. Created if missing.")
			.addText((text) =>
				text
					.setPlaceholder("nue-attachments")
					.setValue(this.plugin.settings.folderName)
					.onChange(async (v) => {
						this.plugin.settings.folderName = v.trim() || "nue-attachments";
						this.plugin.settings.folderId = null; // re-resolve on next upload
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(signedIn ? "Re-authenticate" : "Sign in to Google Drive")
			.setDesc("Opens device-code flow. Works on Mac, iPhone, iPad.")
			.addButton((btn) =>
				btn
					.setButtonText(signedIn ? "Re-authenticate" : "Sign in")
					.setCta()
					.onClick(async () => {
						if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
							new Notice("Set client ID and secret first.");
							return;
						}
						await this.plugin.startSignIn();
						this.display(); // refresh status
					}),
			);

		if (signedIn) {
			new Setting(containerEl)
				.setName("Sign out")
				.setDesc("Clears stored tokens. Drive files are untouched.")
				.addButton((btn) =>
					btn
						.setButtonText("Sign out")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.tokens = null;
							this.plugin.settings.folderId = null;
							await this.plugin.saveSettings();
							new Notice("Signed out.");
							this.display();
						}),
				);
		}
	}
}

/**
 * Modal that shows the device code + verification URL, and polls the token endpoint
 * until the user authorises or the code expires.
 */
export class DeviceCodeModal extends Modal {
	private cancelled = false;

	constructor(
		app: App,
		private userCode: string,
		private verificationUrl: string,
		private onCancel: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Sign in to Google Drive" });

		contentEl.createEl("p", { text: "1. Open this URL on any device:" });
		const link = contentEl.createEl("a", {
			text: this.verificationUrl,
			href: this.verificationUrl,
		});
		link.target = "_blank";

		contentEl.createEl("p", { text: "2. Enter this code:" });
		const codeEl = contentEl.createEl("pre");
		codeEl.style.fontSize = "1.6em";
		codeEl.style.padding = "0.5em";
		codeEl.style.textAlign = "center";
		codeEl.setText(this.userCode);

		contentEl.createEl("p", {
			text: "3. Approve the request. This dialog will close automatically.",
		});

		const btnRow = contentEl.createDiv();
		btnRow.style.textAlign = "right";
		btnRow.style.marginTop = "1em";
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => {
			this.cancelled = true;
			this.onCancel();
			this.close();
		};
	}

	isCancelled() {
		return this.cancelled;
	}

	onClose() {
		this.contentEl.empty();
	}
}
