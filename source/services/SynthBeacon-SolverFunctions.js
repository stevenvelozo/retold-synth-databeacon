/**
 * SynthBeacon — Solver Functions
 *
 * Registers a family of `synth_*` functions on a fable ExpressionParser
 * instance. Each function generates one realistic value, deterministically
 * seeded so the same (spec + globalSeed + recordIndex + columnName) always
 * produces the same output.
 *
 * STRING-LITERAL CONVENTION
 * -------------------------
 * Spec authors MUST use double-quoted strings for any string argument:
 *
 *     synth_dateBetween("2020-01-01", "2025-12-31")    // OK
 *     synth_dateBetween('2020-01-01', '2025-12-31')    // BROKEN — yields "-1"
 *
 * fable's ExpressionParser does not honor single-quote string boundaries —
 * `'2020-01-01'` is tokenized as the math expression `2020 - 01 - 01` and
 * collapses to a numeric `-1`. Use `"..."` everywhere a string is meant.
 * This applies to date ranges, pipe-delimited picker values, and
 * cross-entity reference names.
 *
 * STRING CONCATENATION
 * --------------------
 * The `+` operator is strictly numeric (precise big.js math). To join
 * strings, use `CONCAT(...)`, which is variadic:
 *
 *     CONCAT(FirstName, " ", LastName)                     // OK → "Jane Doe"
 *     FirstName + " " + LastName                           // BROKEN → false
 *
 * This is a common gotcha for cross-cell references where a later field
 * builds a display string from earlier columns.
 *
 * Determinism plumbing
 * --------------------
 * The synth beacon, before each `parser.solve(...)` call, sets:
 *
 *   fable.SynthContext = {
 *     seed:         '<sha1 of globalSeed + entity + recordIndex + columnName>',
 *     globalSeed:   '<the operator-provided seed>',
 *     entity:       '<entity name>',
 *     recordIndex:  <0-based row index>,
 *     // optional cross-entity context bound by the evaluator before
 *     // generating the row (e.g. parent record fields a domain-correlation
 *     // solver function reads from)
 *   };
 *
 * Each `synth_*` function reads `fable.SynthContext.seed`, instantiates a
 * fresh `Chance(seed)` instance, calls one method, and returns the result.
 * Per-cell seeding (not per-row) means a single field can call multiple
 * `synth_*` functions and each gets its own independent stream — change one
 * field's expression and only that field's output shifts; everything else
 * stays bit-stable.
 *
 * Architectural note
 * ------------------
 * `fable.SynthContext` is mutable shared state inside one synth beacon
 * process. That's fine for the current single-threaded per-work-item
 * pattern. If we ever want to distribute generation across workers, the
 * seed will need to flow through as an explicit parameter on each
 * `synth_*` call instead. For now, ergonomics wins — specs are way
 * cleaner without a `seed` arg on every line.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
const libChance = require('chance');

/**
 * Read the per-cell seed off fable.SynthContext, hash it once, return a
 * fresh Chance instance keyed to it. Defensive: if the context isn't set
 * (e.g. a custom solver call path the beacon didn't prep) we fall back to
 * `Math.random()`-shaped output via Chance() with no seed — non-determ but
 * non-fatal.
 */
function chanceFor(pFable)
{
	let tmpCtx = pFable && pFable.SynthContext;
	let tmpSeed = (tmpCtx && tmpCtx.seed) || '';
	if (!tmpSeed)
	{
		return new libChance();
	}
	return new libChance(tmpSeed);
}

/**
 * Build the function bag bound to one fable instance. The functions are
 * exposed on `fable.Synth` so each registered solver function can be
 * referenced by address (e.g. `'fable.Synth.company'`) the way fable's
 * ExpressionParser expects.
 */
