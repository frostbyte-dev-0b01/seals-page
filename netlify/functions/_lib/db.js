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
			streak_eligible,
			updated_at
		)
		SELECT
			id,
			$2::text,
			$3::date,
			$4::integer,
			$5::integer,
			$6::timestamptz,
			$7::boolean,
			NOW()
		FROM principal
		ON CONFLICT (principal_id, puzzle_id)
		DO UPDATE SET
			puzzle_date = user_puzzle_stats.puzzle_date,
			guesses_on_win = COALESCE(user_puzzle_stats.guesses_on_win, EXCLUDED.guesses_on_win),
			total_words_found = COALESCE(user_puzzle_stats.total_words_found, EXCLUDED.total_words_found),
			completed_at = COALESCE(user_puzzle_stats.completed_at, EXCLUDED.completed_at),
			streak_eligible = CASE
				WHEN user_puzzle_stats.completed_at IS NULL
					THEN user_puzzle_stats.streak_eligible OR EXCLUDED.streak_eligible
				ELSE user_puzzle_stats.streak_eligible
			END,
			first_seen_at = COALESCE(user_puzzle_stats.first_seen_at, EXCLUDED.first_seen_at),
			first_play_at = COALESCE(user_puzzle_stats.first_play_at, EXCLUDED.first_play_at),
			first_share_at = COALESCE(user_puzzle_stats.first_share_at, EXCLUDED.first_share_at),
			updated_at = CASE
				WHEN user_puzzle_stats.completed_at IS NULL THEN NOW()
				ELSE user_puzzle_stats.updated_at
			END
		RETURNING principal_id, puzzle_id;
	`;

	const params = [
		statsRecord.guest_id,
		statsRecord.puzzle_id,
		statsRecord.puzzle_date,
		statsRecord.guesses_on_win,
		statsRecord.total_words_found,
		statsRecord.completed_at,
		statsRecord.streak_eligible === true
	];

	const { rows } = await getPool().query(sql, params);
	return rows[0] || null;
}

const VALID_EVENT_TYPES = ["first_seen", "first_play", "first_share"];
const EVENT_TYPE_COLUMN = {
	first_seen: "first_seen_at",
	first_play: "first_play_at",
	first_share: "first_share_at"
};

async function upsertActivityTimestamp({ guest_id, puzzle_id, puzzle_date, event_type }) {
	if (!VALID_EVENT_TYPES.includes(event_type)) {
		throw new Error(`Invalid event_type: ${event_type}`);
	}

	const tsColumn = EVENT_TYPE_COLUMN[event_type];

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
			${tsColumn},
			completed_at,
			updated_at
		)
		SELECT
			id,
			$2::text,
			$3::date,
			NOW(),
			NULL,
			NOW()
		FROM principal
		ON CONFLICT (principal_id, puzzle_id)
		DO UPDATE SET
			${tsColumn} = COALESCE(user_puzzle_stats.${tsColumn}, EXCLUDED.${tsColumn}),
			updated_at = NOW()
		RETURNING principal_id, puzzle_id;
	`;

	const { rows } = await getPool().query(sql, [guest_id, puzzle_id, puzzle_date]);
	return rows[0] || null;
}

