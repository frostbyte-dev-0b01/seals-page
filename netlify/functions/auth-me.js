const { readGuestCookie } = require("./_lib/cookie");
const { accountTag, getAccountForGuest } = require("./_lib/db");

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

// Reports whether the current device cookie resolves to a signed-in account, so
// the splash can show "Signed in as …" + Sign out on reload (not just right
// after the click). Read-only; never mints a cookie.
exports.handler = async (event) => {
	if (event.httpMethod !== "GET") {
		return json(405, { ok: false, error: "Method Not Allowed" }, { Allow: "GET" });
	}

	const secret = process.env.GUEST_COOKIE_SECRET;
	if (!secret) {
		return json(500, { ok: false, error: "Missing GUEST_COOKIE_SECRET" });
	}

	const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
	const guestId = readGuestCookie(cookieHeader, secret);
	if (!guestId) {
		return json(200, { ok: true, signed_in: false, email: null, account_id: null });
	}

	let row;
	try {
		row = await getAccountForGuest(guestId);
	} catch (err) {
		console.error("Failed reading account for guest", err);
		return json(500, { ok: false, error: "Failed to read account" });
	}

	const signedIn = !!(row && row.principal_type === "user" && row.auth_user_id);
	return json(200, {
		ok: true,
		signed_in: signedIn,
		email: signedIn ? row.email : null,
		account_id: signedIn ? accountTag(row.auth_user_id) : null,
	});
};
