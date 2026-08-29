const crypto = require("node:crypto");

let pool;

function getDbUrl() {
	return process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || "";
}

function getPool() {
	if (pool) return pool;
	// Lazy require so importing this module (e.g. from unit tests that inject a
	// fake pool via setPoolForTests) does not pull in the native `pg` driver.
	const { Pool } = require("pg");
	const connectionString = getDbUrl();
	if (!connectionString) {
		throw new Error("Missing NETLIFY_DATABASE_URL (or DATABASE_URL)");
	}
	pool = new Pool({
		connectionString,
		ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
	});
	return pool;
}

// Test-only seam: inject a fake `{ query }` pool so handlers can be exercised
// without a real database. Not used in production code paths.
function setPoolForTests(fakePool) {
	pool = fakePool;
}

function resetPoolForTests() {
	pool = undefined;
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
		statsRecord.streak_eligible === true,
	];

	const { rows } = await getPool().query(sql, params);
	return rows[0] || null;
}

// Cross-device resume (signed-in users only). Stores the in-progress board-state
// blob on the existing (principal_id, puzzle_id) row. Unlike the other upserts,
// this one refuses to create or write a *guest* principal: progress only syncs
// for real accounts, so a guest (or a forged request without an account cookie)
// is a no-op. The DO UPDATE guards on progress_word_count so a stale device with
// fewer words can never clobber a more-complete blob; combined with the client's
// union-on-load this converges both devices. Never touches score/completion cols.
async function upsertPuzzleProgress({ guest_id, puzzle_id, puzzle_date, progress, word_count }) {
	const sql = `
		WITH principal AS (
			SELECT id FROM principals
			 WHERE guest_cookie_id = $1::uuid
			   AND principal_type = 'user'
			   AND auth_user_id IS NOT NULL
		)
		INSERT INTO user_puzzle_stats (
			principal_id,
			puzzle_id,
			puzzle_date,
			completed_at,
			progress,
			progress_word_count,
			progress_updated_at,
			updated_at
		)
		SELECT
			id,
			$2::text,
			$3::date,
			NULL,
			$4::jsonb,
			$5::integer,
			NOW(),
			NOW()
		FROM principal
		ON CONFLICT (principal_id, puzzle_id)
		DO UPDATE SET
			progress = EXCLUDED.progress,
			progress_word_count = EXCLUDED.progress_word_count,
			progress_updated_at = NOW(),
			updated_at = CASE
				WHEN user_puzzle_stats.completed_at IS NULL THEN NOW()
				ELSE user_puzzle_stats.updated_at
			END
		WHERE EXCLUDED.progress_word_count
			>= COALESCE(user_puzzle_stats.progress_word_count, -1)
		RETURNING principal_id, puzzle_id;
	`;

	const params = [
		guest_id,
		puzzle_id,
		puzzle_date,
		JSON.stringify(progress || {}),
		Number.isInteger(word_count) && word_count >= 0 ? word_count : 0,
	];

	const { rows } = await getPool().query(sql, params);
	return rows[0] || null;
}

// Affiliate / referral attribution. Records first-touch attribution against the
// guest principal (COALESCE keeps the first partner that drove the device, so a
// later ?ref= landing never rewrites the original) and appends a raw hit to
// referral_hits for volume / last-touch reporting. Creates the guest principal
// if this is the very first request from the device, exactly like the other
// upserts here. Never touches account/completion columns.
async function recordReferral({
	guest_id,
	ref_source,
	ref_medium = null,
	ref_campaign = null,
	landing_path = null,
	referrer = null,
}) {
	const sql = `
		WITH principal AS (
			INSERT INTO principals (
				principal_type,
				guest_cookie_id,
				ref_source,
				ref_medium,
				ref_campaign,
				ref_landing_path,
				ref_first_at,
				last_seen_at
			)
			VALUES (
				'guest',
				$1::uuid,
				$2::text,
				NULLIF($3::text, ''),
				NULLIF($4::text, ''),
				NULLIF($5::text, ''),
				NOW(),
				NOW()
			)
			ON CONFLICT (guest_cookie_id)
			DO UPDATE SET
				last_seen_at = NOW(),
				ref_source = COALESCE(principals.ref_source, EXCLUDED.ref_source),
				ref_medium = COALESCE(principals.ref_medium, EXCLUDED.ref_medium),
				ref_campaign = COALESCE(principals.ref_campaign, EXCLUDED.ref_campaign),
				ref_landing_path = COALESCE(principals.ref_landing_path, EXCLUDED.ref_landing_path),
				ref_first_at = COALESCE(principals.ref_first_at, EXCLUDED.ref_first_at)
			RETURNING id
		)
		INSERT INTO referral_hits (
			principal_id,
			ref_source,
			ref_medium,
			ref_campaign,
			landing_path,
			referrer
		)
		SELECT
			id,
			$2::text,
			NULLIF($3::text, ''),
			NULLIF($4::text, ''),
			NULLIF($5::text, ''),
			NULLIF($6::text, '')
		FROM principal
		RETURNING id;
	`;

	const params = [
		guest_id,
		ref_source,
		ref_medium || "",
		ref_campaign || "",
		landing_path || "",
		referrer || "",
	];

	const { rows } = await getPool().query(sql, params);
	return rows[0] || null;
}

