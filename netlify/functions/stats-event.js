const { readGuestCookie } = require("./_lib/cookie");
const { upsertUserPuzzleStats } = require("./_lib/db");

function json(statusCode, body) {
	return {
		statusCode,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store"
		},
		body: JSON.stringify(body)
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

function isIsoDateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validatePayload(payload) {
	if (!payload || typeof payload !== "object") return "Invalid JSON payload";
	if (typeof payload.puzzle_id !== "string" || payload.puzzle_id.trim() === "") {
		return "Invalid puzzle_id";
	}
	if (typeof payload.puzzle_date !== "string" || !isIsoDateString(payload.puzzle_date)) {
		return "Invalid puzzle_date (expected YYYY-MM-DD)";
	}
	if (!Number.isInteger(payload.guesses_on_win) || payload.guesses_on_win < 0) {
		return "Invalid guesses_on_win";
	}
	if (!Number.isInteger(payload.total_words_found) || payload.total_words_found < 0) {
		return "Invalid total_words_found";
	}
	return null;
}

exports.handler = async (event) => {
	if (event.httpMethod !== "POST") {
		return json(405, { ok: false, error: "Method Not Allowed" });
	}

	const secret = process.env.GUEST_COOKIE_SECRET;
	if (!secret) {
		return json(500, { ok: false, error: "Missing GUEST_COOKIE_SECRET" });
	}

	const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
	const guestId = readGuestCookie(cookieHeader, secret);
	if (!guestId) {
		return json(401, { ok: false, error: "No valid guest session; call /session first" });
	}

	const payload = parseBody(event);
	const validationError = validatePayload(payload);
	if (validationError) {
		return json(400, { ok: false, error: validationError });
	}

	try {
		await upsertUserPuzzleStats({
			guest_id: guestId,
			puzzle_id: payload.puzzle_id.trim(),
			puzzle_date: payload.puzzle_date,
			guesses_on_win: payload.guesses_on_win,
			total_words_found: payload.total_words_found,
			completed_at: new Date().toISOString()
		});
	} catch (err) {
		console.error("Failed upserting user stats", err);
		return json(500, { ok: false, error: "Failed to persist user stats" });
	}

	return json(200, { ok: true });
};