async function upsertLoadPerfEvent({
	guest_id,
	session_load_id,
	puzzle_id = null,
	puzzle_date = null,
	app_version = null,
	page_path = null,
	user_agent = null,
	marks = {},
	durations = {},
	assets = [],
	service_worker = {}
}) {
	// Beacons can fire 1–3 times per pageload (engine ready / gameplay ready /
	// pagehide). The upsert merges incoming jsonb so a later partial beacon
	// adds new marks without dropping earlier ones. `assets` is replaced
	// rather than merged when non-empty, since the Resource Timing snapshot is
	// already cumulative — later snapshots strictly supersede earlier ones.
	const sql = `
		WITH principal AS (
			INSERT INTO principals (principal_type, guest_cookie_id, last_seen_at)
			VALUES ('guest', $1::uuid, NOW())
			ON CONFLICT (guest_cookie_id)
			DO UPDATE SET last_seen_at = NOW()
			RETURNING id
		)
		INSERT INTO load_perf_events (
			session_load_id,
			principal_id,
			puzzle_id,
			puzzle_date,
			app_version,
			page_path,
			user_agent,
			marks,
			durations,
			assets,
			service_worker
		)
		SELECT
			$2::uuid,
			id,
			NULLIF($3::text, ''),
			$4::date,
			NULLIF($5::text, ''),
			NULLIF($6::text, ''),
			NULLIF($7::text, ''),
			$8::jsonb,
			$9::jsonb,
			$10::jsonb,
			$11::jsonb
		FROM principal
		ON CONFLICT (session_load_id) DO UPDATE SET
			puzzle_id = COALESCE(EXCLUDED.puzzle_id, load_perf_events.puzzle_id),
			puzzle_date = COALESCE(EXCLUDED.puzzle_date, load_perf_events.puzzle_date),
			app_version = COALESCE(EXCLUDED.app_version, load_perf_events.app_version),
			page_path = COALESCE(EXCLUDED.page_path, load_perf_events.page_path),
			user_agent = COALESCE(EXCLUDED.user_agent, load_perf_events.user_agent),
			marks = load_perf_events.marks || EXCLUDED.marks,
			durations = load_perf_events.durations || EXCLUDED.durations,
			assets = CASE
				WHEN jsonb_array_length(EXCLUDED.assets) > 0 THEN EXCLUDED.assets
				ELSE load_perf_events.assets
			END,
			service_worker = load_perf_events.service_worker || EXCLUDED.service_worker,
			updated_at = NOW()
		RETURNING id;
	`;

	const { rows } = await getPool().query(sql, [
		guest_id,
		session_load_id,
		puzzle_id,
		puzzle_date,
		app_version,
		page_path,
		user_agent,
		JSON.stringify(marks),
		JSON.stringify(durations),
		JSON.stringify(assets),
		JSON.stringify(service_worker)
	]);
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
		WHERE completed_at IS NOT NULL
		  AND ($1::date IS NULL OR puzzle_date = $1::date)
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
		return { rows };
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

	const db = getPool();
	const { rows } = await db.query(sql, [puzzleDate, puzzleId, startDate, endDate, limit]);

	// When filtering to a specific puzzle, also return guess distribution
	let guess_distribution = {};
	if (puzzleDate || puzzleId) {
		try {
			const distSql = `
				SELECT
					CASE
						WHEN guesses_on_win >= 9 THEN '9+'
						ELSE guesses_on_win::text
					END AS bucket,
					COUNT(*)::integer AS count
				FROM user_puzzle_stats
				${whereSql}
				GROUP BY
					CASE WHEN guesses_on_win >= 9 THEN '9+' ELSE guesses_on_win::text END
				ORDER BY
					MIN(CASE WHEN guesses_on_win >= 9 THEN 9999 ELSE guesses_on_win END);
			`;
			const distRes = await db.query(distSql, [puzzleDate, puzzleId, startDate, endDate]);
			for (const row of distRes.rows) {
				guess_distribution[row.bucket] = row.count;
			}
		} catch (err) {
			console.error("Community distribution query failed (non-fatal):", err.message);
		}
	}

	return { rows, guess_distribution };
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
		WHERE p.guest_cookie_id = $1::uuid
		  AND ups.completed_at IS NOT NULL;
	`;

	const windowSql = `
		SELECT
			COUNT(*)::integer AS games_completed_window,
			AVG(ups.guesses_on_win)::numeric(10,2) AS avg_guesses_window,
			AVG(ups.total_words_found)::numeric(10,2) AS avg_words_window
		FROM user_puzzle_stats ups
		JOIN principals p ON p.id = ups.principal_id
		WHERE p.guest_cookie_id = $1::uuid
		  AND ups.completed_at IS NOT NULL
		  AND ups.puzzle_date >= (CURRENT_DATE - ($2::integer - 1));
	`;

	const seriesSql = `
		SELECT
			ups.puzzle_date::text AS puzzle_date,
			COUNT(*)::integer AS games_completed,
			COUNT(*) FILTER (WHERE COALESCE(ups.streak_eligible, false))::integer
				AS streak_eligible_games_completed,
			AVG(ups.guesses_on_win)::numeric(10,2) AS avg_guesses_on_win,
			AVG(ups.total_words_found)::numeric(10,2) AS avg_total_words_found
		FROM user_puzzle_stats ups
		JOIN principals p ON p.id = ups.principal_id
		WHERE p.guest_cookie_id = $1::uuid
		  AND ups.completed_at IS NOT NULL
		  AND ups.puzzle_date >= (CURRENT_DATE - ($2::integer - 1))
		GROUP BY ups.puzzle_date
		ORDER BY ups.puzzle_date ASC;
	`;

	const puzzleProgressSql = `
		SELECT
			ups.puzzle_id,
			ups.puzzle_date::text AS puzzle_date,
			(ups.completed_at IS NOT NULL) AS completed,
			ups.completed_at::text AS completed_at,
			ups.first_play_at::text AS first_play_at,
			ups.first_seen_at::text AS first_seen_at,
			ups.first_share_at::text AS first_share_at,
			ups.guesses_on_win,
			ups.total_words_found,
			COALESCE(ups.streak_eligible, false) AS streak_eligible
		FROM user_puzzle_stats ups
		JOIN principals p ON p.id = ups.principal_id
		WHERE p.guest_cookie_id = $1::uuid
		  AND (ups.completed_at IS NOT NULL OR ups.first_play_at IS NOT NULL)
		ORDER BY ups.puzzle_date ASC, ups.puzzle_id ASC;
	`;

	const distributionSql = `
		SELECT
			CASE
				WHEN guesses_on_win >= 9 THEN '9+'
				ELSE guesses_on_win::text
			END AS bucket,
			COUNT(*)::integer AS count
		FROM user_puzzle_stats ups
		JOIN principals p ON p.id = ups.principal_id
		WHERE p.guest_cookie_id = $1::uuid
		  AND ups.completed_at IS NOT NULL
		GROUP BY
			CASE WHEN guesses_on_win >= 9 THEN '9+' ELSE guesses_on_win::text END
		ORDER BY
			MIN(CASE WHEN guesses_on_win >= 9 THEN 9999 ELSE guesses_on_win END);
	`;

	const db = getPool();
	const [overallRes, windowRes, seriesRes, puzzleProgressRes] = await Promise.all([
		db.query(overallSql, [guestId]),
		db.query(windowSql, [guestId, windowDays]),
		db.query(seriesSql, [guestId, seriesDays]),
		db.query(puzzleProgressSql, [guestId])
	]);

	let guess_distribution = {};
	try {
		const distributionRes = await db.query(distributionSql, [guestId]);
		for (const row of distributionRes.rows) {
			guess_distribution[row.bucket] = row.count;
		}
	} catch (err) {
		console.error("Distribution query failed (non-fatal):", err.message);
	}

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
		series: seriesRes.rows,
		puzzle_progress: puzzleProgressRes.rows,
		guess_distribution
	};
}

module.exports = {
	getUserGuessAveragesForGuest,
	getUserPuzzleStatsSummary,
	touchGuestPrincipal,
	upsertActivityTimestamp,
	upsertLoadPerfEvent,
	upsertUserPuzzleStats
};