// Per-affiliate funnel for the referral-summary reporting endpoint. Groups the
// first-touch attribution on principals by source (+ campaign) and layers on the
// downstream funnel (plays / completions / sign-ups) plus the raw landing count
// from referral_hits. Optional filters: a single source and a first-touch date
// window (inclusive of both ends).
async function getReferralSummary({
	refSource = null,
	startDate = null,
	endDate = null,
	limit = 100,
}) {
	const sql = `
		WITH hits AS (
			SELECT ref_source, ref_campaign, COUNT(*)::integer AS hits
			FROM referral_hits
			WHERE ($1::text IS NULL OR ref_source = $1::text)
			  AND ($2::date IS NULL OR created_at >= $2::date)
			  AND ($3::date IS NULL OR created_at < ($3::date + 1))
			GROUP BY ref_source, ref_campaign
		),
		funnel AS (
			SELECT
				p.ref_source,
				p.ref_campaign,
				COUNT(DISTINCT p.id)::integer AS visitors,
				COUNT(DISTINCT p.id) FILTER (WHERE p.auth_user_id IS NOT NULL)::integer AS signups,
				COUNT(DISTINCT ups.principal_id)
					FILTER (WHERE ups.first_play_at IS NOT NULL)::integer AS players,
				COUNT(DISTINCT ups.principal_id)
					FILTER (WHERE ups.completed_at IS NOT NULL)::integer AS players_completed,
				COUNT(*) FILTER (WHERE ups.completed_at IS NOT NULL)::integer AS completions
			FROM principals p
			LEFT JOIN user_puzzle_stats ups ON ups.principal_id = p.id
			WHERE p.ref_source IS NOT NULL
			  AND ($1::text IS NULL OR p.ref_source = $1::text)
			  AND ($2::date IS NULL OR p.ref_first_at >= $2::date)
			  AND ($3::date IS NULL OR p.ref_first_at < ($3::date + 1))
			GROUP BY p.ref_source, p.ref_campaign
		)
		SELECT
			COALESCE(f.ref_source, h.ref_source) AS ref_source,
			COALESCE(f.ref_campaign, h.ref_campaign) AS ref_campaign,
			COALESCE(h.hits, 0)::integer AS hits,
			COALESCE(f.visitors, 0)::integer AS visitors,
			COALESCE(f.players, 0)::integer AS players,
			COALESCE(f.players_completed, 0)::integer AS players_completed,
			COALESCE(f.completions, 0)::integer AS completions,
			COALESCE(f.signups, 0)::integer AS signups
		FROM funnel f
		-- The join keys must be hash/merge-joinable: Postgres rejects a FULL JOIN on
		-- IS NOT DISTINCT FROM outright ("FULL JOIN is only supported with
		-- merge-joinable or hash-joinable join conditions"), which made this query
		-- fail on every call. Plain = is safe on ref_source (NOT NULL in
		-- referral_hits, and funnel filters ref_source IS NOT NULL); only
		-- ref_campaign is nullable, so COALESCE it to a sentinel to match NULLs.
		-- That sentinel is a real value, not an impossible one, so the IS NULL
		-- pair below keeps a literal '' campaign from colliding with a NULL one
		-- and fanning the join out into duplicate rows. The write path NULLIFs
		-- '' away (see recordReferral) but no constraint enforces that, and a
		-- manual backfill into these analytics tables would not go through it.
		-- Each side references a single relation, so this stays hash-joinable.
		FULL OUTER JOIN hits h
			ON f.ref_source = h.ref_source
		   AND COALESCE(f.ref_campaign, '') = COALESCE(h.ref_campaign, '')
		   AND (f.ref_campaign IS NULL) = (h.ref_campaign IS NULL)
		ORDER BY visitors DESC, hits DESC, ref_source ASC
		LIMIT $4::integer;
	`;

	const { rows } = await getPool().query(sql, [refSource, startDate, endDate, limit]);
	return { rows };
}

