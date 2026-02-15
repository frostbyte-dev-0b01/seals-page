const crypto = require("node:crypto");
const {
	buildGuestSetCookie,
	readGuestCookie
} = require("./_lib/cookie");
const { touchGuestPrincipal } = require("./_lib/db");

function json(statusCode, body, headers = {}) {
	return {
		statusCode,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...headers
		},
		body: JSON.stringify(body)
	};
}

exports.handler = async (event) => {
	if (event.httpMethod !== "POST") {
		return json(405, { ok: false, error: "Method Not Allowed" }, { Allow: "POST" });
	}

	const secret = process.env.GUEST_COOKIE_SECRET;
	if (!secret) {
		return json(500, { ok: false, error: "Missing GUEST_COOKIE_SECRET" });
	}

	const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
	let guestId = readGuestCookie(cookieHeader, secret);
	if (!guestId) {
		guestId = crypto.randomUUID();
	}

	try {
		await touchGuestPrincipal(guestId);
	} catch (err) {
		console.error("Failed touching principal", err);
		return json(500, { ok: false, error: "Failed to initialize session principal" });
	}

	const setCookie = buildGuestSetCookie(guestId, {
		secure: true,
		secret
	});

	return json(
		200,
		{
			ok: true
		},
		{
			"Set-Cookie": setCookie,
			"Cache-Control": "no-store"
		}
	);
};
