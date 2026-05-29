# Drive Image (Obsidian plugin)

Paste an image in any note — the plugin uploads it to your Google Drive and replaces the paste with a public embed URL. Local `attachments/` folder stays small (or empty) and works the same on Mac, iPhone, and iPad.

Personal-use plugin. No telemetry, no shared OAuth client, no server. Direct Google Drive REST API.

---

## How it works

1. You paste or drop an image into an editor.
2. Plugin intercepts the paste and inserts a placeholder while it works.
3. Image is uploaded to a Drive folder (configurable, default `nue-attachments`).
4. Permission is set to "anyone with the link can view".
5. Placeholder is replaced with `![](https://lh3.googleusercontent.com/d/FILE_ID)`.
6. If anything fails (offline, quota, expired token), the image is saved to the local `attachments/` folder and the link uses `![[attachments/UUID.ext]]`. No data loss.

## v0.1 scope (intentionally narrow)

- Pastes and drops → Drive upload, public URL
- Local fallback on any error
- Device-code OAuth (works on mobile)
- Token refresh

## v0.2 — bulk migration

Command palette → **Drive Image: Migrate local images to Drive**.

Scans every note for locally-stored image embeds (both `![[wikilink]]` and `![](markdown)` styles), uploads each unique image to your Drive folder once, and rewrites every reference to a public Drive URL. A confirmation dialog offers two modes:

- **Migrate, keep locals** — uploads and rewrites links, leaves local files in place.
- **Migrate & delete locals** — same, then moves successfully-migrated local files to system trash to shrink the vault. Only files whose every reference was rewritten cleanly are deleted.

Images that fail to upload are left untouched (note and local file unchanged). Errors are reported in a notice and logged to the developer console.

Tip: commit or back up your vault before running with delete enabled, so you have a rollback point.

Not yet implemented (planned for later):

- Orphan pruning (Drive files no longer referenced anywhere)
- Threshold rules (only upload images above N MB)
- Multi-folder routing

---

## Setup

You need your own Google Cloud project (10 minutes, one-time).

### 1. Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com/).
2. Create a new project. Name it whatever you like (e.g. `obsidian-drive-image`).

### 2. Enable the Drive API

1. APIs & Services → Library.
2. Search "Google Drive API". Enable it for your project.

### 3. Configure OAuth consent screen

1. APIs & Services → OAuth consent screen.
2. User type: **External**. Continue.
3. App name: anything. User support email: your own. Save and continue.
4. Scopes: skip (we request scopes at sign-in time).
5. Test users: add **your own Google account**. Save.
6. You can stay in "Testing" mode indefinitely — there is no need to publish.

### 4. Create an OAuth client

1. APIs & Services → Credentials → Create credentials → OAuth client ID.
2. Application type: **TVs and Limited Input devices**.
3. Name: anything. Create.
4. Copy the **Client ID** and **Client secret**.

### 5. Install the plugin via BRAT

1. In Obsidian, install the community plugin **BRAT** (Beta Reviewers Auto-update Tester).
2. BRAT → "Add Beta plugin" → paste this repo URL: `https://github.com/diogo7dias/obsidian-drive-image`.
3. BRAT installs the plugin from the latest GitHub release.
4. Enable **Drive Image** in Settings → Community plugins.
5. Repeat on iPhone and iPad (BRAT is available on mobile Obsidian).

### 6. Sign in

1. Settings → Drive Image.
2. Paste the Client ID and Client secret from step 4.
3. (Optional) Change the Drive folder name. Default is `nue-attachments`.
4. Click **Sign in to Google Drive**.
5. Open the URL shown in the dialog, paste the code, approve.
6. The plugin folder is created on first paste.

---

## Privacy

Images are uploaded with permission "anyone with the link can view". The link contains a 33-character random Google file ID and is effectively unguessable, but it is not private — anyone who has the URL can view the image. Don't paste images you would not be comfortable sharing if the note leaks.

The OAuth client ID and secret are stored locally in `<vault>/.obsidian/plugins/drive-image/data.json`. They never leave your devices.

## Compatibility

If you have another image-auto-upload plugin enabled, disable it. Both plugins will compete for paste events.

## Troubleshooting

- **"not signed in"** — open Settings → Drive Image and sign in.
- **"upload failed, saved locally"** — check internet connection. The image is at `attachments/UUID.ext`; re-paste it once you're back online or delete it.
- **Sign-in stuck on "pending"** — make sure you approved access for the correct Google account (the one you added as a Test User in step 3).
- **iOS shows "unverified app"** — expected. The OAuth app is your own personal project in Testing mode. Tap "Continue" / "Advanced" / "Go to ... (unsafe)".