const VALID_EVENT_TYPES = ["first_seen", "first_play", "first_share"];
const EVENT_TYPE_COLUMN = {
	first_seen: "first_seen_at",
	first_play: "first_play_at",
	first_share: "first_share_at",
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
	service_worker = {},
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
		JSON.stringify(service_worker),
	]);
	return rows[0] || null;
}

async function getUserPuzzleStatsSummary({
	puzzleDate = null,
	puzzleId = null,
	startDate = null,
	endDate = null,
	rollup = false,
	limit = 50,
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

// Account creation (#257). Links a verified Google identity to the principal
// the current device's guest cookie resolves to, returning the guest_cookie_id
// the device should carry afterward (unchanged for a claim; the account's for a
// merge). Runs in a transaction so a partial link can never split stats.
//
//  - CLAIM (Google sub unseen): upgrade the current guest principal in place —
//    set auth_user_id/email and principal_type='user'. Same principal_id, zero
//    row migration; the existing cookie keeps resolving to it.
//  - MERGE (Google sub already on another principal): fold this device's guest
//    stats into the existing account principal, resolving (principal_id,
//    puzzle_id) conflicts in the account's favor under the existing
//    "first completion wins" rule, then delete the guest principal. The caller
//    re-issues the device cookie to the account's guest_cookie_id.
async function linkGoogleAccount({ guestId, authUserId, email }) {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");

		// Ensure this device has a principal row to work from.
		await client.query(
			`INSERT INTO principals (principal_type, guest_cookie_id, last_seen_at)
			 VALUES ('guest', $1::uuid, NOW())
			 ON CONFLICT (guest_cookie_id) DO UPDATE SET last_seen_at = NOW()`,
			[guestId],
		);
		const { rows: currentRows } = await client.query(
			`SELECT id, auth_user_id FROM principals WHERE guest_cookie_id = $1::uuid`,
			[guestId],
		);
		const currentId = currentRows[0].id;
		const currentAuthUserId = currentRows[0].auth_user_id;

		const { rows: accountRows } = await client.query(
			`SELECT id, guest_cookie_id FROM principals WHERE auth_user_id = $1`,
			[authUserId],
		);

		// CLAIM: no existing account for this identity.
		if (accountRows.length === 0) {
			// Guard: if this device's principal is already linked to a *different*
			// account (the user is signed in as someone else and never signed out),
			// claiming in place would overwrite — and orphan — that account. Mint a
			// fresh principal for the new identity instead and point the device cookie
			// at it, leaving the prior account untouched.
			if (currentAuthUserId && currentAuthUserId !== authUserId) {
				const newGuestId = crypto.randomUUID();
				await client.query(
					`INSERT INTO principals (principal_type, auth_user_id, email, guest_cookie_id, last_seen_at)
					 VALUES ('user', $1, $2, $3::uuid, NOW())`,
					[authUserId, email, newGuestId],
				);
				await client.query("COMMIT");
				return { guestCookieId: newGuestId, merged: false };
			}
			await client.query(
				`UPDATE principals
				    SET principal_type = 'user', auth_user_id = $2, email = $3, last_seen_at = NOW()
				  WHERE id = $1`,
				[currentId, authUserId, email],
			);
			await client.query("COMMIT");
			return { guestCookieId: guestId, merged: false };
		}

		const account = accountRows[0];

		// Already signed in as this account on this device — just refresh email.
		if (account.id === currentId) {
			if (email) {
				await client.query(`UPDATE principals SET email = $2, last_seen_at = NOW() WHERE id = $1`, [
					account.id,
					email,
				]);
			}
			await client.query("COMMIT");
			return { guestCookieId: account.guest_cookie_id, merged: false };
		}

		// MERGE. Move non-conflicting guest rows wholesale onto the account.
		await client.query(
			`UPDATE user_puzzle_stats g
			    SET principal_id = $2
			  WHERE g.principal_id = $1
			    AND NOT EXISTS (
			        SELECT 1 FROM user_puzzle_stats a
			         WHERE a.principal_id = $2 AND a.puzzle_id = g.puzzle_id
			    )`,
			[currentId, account.id],
		);

		// For conflicting puzzles, keep the earliest completion (first-completion-
		// wins) and the earliest activity timestamps. LEAST() ignores NULLs.
		await client.query(
			`UPDATE user_puzzle_stats a
			    SET guesses_on_win = CASE
			            WHEN g.completed_at IS NOT NULL
			             AND (a.completed_at IS NULL OR g.completed_at < a.completed_at)
			            THEN g.guesses_on_win ELSE a.guesses_on_win END,
			        total_words_found = CASE
			            WHEN g.completed_at IS NOT NULL
			             AND (a.completed_at IS NULL OR g.completed_at < a.completed_at)
			            THEN g.total_words_found ELSE a.total_words_found END,
			        completed_at = CASE
			            WHEN g.completed_at IS NOT NULL
			             AND (a.completed_at IS NULL OR g.completed_at < a.completed_at)
			            THEN g.completed_at ELSE a.completed_at END,
			        streak_eligible = COALESCE(a.streak_eligible, false) OR COALESCE(g.streak_eligible, false),
			        first_seen_at = LEAST(a.first_seen_at, g.first_seen_at),
			        first_play_at = LEAST(a.first_play_at, g.first_play_at),
			        first_share_at = LEAST(a.first_share_at, g.first_share_at),
			        -- Keep the more-complete in-progress blob (more words wins; newer
			        -- write breaks ties). Guest "wins" only when it has a blob and is
			        -- strictly ahead, so a completed account row never loses progress.
			        progress = CASE WHEN (
			                g.progress IS NOT NULL AND (
			                    a.progress IS NULL
			                    OR COALESCE(g.progress_word_count, -1) > COALESCE(a.progress_word_count, -1)
			                    OR (COALESCE(g.progress_word_count, -1) = COALESCE(a.progress_word_count, -1)
			                        AND g.progress_updated_at > a.progress_updated_at)
			                )) THEN g.progress ELSE a.progress END,
			        progress_word_count = CASE WHEN (
			                g.progress IS NOT NULL AND (
			                    a.progress IS NULL
			                    OR COALESCE(g.progress_word_count, -1) > COALESCE(a.progress_word_count, -1)
			                    OR (COALESCE(g.progress_word_count, -1) = COALESCE(a.progress_word_count, -1)
			                        AND g.progress_updated_at > a.progress_updated_at)
			                )) THEN g.progress_word_count ELSE a.progress_word_count END,
			        progress_updated_at = CASE WHEN (
			                g.progress IS NOT NULL AND (
			                    a.progress IS NULL
			                    OR COALESCE(g.progress_word_count, -1) > COALESCE(a.progress_word_count, -1)
			                    OR (COALESCE(g.progress_word_count, -1) = COALESCE(a.progress_word_count, -1)
			                        AND g.progress_updated_at > a.progress_updated_at)
			                )) THEN g.progress_updated_at ELSE a.progress_updated_at END,
			        updated_at = NOW()
			   FROM user_puzzle_stats g
			  WHERE a.principal_id = $2 AND g.principal_id = $1 AND a.puzzle_id = g.puzzle_id`,
			[currentId, account.id],
		);

		// Carry affiliate attribution across the merge. Both the first-touch ref_*
		// columns and the referral_hits log hang off the guest principal, and
		// referral_hits cascades on principal delete -- so without this, signing into
		// an existing account on a referred device silently erases the partner that
		// drove the visit AND retroactively drops that device's landings from the
		// raw hit count. First touch still wins: the earlier ref_first_at of the two
		// principals is kept, and all five columns move as a unit so the surviving
		// row is never a mix of two campaigns.
		await client.query(
			`WITH winner AS (
				 SELECT ref_source, ref_medium, ref_campaign, ref_landing_path, ref_first_at
				   FROM principals
				  WHERE id IN ($1, $2)
				    AND ref_source IS NOT NULL
				  ORDER BY ref_first_at ASC NULLS LAST
				  LIMIT 1
			 )
			 UPDATE principals a
			    SET ref_source = w.ref_source,
			        ref_medium = w.ref_medium,
			        ref_campaign = w.ref_campaign,
			        ref_landing_path = w.ref_landing_path,
			        ref_first_at = w.ref_first_at
			   FROM winner w
			  WHERE a.id = $2`,
			[currentId, account.id],
		);
		await client.query(`UPDATE referral_hits SET principal_id = $2 WHERE principal_id = $1`, [
			currentId,
			account.id,
		]);

		// Drop the now-merged guest rows and the guest principal itself.
		await client.query(`DELETE FROM user_puzzle_stats WHERE principal_id = $1`, [currentId]);
		await client.query(`DELETE FROM principals WHERE id = $1`, [currentId]);

		if (email) {
			await client.query(`UPDATE principals SET email = $2, last_seen_at = NOW() WHERE id = $1`, [
				account.id,
				email,
			]);
		}

		await client.query("COMMIT");
		return { guestCookieId: account.guest_cookie_id, merged: true };
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (_rollbackErr) {
			// ignore rollback failures; surface the original error
		}
		throw err;
	} finally {
		client.release();
	}
}

// Stable, opaque per-account tag derived from the immutable `auth_user_id`
// (`google:<sub>`). Surfaced to the client so the web shell can stamp localStorage
// saves with their owning account and avoid merging one account's local progress
// into another on a shared browser. Hashed so the raw Google subject never lands
// in localStorage; deterministic so auth-me and auth-google produce the same tag.
function accountTag(authUserId) {
	if (!authUserId || typeof authUserId !== "string") return null;
	return crypto.createHash("sha256").update(authUserId).digest("hex").slice(0, 24);
}

// Account creation (#257). Returns the principal the device's guest cookie
// resolves to, so auth-me can report whether the visitor is signed in.
async function getAccountForGuest(guestId) {
	const { rows } = await getPool().query(
		`SELECT principal_type, auth_user_id, email FROM principals WHERE guest_cookie_id = $1::uuid`,
		[guestId],
	);
	return rows[0] || null;
}

async function getUserGuessAveragesForGuest({
	guestId,
	windowDays = 30,
	seriesDays = 30,
	progressPuzzleId = null,
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
			COALESCE(ups.streak_eligible, false) AS streak_eligible,
			-- The resume blob is the canonical board for the active puzzle, including
			-- completed ones (so switching accounts and back reconstructs a finished
			-- board). Bound the payload: the client only ever restores the board for the
			-- puzzle it currently has open, so when it names one ($2) ship that blob
			-- alone — otherwise an active player pulls dozens of full boards on every
			-- win screen. Unscoped callers keep the legacy rule: in-progress rows always
			-- carry the blob, completed rows only while recently active (older archive
			-- rows fall back to the completed flag alone, which the client treats as
			-- canonical).
			CASE
				WHEN $2::text IS NOT NULL AND ups.puzzle_id <> $2::text THEN NULL
				WHEN ups.completed_at IS NULL THEN ups.progress
				WHEN ups.progress_updated_at >= (NOW() - INTERVAL '45 days') THEN ups.progress
				ELSE NULL
			END AS progress
		FROM user_puzzle_stats ups
		JOIN principals p ON p.id = ups.principal_id
		WHERE p.guest_cookie_id = $1::uuid
		  AND (ups.completed_at IS NOT NULL OR ups.first_play_at IS NOT NULL OR ups.progress IS NOT NULL)
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
		db.query(puzzleProgressSql, [guestId, progressPuzzleId]),
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
			avg_words_all_time: null,
		},
		window: windowRes.rows[0] || {
			games_completed_window: 0,
			avg_guesses_window: null,
			avg_words_window: null,
		},
		series: seriesRes.rows,
		puzzle_progress: puzzleProgressRes.rows,
		guess_distribution,
	};
}

module.exports = {
	accountTag,
	getAccountForGuest,
	getReferralSummary,
	getUserGuessAveragesForGuest,
	getUserPuzzleStatsSummary,
	linkGoogleAccount,
	recordReferral,
	touchGuestPrincipal,
	upsertActivityTimestamp,
	upsertLoadPerfEvent,
	upsertPuzzleProgress,
	upsertUserPuzzleStats,
	setPoolForTests,
	resetPoolForTests,
};