function buildSynthFunctions(pFable)
{
	let tmpSynth = {};

	// ── Strings (people / places / business) ────────────────────────

	tmpSynth.firstName = function ()
	{
		return chanceFor(pFable).first();
	};
	tmpSynth.lastName = function ()
	{
		return chanceFor(pFable).last();
	};
	tmpSynth.fullName = function ()
	{
		return chanceFor(pFable).name();
	};
	tmpSynth.email = function ()
	{
		// `domain` is constrained because chance's defaults occasionally
		// emit obviously-fake TLDs (.invalid, .test) which look wrong in
		// realistic-looking demo data. Pinning gives consistent shape.
		return chanceFor(pFable).email({ domain: 'example.com' });
	};
	tmpSynth.phone = function ()
	{
		return chanceFor(pFable).phone({ formatted: true, country: 'us' });
	};
	tmpSynth.address = function ()
	{
		return chanceFor(pFable).address();
	};
	tmpSynth.city = function ()
	{
		return chanceFor(pFable).city();
	};
	tmpSynth.state = function ()
	{
		return chanceFor(pFable).state({ full: true });
	};
	tmpSynth.stateCode = function ()
	{
		return chanceFor(pFable).state();
	};
	tmpSynth.country = function ()
	{
		return chanceFor(pFable).country({ full: true });
	};
	tmpSynth.countryCode = function ()
	{
		return chanceFor(pFable).country();
	};
	tmpSynth.postalCode = function ()
	{
		return chanceFor(pFable).zip();
	};
	tmpSynth.company = function ()
	{
		// Chance doesn't ship a "company" generator out of the box; fake
		// one with capitalized noun + suffix. Determinism preserved
		// because both pulls come off the same seeded chance.
		let tmpC = chanceFor(pFable);
		let tmpSuffixes = ['Inc.', 'LLC', 'Corp', 'Industries', 'Group', 'Holdings', 'Partners', 'Manufacturing', 'Systems', 'Logistics'];
		let tmpName = tmpC.word({ syllables: tmpC.integer({ min: 2, max: 4 }) });
		let tmpSuffix = tmpC.pickone(tmpSuffixes);
		return tmpName.charAt(0).toUpperCase() + tmpName.slice(1) + ' ' + tmpSuffix;
	};
	tmpSynth.profession = function ()
	{
		return chanceFor(pFable).profession();
	};
	tmpSynth.department = function ()
	{
		// Same story as company — chance has no department generator;
		// pickone over a curated list of recognizable functions.
		let tmpDepts = ['Engineering', 'Sales', 'Marketing', 'Finance', 'Operations',
			'Procurement', 'Quality', 'Logistics', 'Customer Service', 'Legal',
			'HR', 'IT', 'Manufacturing', 'R&D', 'Product'];
		return chanceFor(pFable).pickone(tmpDepts);
	};

	// ── Identifiers / GUIDs ─────────────────────────────────────────

	tmpSynth.guid = function ()
	{
		return chanceFor(pFable).guid();
	};

	// ── Numerics ────────────────────────────────────────────────────
	//
	// These exist alongside fable's RANDOMINTEGER / RANDOMFLOATBETWEEN
	// (which use Math.random and are NOT deterministic). Specs that
	// want reproducibility use `synth_*`; specs that don't care can
	// keep using the built-ins. Naming is the user-facing distinction.

	tmpSynth.integer = function (pMin, pMax)
	{
		let tmpMin = parseInt(pMin, 10);
		let tmpMax = parseInt(pMax, 10);
		if (isNaN(tmpMin) || isNaN(tmpMax)) return 0;
		if (tmpMax < tmpMin) { let tmpSwap = tmpMin; tmpMin = tmpMax; tmpMax = tmpSwap; }
		return chanceFor(pFable).integer({ min: tmpMin, max: tmpMax });
	};
	tmpSynth.floating = function (pMin, pMax)
	{
		let tmpMin = parseFloat(pMin);
		let tmpMax = parseFloat(pMax);
		if (isNaN(tmpMin) || isNaN(tmpMax)) return 0;
		if (tmpMax < tmpMin) { let tmpSwap = tmpMin; tmpMin = tmpMax; tmpMax = tmpSwap; }
		// `fixed` controls decimal places — 4 gives reasonable currency-
		// adjacent precision. Spec authors who need 2-decimal currency
		// should wrap with ROUND() in the expression.
		return chanceFor(pFable).floating({ min: tmpMin, max: tmpMax, fixed: 4 });
	};

	// ── Pickers ─────────────────────────────────────────────────────
	//
	// Pipe-delimited values + weights because the ExpressionParser
	// passes positional args as scalars; arrays-as-args don't survive
	// the postfix conversion cleanly. Spec authors write
	// `synth_pickone('US|DE|JP')` — the wrapper splits and forwards.

	tmpSynth.pickone = function (pPipeValues)
	{
		let tmpValues = String(pPipeValues || '').split('|').map((s) => s.trim()).filter((s) => s.length > 0);
		if (tmpValues.length === 0) return '';
		return chanceFor(pFable).pickone(tmpValues);
	};
	tmpSynth.pickWeighted = function (pPipeValues, pPipeWeights)
	{
		let tmpValues = String(pPipeValues || '').split('|').map((s) => s.trim()).filter((s) => s.length > 0);
		let tmpWeights = String(pPipeWeights || '').split('|').map((s) => parseFloat(s.trim()) || 0);
		if (tmpValues.length === 0) return '';
		// Pad/trim weights to match values length so a user typo doesn't
		// blow up — short tail gets weight 1, extra tail is dropped.
		while (tmpWeights.length < tmpValues.length) tmpWeights.push(1);
		tmpWeights = tmpWeights.slice(0, tmpValues.length);
		return chanceFor(pFable).weighted(tmpValues, tmpWeights);
	};

	// ── Dates ───────────────────────────────────────────────────────

	tmpSynth.dateBetween = function (pMinISO, pMaxISO)
	{
		let tmpMin = new Date(pMinISO);
		let tmpMax = new Date(pMaxISO);
		if (isNaN(tmpMin.getTime()) || isNaN(tmpMax.getTime())) return null;
		let tmpDate = chanceFor(pFable).date({ min: tmpMin, max: tmpMax });
		// Return ISO 8601 — that's what meadow's DateTime columns expect
		// on the wire and what the typed-op pipeline's date-bucket
		// histogram reads.
		return tmpDate.toISOString();
	};
	tmpSynth.dateRecent = function (pDaysBack)
	{
		// Convenience: a date within the last N days. Common shape for
		// "recent activity" demo data.
		let tmpDays = parseInt(pDaysBack, 10) || 30;
		let tmpMax = new Date();
		let tmpMin = new Date(tmpMax.getTime() - tmpDays * 24 * 60 * 60 * 1000);
		return chanceFor(pFable).date({ min: tmpMin, max: tmpMax }).toISOString();
	};

	// ── Long text ───────────────────────────────────────────────────

	tmpSynth.sentence = function ()
	{
		return chanceFor(pFable).sentence({ words: chanceFor(pFable).integer({ min: 5, max: 12 }) });
	};
	tmpSynth.paragraph = function (pSentences)
	{
		let tmpN = parseInt(pSentences, 10) || 3;
		return chanceFor(pFable).paragraph({ sentences: tmpN });
	};

	// ── Cross-entity reference ──────────────────────────────────────
	//
	// The keystone primitive for relational synth data. Pick a
	// deterministic ID in [1..count] of a target entity. Same seed →
	// same FK every time, so child rows always land on a valid parent.

	tmpSynth.referenceTo = function (pTargetEntity, pTargetCount)
	{
		let tmpCount = parseInt(pTargetCount, 10);
		if (!tmpCount || tmpCount < 1) return 0;
		// Use chance's seeded integer rather than a manual hash so the
		// same per-cell seed produces the same FK as it would any other
		// `synth_integer(1, count)` call — composability across specs.
		return chanceFor(pFable).integer({ min: 1, max: tmpCount });
	};

	// ── Fault injection ─────────────────────────────────────────────
	//
	// Ternary-friendly: returns 1 with probability `pProbability`, else 0.
	// Spec usage: `synth_coinFlip(0.05) ? '' :: synth_email()` injects
	// 5% NULLs deterministically. Per-cell seed means the SAME records
	// across runs get the SAME nulls — repro-able pathological data.

	tmpSynth.coinFlip = function (pProbability)
	{
		let tmpP = parseFloat(pProbability);
		if (isNaN(tmpP)) tmpP = 0;
		if (tmpP <= 0) return 0;
		if (tmpP >= 1) return 1;
		return chanceFor(pFable).floating({ min: 0, max: 1 }) < tmpP ? 1 : 0;
	};

	return tmpSynth;
}

