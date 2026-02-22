const { Pool } = require("pg");

let pool;

function getDbUrl() {
	return process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || "";
}

function getPool() {
	if (pool) return pool;
	const connectionString = getDbUrl();
	if (!connectionString) {
		throw new Error("Missing NETLIFY_DATABASE_URL (or DATABASE_URL)");
	}
	pool = new Pool({
		connectionString,
		ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }
	});
	return pool;
}

async function touchGuestPrincipal(guestId) {
	const sql = `
		INSERT INTO principals (principal_type, guest_cookie_id, last_seen_at)
		VALUES ('guest', $1::uuid, NOW())
		ON CONFLICT (guest_cookie_id)
		DO UPDATE SET last_seen_at = NOW()
		RETURNING id;
	`;
	const { rows } = await getPool().query(sql, [guestId]);
	return rows[0]?.id || null;
}

async function upsertUserPuzzleStats(statsRecord) {
	const sql = `
		WITH principal AS (
			INSERT INTO principals (principal_type, guest_cookie_id, last_seen_at)
			VALUES ('guest', $1::uuid, NOW())
			ON CONFLICT (guest_cookie_id)
			DO UPDATE SET last_seen_at = NOW()
			RETURNING id
		)
		INSERT INTO user_puzzle_stats (
			principal_id,
			puzzle_id,
			puzzle_date,
			guesses_on_win,
			total_words_found,
			completed_at,
			updated_at
		)
		SELECT
			id,
			$2::text,
			$3::date,
			$4::integer,
			$5::integer,
			$6::timestamptz,
			NOW()
		FROM principal
		ON CONFLICT (principal_id, puzzle_id)
		DO UPDATE SET
			puzzle_date = EXCLUDED.puzzle_date,
			guesses_on_win = EXCLUDED.guesses_on_win,
			total_words_found = EXCLUDED.total_words_found,
			completed_at = EXCLUDED.completed_at,
			updated_at = NOW()
		RETURNING principal_id, puzzle_id;
	`;

	const params = [
		statsRecord.guest_id,
		statsRecord.puzzle_id,
		statsRecord.puzzle_date,
		statsRecord.guesses_on_win,
		statsRecord.total_words_found,
		statsRecord.completed_at
	];

	const { rows } = await getPool().query(sql, params);
	return rows[0] || null;
}

async function getUserPuzzleStatsSummary({
	puzzleDate = null,
	puzzleId = null,
	startDate = null,
	endDate = null,
	rollup = false,
	limit = 50
}) {
	const whereSql = `
		WHERE ($1::date IS NULL OR puzzle_date = $1::date)
		  AND ($2::text IS NULL OR puzzle_id = $2::text)
		  AND ($3::date IS NULL OR puzzle_date >= $3::date)
		  AND ($4::date IS NULL OR puzzle_date <= $4::date)
	`;

	if (rollup) {
		const sql = `
			SELECT
				COUNT(*)::integer AS players,
				AVG(guesses_on_win)::numeric(10,2) AS avg_guesses_on_win,
				AVG(total_words_found)::numeric(10,2) AS avg_total_words_found,
				MIN(guesses_on_win)::integer AS min_guesses_on_win,
				MAX(guesses_on_win)::integer AS max_guesses_on_win
			FROM user_puzzle_stats
			${whereSql};
		`;
		const { rows } = await getPool().query(sql, [puzzleDate, puzzleId, startDate, endDate]);
		return rows;
	}

	const sql = `
		SELECT
			puzzle_date,
			puzzle_id,
			COUNT(*)::integer AS players,
			AVG(guesses_on_win)::numeric(10,2) AS avg_guesses_on_win,
			AVG(total_words_found)::numeric(10,2) AS avg_total_words_found,
			MIN(guesses_on_win)::integer AS min_guesses_on_win,
			MAX(guesses_on_win)::integer AS max_guesses_on_win
		FROM user_puzzle_stats
		${whereSql}
		GROUP BY puzzle_date, puzzle_id
		ORDER BY puzzle_date DESC, puzzle_id ASC
		LIMIT $5::integer;
	`;

	const { rows } = await getPool().query(sql, [puzzleDate, puzzleId, startDate, endDate, limit]);
	return rows;
}

async function getUserGuessAveragesForGuest({
	guestId,
	windowDays = 30,
	seriesDays = 30
}) {
	const overallSql = `
		SELECT
			COUNT(*)::integer AS games_completed,
			AVG(ups.guesses_on_win)::numeric(10,2) AS avg_guesses_all_time,
			AVG(ups.total_words_found)::numeric(10,2) AS avg_words_all_time
		FROM user_puzzle_stats ups
		JOIN principals p ON p.id = ups.principal_id
		WHERE p.guest_cookie_id = $1::uuid;
	`;

	const windowSql = `
		SELECT
			COUNT(*)::integer AS games_completed_window,
			AVG(ups.guesses_on_win)::numeric(10,2) AS avg_guesses_window,
			AVG(ups.total_words_found)::numeric(10,2) AS avg_words_window
		FROM user_puzzle_stats ups
		JOIN principals p ON p.id = ups.principal_id
		WHERE p.guest_cookie_id = $1::uuid
		  AND ups.puzzle_date >= (CURRENT_DATE - ($2::integer - 1));
	`;

	const seriesSql = `
		SELECT
			ups.puzzle_date::text AS puzzle_date,
			COUNT(*)::integer AS games_completed,
			AVG(ups.guesses_on_win)::numeric(10,2) AS avg_guesses_on_win,
			AVG(ups.total_words_found)::numeric(10,2) AS avg_total_words_found
		FROM user_puzzle_stats ups
		JOIN principals p ON p.id = ups.principal_id
		WHERE p.guest_cookie_id = $1::uuid
		  AND ups.puzzle_date >= (CURRENT_DATE - ($2::integer - 1))
		GROUP BY ups.puzzle_date
		ORDER BY ups.puzzle_date ASC;
	`;

	const db = getPool();
	const [overallRes, windowRes, seriesRes] = await Promise.all([
		db.query(overallSql, [guestId]),
		db.query(windowSql, [guestId, windowDays]),
		db.query(seriesSql, [guestId, seriesDays])
	]);

	return {
		overall: overallRes.rows[0] || {
			games_completed: 0,
			avg_guesses_all_time: null,
			avg_words_all_time: null
		},
		window: windowRes.rows[0] || {
			games_completed_window: 0,
			avg_guesses_window: null,
			avg_words_window: null
		},
		series: seriesRes.rows
	};
}

module.exports = {
	getUserGuessAveragesForGuest,
	getUserPuzzleStatsSummary,
	touchGuestPrincipal,
	upsertUserPuzzleStats
};
