const crypto = require("node:crypto");
const { getReferralSummary } = require("./_lib/db");

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

function isIsoDate(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Constant-time compare so a caller can't probe the admin token byte by byte.
function tokenMatches(provided, expected) {
	if (typeof provided !== "string" || typeof expected !== "string") return false;
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

function readBearer(event) {
	const headers = event.headers || {};
	const auth = headers.authorization || headers.Authorization || "";
	const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
	if (match) return match[1].trim();
	return (headers["x-admin-token"] || headers["X-Admin-Token"] || "").trim();
}

// Affiliate/referral funnel report. Business-sensitive, so it is gated behind a
// server-only admin token (REFERRAL_ADMIN_TOKEN) rather than being open like the
// public stats-summary endpoint. If the token env var is unset the endpoint is
// closed (500), never accidentally open.
exports.handler = async (event) => {
	if (event.httpMethod !== "GET") {
		return json(405, { ok: false, error: "Method Not Allowed" });
	}

	const adminToken = process.env.REFERRAL_ADMIN_TOKEN;
	if (!adminToken) {
		return json(500, { ok: false, error: "Missing REFERRAL_ADMIN_TOKEN" });
	}
	if (!tokenMatches(readBearer(event), adminToken)) {
		return json(401, { ok: false, error: "Unauthorized" });
	}

	const params = event.queryStringParameters || {};
	const refSource = params.ref_source || null;
	const startDate = params.start_date || null;
	const endDate = params.end_date || null;
	const rawLimit = params.limit || "100";
	const limit = Number.parseInt(rawLimit, 10);

	if (startDate && !isIsoDate(startDate)) {
		return json(400, { ok: false, error: "Invalid start_date (expected YYYY-MM-DD)" });
	}
	if (endDate && !isIsoDate(endDate)) {
		return json(400, { ok: false, error: "Invalid end_date (expected YYYY-MM-DD)" });
	}
	if ((startDate && !endDate) || (!startDate && endDate)) {
		return json(400, { ok: false, error: "start_date and end_date must be provided together" });
	}
	if (startDate && endDate && startDate > endDate) {
		return json(400, { ok: false, error: "start_date must be <= end_date" });
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		return json(400, { ok: false, error: "Invalid limit (1-500)" });
	}

	try {
		const data = await getReferralSummary({ refSource, startDate, endDate, limit });
		return json(200, { ok: true, rows: data.rows });
	} catch (err) {
		console.error("Failed reading referral summary", err);
		return json(500, { ok: false, error: "Failed to fetch referral summary" });
	}
};
