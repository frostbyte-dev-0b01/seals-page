const crypto = require("node:crypto");
const { buildGuestSetCookie, readGuestCookie } = require("./_lib/cookie");
const { accountTag, linkGoogleAccount } = require("./_lib/db");

const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo?id_token=";
const VALID_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

function json(statusCode, body, headers = {}) {
	return {
		statusCode,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			...headers,
		},
		body: JSON.stringify(body),
	};
}

function parseBody(event) {
	if (!event.body) return null;
	try {
		const raw = event.isBase64Encoded
			? Buffer.from(event.body, "base64").toString("utf8")
			: event.body;
		return JSON.parse(raw);
	} catch (_err) {
		return null;
	}
}

// Pure mapping from a verified Google tokeninfo payload to our identity fields.
// Exported for unit testing. Only a Google-verified email is trusted/stored.
function normalizeGoogleIdentity(payload) {
	if (!payload || typeof payload.sub !== "string" || payload.sub === "") {
		return null;
	}
	// tokeninfo returns email_verified as the string "true"/"false"; the JWKS
	// path returns a boolean. Accept both.
	const verified = payload.email_verified === true || payload.email_verified === "true";
	const email = verified && typeof payload.email === "string" ? payload.email.toLowerCase() : null;
	return { authUserId: `google:${payload.sub}`, email };
}

// Validates a Google ID token via Google's tokeninfo endpoint (signature +
// expiry are checked server-side by Google). We additionally enforce audience
// and issuer. Returns the payload, or null if the token is not acceptable.
async function verifyGoogleIdToken(idToken, clientId) {
	let res;
	try {
		res = await fetch(TOKENINFO_URL + encodeURIComponent(idToken));
	} catch (_err) {
		return null;
	}
	if (!res.ok) return null;
	let data;
	try {
		data = await res.json();
	} catch (_err) {
		return null;
	}
	if (data.aud !== clientId) return null;
	if (!VALID_ISSUERS.includes(data.iss)) return null;
	if (data.exp && Number(data.exp) * 1000 <= Date.now()) return null;
	return data;
}

exports.handler = async (event) => {
	if (event.httpMethod !== "POST") {
		return json(405, { ok: false, error: "Method Not Allowed" }, { Allow: "POST" });
	}

	const secret = process.env.GUEST_COOKIE_SECRET;
	if (!secret) {
		return json(500, { ok: false, error: "Missing GUEST_COOKIE_SECRET" });
	}
	const clientId = process.env.GOOGLE_CLIENT_ID;
	if (!clientId) {
		return json(500, { ok: false, error: "Missing GOOGLE_CLIENT_ID" });
	}

	const body = parseBody(event);
	const idToken = body && typeof body.credential === "string" ? body.credential : "";
	if (!idToken) {
		return json(400, { ok: false, error: "Missing credential" });
	}

	const payload = await verifyGoogleIdToken(idToken, clientId);
	if (!payload) {
		return json(401, { ok: false, error: "Invalid Google credential" });
	}
	const identity = normalizeGoogleIdentity(payload);
	if (!identity) {
		return json(401, { ok: false, error: "Invalid Google identity" });
	}

	// Reuse the device's existing guest principal if present; otherwise mint one
	// so a first-ever visitor can still create an account directly.
	const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
	let guestId = readGuestCookie(cookieHeader, secret);
	if (!guestId) {
		guestId = crypto.randomUUID();
	}

	let result;
	try {
		result = await linkGoogleAccount({
			guestId,
			authUserId: identity.authUserId,
			email: identity.email,
		});
	} catch (err) {
		console.error("Failed linking Google account", err);
		return json(500, { ok: false, error: "Failed to link account" });
	}

	const setCookie = buildGuestSetCookie(result.guestCookieId, { secure: true, secret });
	return json(
		200,
		{
			ok: true,
			email: identity.email,
			account_id: accountTag(identity.authUserId),
			merged: result.merged,
		},
		{ "Set-Cookie": setCookie },
	);
};

exports.normalizeGoogleIdentity = normalizeGoogleIdentity;
