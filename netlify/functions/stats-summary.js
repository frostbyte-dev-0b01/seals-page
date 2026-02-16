const { getUserPuzzleStatsSummary } = require("./_lib/db");

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

function isIsoDate(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

exports.handler = async (event) => {
	if (event.httpMethod !== "GET") {
		return json(405, { ok: false, error: "Method Not Allowed" });
	}

	const params = event.queryStringParameters || {};
	const puzzleDate = params.puzzle_date || null;
	const puzzleId = params.puzzle_id || null;
	const startDate = params.start_date || null;
	const endDate = params.end_date || null;
	const rollup = params.rollup === "1" || params.rollup === "true";
	const rawLimit = params.limit || "50";
	const limit = Number.parseInt(rawLimit, 10);

	if (puzzleDate && !isIsoDate(puzzleDate)) {
		return json(400, { ok: false, error: "Invalid puzzle_date (expected YYYY-MM-DD)" });
	}
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
	if (puzzleId && typeof puzzleId !== "string") {
		return json(400, { ok: false, error: "Invalid puzzle_id" });
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		return json(400, { ok: false, error: "Invalid limit (1-500)" });
	}

	try {
		const rows = await getUserPuzzleStatsSummary({
			puzzleDate,
			puzzleId,
			startDate,
			endDate,
			rollup,
			limit
		});
		return json(200, { ok: true, rollup, rows });
	} catch (err) {
		console.error("Failed reading stats summary", err);
		return json(500, { ok: false, error: "Failed to fetch stats summary" });
	}
};
