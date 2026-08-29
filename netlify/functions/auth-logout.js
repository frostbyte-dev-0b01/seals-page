const crypto = require("node:crypto");
const { buildGuestSetCookie } = require("./_lib/cookie");

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

// Sign out by pointing the device cookie at a brand-new anonymous guest id. The
// account principal is left intact in the DB; signing in again re-links it. No
// server-side session state exists to revoke (web reuses the signed cookie).
exports.handler = async (event) => {
	if (event.httpMethod !== "POST") {
		return json(405, { ok: false, error: "Method Not Allowed" }, { Allow: "POST" });
	}

	const secret = process.env.GUEST_COOKIE_SECRET;
	if (!secret) {
		return json(500, { ok: false, error: "Missing GUEST_COOKIE_SECRET" });
	}

	const setCookie = buildGuestSetCookie(crypto.randomUUID(), { secure: true, secret });
	return json(200, { ok: true }, { "Set-Cookie": setCookie });
};
