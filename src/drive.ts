import { requestUrl } from "obsidian";

const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

export interface UploadResult {
	id: string;
	name: string;
}

export class DriveError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

/**
 * Resolve folder ID by name. Creates folder if missing.
 * Searches user's Drive root for a folder with exact name.
 */
export async function resolveFolderId(accessToken: string, folderName: string): Promise<string> {
	const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`;
	const searchRes = await requestUrl({
		url: `${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
		throw: false,
	});

	if (searchRes.status !== 200) {
		throw new DriveError(searchRes.status, `Folder search failed: ${searchRes.text}`);
	}

	const files = searchRes.json.files ?? [];
	if (files.length > 0) return files[0].id;

	// Create folder
	const createRes = await requestUrl({
		url: FILES_URL,
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			name: folderName,
			mimeType: "application/vnd.google-apps.folder",
		}),
		throw: false,
	});

	if (createRes.status < 200 || createRes.status >= 300) {
		throw new DriveError(createRes.status, `Folder create failed: ${createRes.text}`);
	}
	return createRes.json.id;
}

/**
 * Upload an image blob via multipart upload, return file metadata.
 * data: raw bytes; mimeType: e.g. "image/png"; name: filename in Drive; parentId: folder ID.
 */
export async function uploadImage(
	accessToken: string,
	data: ArrayBuffer,
	mimeType: string,
	name: string,
	parentId: string,
): Promise<UploadResult> {
	const boundary = "----obsidian-drive-image-" + Math.random().toString(36).slice(2);
	const metadata = JSON.stringify({ name, parents: [parentId] });

	// Build multipart body as ArrayBuffer (Obsidian requestUrl supports ArrayBuffer body)
	const enc = new TextEncoder();
	const headPart = enc.encode(
		`--${boundary}\r\n` +
		`Content-Type: application/json; charset=UTF-8\r\n\r\n` +
		`${metadata}\r\n` +
		`--${boundary}\r\n` +
		`Content-Type: ${mimeType}\r\n\r\n`,
	);
	const tailPart = enc.encode(`\r\n--${boundary}--\r\n`);

	const body = new Uint8Array(headPart.byteLength + data.byteLength + tailPart.byteLength);
	body.set(headPart, 0);
	body.set(new Uint8Array(data), headPart.byteLength);
	body.set(tailPart, headPart.byteLength + data.byteLength);

	const res = await requestUrl({
		url: UPLOAD_URL + "&fields=id,name",
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": `multipart/related; boundary=${boundary}`,
		},
		body: body.buffer,
		throw: false,
	});

	if (res.status < 200 || res.status >= 300) {
		throw new DriveError(res.status, `Upload failed: ${res.text}`);
	}
	return { id: res.json.id, name: res.json.name };
}

/**
 * Set permission to "anyone with link can read" on a file.
 */
export async function makeAnyoneReader(accessToken: string, fileId: string): Promise<void> {
	const res = await requestUrl({
		url: `${FILES_URL}/${fileId}/permissions`,
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ role: "reader", type: "anyone" }),
		throw: false,
	});
	if (res.status < 200 || res.status >= 300) {
		throw new DriveError(res.status, `Permission set failed: ${res.text}`);
	}
}

export function embedUrl(fileId: string): string {
	return `https://lh3.googleusercontent.com/d/${fileId}`;
}