/**
 * Register all synth_* functions on the given fable's ExpressionParser.
 * Idempotent — calling twice is a no-op (fable's addSolverFunction
 * silently overwrites existing names, but we guard anyway).
 *
 * @param {object} pFable - The fable instance owning the parser.
 * @param {object} pParser - An instantiated ExpressionParser service.
 */
function registerSynthSolverFunctions(pFable, pParser)
{
	if (!pFable || !pParser || typeof pParser.addSolverFunction !== 'function')
	{
		throw new Error('SynthBeacon-SolverFunctions: requires (fable, ExpressionParser) — got fable=' + typeof pFable + ' parser=' + typeof pParser);
	}

	if (pFable.Synth && pFable.__SynthRegistered)
	{
		return pFable.Synth;
	}

	pFable.Synth = buildSynthFunctions(pFable);
	pFable.SynthContext = pFable.SynthContext || { seed: '', entity: '', recordIndex: 0 };

	let tmpRegistry =
	[
		// Strings
		[ 'synth_firstName',   'fable.Synth.firstName',    'Generate a deterministic first name (chance.js .first())' ],
		[ 'synth_lastName',    'fable.Synth.lastName',     'Generate a deterministic last name' ],
		[ 'synth_fullName',    'fable.Synth.fullName',     'Generate a deterministic full name' ],
		[ 'synth_email',       'fable.Synth.email',        'Deterministic email at example.com' ],
		[ 'synth_phone',       'fable.Synth.phone',        'Deterministic US phone number, formatted' ],
		[ 'synth_address',     'fable.Synth.address',      'Deterministic street address' ],
		[ 'synth_city',        'fable.Synth.city',         'Deterministic city name' ],
		[ 'synth_state',       'fable.Synth.state',        'Deterministic full state name' ],
		[ 'synth_stateCode',   'fable.Synth.stateCode',    'Deterministic 2-letter state code' ],
		[ 'synth_country',     'fable.Synth.country',      'Deterministic full country name' ],
		[ 'synth_countryCode', 'fable.Synth.countryCode',  'Deterministic ISO country code' ],
		[ 'synth_postalCode',  'fable.Synth.postalCode',   'Deterministic US ZIP' ],
		[ 'synth_company',     'fable.Synth.company',      'Deterministic company name (made-up word + suffix)' ],
		[ 'synth_profession',  'fable.Synth.profession',   'Deterministic profession label' ],
		[ 'synth_department',  'fable.Synth.department',   'Pick from a curated list of org-chart departments' ],

		// Identifiers
		[ 'synth_guid',        'fable.Synth.guid',         'Deterministic UUID v4' ],

		// Numerics (deterministic alternatives to fable RANDOM*)
		[ 'synth_integer',     'fable.Synth.integer',      'synth_integer(min, max) — seeded integer in [min..max]' ],
		[ 'synth_floating',    'fable.Synth.floating',     'synth_floating(min, max) — seeded float in [min..max], 4 decimals' ],

		// Pickers
		[ 'synth_pickone',     'fable.Synth.pickone',      'synth_pickone(\'a|b|c\') — uniform pick' ],
		[ 'synth_pickWeighted','fable.Synth.pickWeighted', 'synth_pickWeighted(\'a|b|c\', \'50|30|20\') — weighted pick' ],

		// Dates
		[ 'synth_dateBetween', 'fable.Synth.dateBetween',  'synth_dateBetween(\'YYYY-MM-DD\',\'YYYY-MM-DD\') — ISO date in range' ],
		[ 'synth_dateRecent',  'fable.Synth.dateRecent',   'synth_dateRecent(daysBack) — ISO date within last N days' ],

		// Text
		[ 'synth_sentence',    'fable.Synth.sentence',     'Deterministic 5–12 word sentence' ],
		[ 'synth_paragraph',   'fable.Synth.paragraph',    'synth_paragraph(sentences) — N-sentence paragraph' ],

		// Relational
		[ 'synth_referenceTo', 'fable.Synth.referenceTo',  'synth_referenceTo(targetEntity, targetCount) — deterministic FK in [1..count]' ],

		// Fault injection
		[ 'synth_coinFlip',    'fable.Synth.coinFlip',     'synth_coinFlip(probability) — returns 1 with prob p, else 0; pair with ternary for null-injection' ]
	];

	for (let i = 0; i < tmpRegistry.length; i++)
	{
		let tmpEntry = tmpRegistry[i];
		pParser.addSolverFunction(tmpEntry[0], tmpEntry[1], tmpEntry[2]);
	}

	pFable.__SynthRegistered = true;
	return pFable.Synth;
}

module.exports = {
	registerSynthSolverFunctions,
	buildSynthFunctions
};
