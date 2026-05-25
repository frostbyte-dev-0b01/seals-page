const { readGuestCookie } = require("./_lib/cookie");
const { upsertActivityTimestamp, upsertLoadPerfEvent, upsertUserPuzzleStats } = require("./_lib/db");

const ACTIVITY_EVENT_TYPES = ["first_seen", "first_play", "first_share"];
const MAX_LOAD_PERF_JSON_BYTES = 24000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function validateCompletionPayload(payload) {
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
	if (payload.streak_eligible != null && typeof payload.streak_eligible !== "boolean") {
		return "Invalid streak_eligible";
	}
	return null;
}

function validateActivityPayload(payload) {
	if (!payload || typeof payload !== "object") return "Invalid JSON payload";
	if (typeof payload.puzzle_id !== "string" || payload.puzzle_id.trim() === "") {
		return "Invalid puzzle_id";
	}
	if (typeof payload.puzzle_date !== "string" || !isIsoDateString(payload.puzzle_date)) {
		return "Invalid puzzle_date (expected YYYY-MM-DD)";
	}
	return null;
}

function byteLength(value) {
	return Buffer.byteLength(JSON.stringify(value || null), "utf8");
}

function validateLoadPerfPayload(payload) {
	if (!payload || typeof payload !== "object") return "Invalid JSON payload";
	if (typeof payload.session_load_id !== "string" || !UUID_RE.test(payload.session_load_id)) {
		return "Invalid session_load_id (expected UUID)";
	}
	if (payload.puzzle_date != null && (typeof payload.puzzle_date !== "string" || !isIsoDateString(payload.puzzle_date))) {
		return "Invalid puzzle_date (expected YYYY-MM-DD)";
	}
	if (byteLength(payload) > MAX_LOAD_PERF_JSON_BYTES) {
		return "Load performance payload too large";
	}
	if (payload.marks != null && (typeof payload.marks !== "object" || Array.isArray(payload.marks))) {
		return "Invalid marks";
	}
	if (payload.durations != null && (typeof payload.durations !== "object" || Array.isArray(payload.durations))) {
		return "Invalid durations";
	}
	if (payload.assets != null && !Array.isArray(payload.assets)) {
		return "Invalid assets";
	}
	if (payload.service_worker != null && (typeof payload.service_worker !== "object" || Array.isArray(payload.service_worker))) {
		return "Invalid service_worker";
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
	if (!payload || typeof payload !== "object") {
		return json(400, { ok: false, error: "Invalid JSON payload" });
	}

	const eventType = payload.event_type;

	if (eventType && !ACTIVITY_EVENT_TYPES.includes(eventType) && eventType !== "completion" && eventType !== "load_perf") {
		return json(400, { ok: false, error: "Unknown event_type" });
	}

	if (eventType === "load_perf") {
		const validationError = validateLoadPerfPayload(payload);
		if (validationError) {
			return json(400, { ok: false, error: validationError });
		}
		try {
			await upsertLoadPerfEvent({
				guest_id: guestId,
				session_load_id: payload.session_load_id,
				puzzle_id: typeof payload.puzzle_id === "string" ? payload.puzzle_id.trim() : null,
				puzzle_date: payload.puzzle_date || null,
				app_version: typeof payload.app_version === "string" ? payload.app_version.trim() : null,
				page_path: typeof payload.page_path === "string" ? payload.page_path.slice(0, 512) : null,
				user_agent: typeof payload.user_agent === "string" ? payload.user_agent.slice(0, 512) : null,
				marks: payload.marks || {},
				durations: payload.durations || {},
				assets: payload.assets || [],
				service_worker: payload.service_worker || {}
			});
		} catch (err) {
			console.error("Failed upserting load performance event", err);
			return json(500, { ok: false, error: "Failed to persist load performance event" });
		}
		return json(200, { ok: true });
	}

	if (eventType && ACTIVITY_EVENT_TYPES.includes(eventType)) {
		const validationError = validateActivityPayload(payload);
		if (validationError) {
			return json(400, { ok: false, error: validationError });
		}
		try {
			await upsertActivityTimestamp({
				guest_id: guestId,
				puzzle_id: payload.puzzle_id.trim(),
				puzzle_date: payload.puzzle_date,
				event_type: eventType
			});
		} catch (err) {
			console.error("Failed upserting activity timestamp", err);
			return json(500, { ok: false, error: "Failed to persist activity timestamp" });
		}
		return json(200, { ok: true });
	}

	const validationError = validateCompletionPayload(payload);
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
			completed_at: new Date().toISOString(),
			streak_eligible: payload.streak_eligible !== false
		});
	} catch (err) {
		console.error("Failed upserting user stats", err);
		return json(500, { ok: false, error: "Failed to persist user stats" });
	}

	return json(200, { ok: true });
};
