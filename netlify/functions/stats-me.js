const { readGuestCookie } = require("./_lib/cookie");
const { getUserGuessAveragesForGuest } = require("./_lib/db");

function json(statusCode, body) {
	return {
		statusCode,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
		body: JSON.stringify(body),
	};
}

function parsePositiveInt(value, fallback) {
	if (value == null || value === "") return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) ? parsed : null;
}

exports.handler = async (event) => {
	if (event.httpMethod !== "GET") {
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

	const params = event.queryStringParameters || {};
	const windowDays = parsePositiveInt(params.window_days, 30);
	const seriesDays = parsePositiveInt(params.series_days, 30);
	// The caller names the puzzle it currently has open; only that row's board blob is
	// shipped back. Omitting it keeps the legacy "every recent blob" behaviour so an
	// older cached client still resumes.
	const progressPuzzleId =
		typeof params.progress_puzzle_id === "string" && params.progress_puzzle_id.trim() !== ""
			? params.progress_puzzle_id.trim()
			: null;

	if (windowDays == null || windowDays < 1 || windowDays > 3650) {
		return json(400, { ok: false, error: "Invalid window_days (1-3650)" });
	}
	if (seriesDays == null || seriesDays < 1 || seriesDays > 3650) {
		return json(400, { ok: false, error: "Invalid series_days (1-3650)" });
	}

	try {
		const data = await getUserGuessAveragesForGuest({
			guestId,
			windowDays,
			seriesDays,
			progressPuzzleId,
		});
		return json(200, {
			ok: true,
			window_days: windowDays,
			series_days: seriesDays,
			// Echoed so a client can tell a response scoped to a puzzle it has since
			// navigated away from, and skip restoring from it.
			progress_puzzle_id: progressPuzzleId,
			...data,
		});
	} catch (err) {
		console.error("Failed reading user guess averages", err);
		return json(500, { ok: false, error: "Failed to fetch user stats" });
	}
};
