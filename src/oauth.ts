import { requestUrl } from "obsidian";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_url: string;
	expires_in: number;
	interval: number;
}

export interface TokenBundle {
	access_token: string;
	refresh_token?: string;
	expires_at: number;
}

export class OAuthError extends Error {
	constructor(public code: string, message: string) {
		super(message);
	}
}

export async function startDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
	const res = await requestUrl({
		url: DEVICE_CODE_URL,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: clientId, scope: SCOPE }).toString(),
		throw: false,
	});
	if (res.status !== 200) {
		throw new OAuthError("device_code_failed", `Device-code request failed: ${res.status} ${res.text}`);
	}
	return res.json as DeviceCodeResponse;
}

export interface PollResult {
	status: "pending" | "ok" | "slow_down" | "denied" | "expired" | "error";
	bundle?: TokenBundle;
	error?: string;
}

export async function pollDeviceToken(
	clientId: string,
	clientSecret: string,
	deviceCode: string,
): Promise<PollResult> {
	const res = await requestUrl({
		url: TOKEN_URL,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		}).toString(),
		throw: false,
	});

	if (res.status === 200) {
		const j = res.json;
		return {
			status: "ok",
			bundle: {
				access_token: j.access_token,
				refresh_token: j.refresh_token,
				expires_at: Date.now() + (j.expires_in - 60) * 1000,
			},
		};
	}

	const err = res.json?.error ?? "unknown";
	if (err === "authorization_pending") return { status: "pending" };
	if (err === "slow_down") return { status: "slow_down" };
	if (err === "access_denied") return { status: "denied" };
	if (err === "expired_token") return { status: "expired" };
	return { status: "error", error: err };
}

export async function refreshAccessToken(
	clientId: string,
	clientSecret: string,
	refreshToken: string,
): Promise<TokenBundle> {
	const res = await requestUrl({
		url: TOKEN_URL,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}).toString(),
		throw: false,
	});
	if (res.status !== 200) {
		throw new OAuthError("refresh_failed", `Token refresh failed: ${res.status} ${res.text}`);
	}
	const j = res.json;
	return {
		access_token: j.access_token,
		refresh_token: refreshToken,
		expires_at: Date.now() + (j.expires_in - 60) * 1000,
	};
}
