const crypto = require("node:crypto");

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const COOKIE_NAME = "runes_guest";

function parseCookies(cookieHeader) {
	if (!cookieHeader) return {};
	return cookieHeader.split(";").reduce((acc, part) => {
		const [rawKey, ...rawVal] = part.trim().split("=");
		if (!rawKey || rawVal.length === 0) return acc;
		acc[rawKey] = decodeURIComponent(rawVal.join("="));
		return acc;
	}, {});
}

function base64UrlEncode(value) {
	return Buffer.from(value)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64UrlDecode(value) {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const padLength = (4 - (padded.length % 4)) % 4;
	return Buffer.from(padded + "=".repeat(padLength), "base64").toString("utf8");
}

function signValue(value, secret) {
	return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function createGuestCookieValue(guestId, secret) {
	const exp = Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS;
	const payload = base64UrlEncode(JSON.stringify({ gid: guestId, exp }));
	const sig = signValue(payload, secret);
	return `${payload}.${sig}`;
}

function readGuestCookie(cookieHeader, secret) {
	const parsed = parseCookies(cookieHeader);
	const raw = parsed[COOKIE_NAME];
	if (!raw || !secret || !raw.includes(".")) return null;

	const [payload, sig] = raw.split(".", 2);
	const expected = signValue(payload, secret);

	// timingSafeEqual throws if the buffers differ in length, so a tampered or
	// legacy cookie with a wrong-length signature must be rejected up front —
	// otherwise the throw escapes to the (un-try/caught) callers as a 500.
	const sigBuf = Buffer.from(sig);
	const expectedBuf = Buffer.from(expected);
	if (sigBuf.length !== expectedBuf.length) return null;
	if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

	let decoded;
	try {
		decoded = JSON.parse(base64UrlDecode(payload));
	} catch (_err) {
		return null;
	}

	if (!decoded || typeof decoded !== "object") return null;
	if (typeof decoded.gid !== "string" || !isUuid(decoded.gid)) return null;
	if (typeof decoded.exp !== "number") return null;
	if (decoded.exp <= Math.floor(Date.now() / 1000)) return null;

	return decoded.gid;
}

function buildGuestSetCookie(guestId, { secure = true, secret }) {
	const value = createGuestCookieValue(guestId, secret);
	return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function isUuid(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

module.exports = {
	COOKIE_NAME,
	ONE_YEAR_SECONDS,
	buildGuestSetCookie,
	isUuid,
	readGuestCookie,
};
