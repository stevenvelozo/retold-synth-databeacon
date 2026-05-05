/**
 * SynthBeacon — Evaluator
 *
 * Generates synthetic records from a declarative spec by driving fable's
 * ExpressionParser one cell at a time, with a fresh per-cell seed each
 * call. Specs look like:
 *
 *   {
 *     "Entity":     "Customer",
 *     "Count":      1000,
 *     "GlobalSeed": "industrial-supply-v1",   // optional override
 *     "Fields":
 *     [
 *       { "Column": "IDCustomer", "Expression": "RecordIndex + 1" },
 *       { "Column": "GUIDCustomer", "Expression": "synth_guid()" },
 *       { "Column": "Name",       "Expression": "synth_fullName()" },
 *       { "Column": "Email",      "Expression": "synth_coinFlip(0.05) ? \"\" :: synth_email()" },
 *       { "Column": "City",       "Expression": "synth_city()" },
 *       { "Column": "IDCompany",  "Expression": "synth_referenceTo(\"Company\", 50)" }
 *     ]
 *   }
 *
 * Always use **double-quoted** string literals inside expressions. Single
 * quotes are tokenized as math (`'2020-01-01'` becomes the number `-1`)
 * and won't survive the parser. See SynthBeacon-SolverFunctions.js header
 * for the full rationale.
 *
 * Per-cell seeding
 * ----------------
 * Before each `parser.solve(...)` call the Evaluator sets:
 *
 *   fable.SynthContext.seed = sha1(globalSeed || entity || recordIndex || column)
 *
 * Each `synth_*` solver function reads this seed and instantiates a fresh
 * `Chance(seed)`. Two consequences:
 *
 *   1. Editing one column's expression only shifts that column's output —
 *      every other column on every other row stays bit-stable.
 *   2. Fault-injection ternaries (`synth_coinFlip(0.05) ? '' :: synth_email()`)
 *      pin the *same* records to NULL on every run — repro-able pathological
 *      data sets for typed-op edge-case testing.
 *
 * Field resolution proceeds top-to-bottom and each completed field is added
 * to the row's data source object before the next field is solved. That
 * means later fields can reference earlier fields by name, e.g.:
 *
 *   { "Column": "FirstName", "Expression": "synth_firstName()" },
 *   { "Column": "LastName",  "Expression": "synth_lastName()" },
 *   { "Column": "FullName",  "Expression": "FirstName + ' ' + LastName" }
 *
 * Pagination
 * ----------
 * `generateRange(spec, globalSeed, beginIndex, count)` produces a slice
 * starting at `beginIndex` (0-based, inclusive) for `count` rows, capped at
 * `spec.Count`. Determinism holds across pages — page 0 of (begin=0,
 * count=100) returns the same records as page 1 of (begin=100, count=100)
 * relative to row 100, etc.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
const libCrypto = require('crypto');

/**
 * Hash one cell's coordinates into a stable 40-char hex seed string.
 * Parts are joined with `||` so unlikely collisions (e.g. an entity named
 * `X|0|Y` colliding with `X` row 0 col `Y`) are essentially impossible.
 *
 * @param {string} pGlobalSeed
 * @param {string} pEntity
 * @param {number} pRecordIndex
 * @param {string} pColumn
 * @returns {string} sha1 hex digest
 */
function _cellSeed(pGlobalSeed, pEntity, pRecordIndex, pColumn)
{
	let tmpInput = String(pGlobalSeed) + '||' + String(pEntity) + '||' + String(pRecordIndex) + '||' + String(pColumn);
	return libCrypto.createHash('sha1').update(tmpInput).digest('hex');
}

/**
 * Validate a spec object has the minimum shape we need. Throw with a clear
 * message — the REST layer turns these into 400s so spec authors get
 * actionable feedback.
 */
function _validateSpec(pSpec)
{
	if (!pSpec || typeof pSpec !== 'object')
	{
		throw new Error('SynthBeacon-Evaluator: spec must be an object');
	}
	if (!pSpec.Entity || typeof pSpec.Entity !== 'string')
	{
		throw new Error('SynthBeacon-Evaluator: spec.Entity (string) is required');
	}
	if (!Array.isArray(pSpec.Fields) || pSpec.Fields.length < 1)
	{
		throw new Error('SynthBeacon-Evaluator: spec.Fields (non-empty array) is required');
	}
	let tmpCount = parseInt(pSpec.Count, 10);
	if (isNaN(tmpCount) || tmpCount < 0)
	{
		throw new Error('SynthBeacon-Evaluator: spec.Count must be a non-negative integer');
	}
	for (let i = 0; i < pSpec.Fields.length; i++)
	{
		let tmpField = pSpec.Fields[i];
		if (!tmpField || typeof tmpField.Column !== 'string' || tmpField.Column.length < 1)
		{
			throw new Error('SynthBeacon-Evaluator: spec.Fields[' + i + '].Column (string) is required');
		}
		if (typeof tmpField.Expression !== 'string')
		{
			throw new Error('SynthBeacon-Evaluator: spec.Fields[' + i + '].Expression (string) is required');
		}
	}
}

class SynthBeaconEvaluator
{
	/**
	 * @param {object} pFable - the fable instance (must have ExpressionParser registered + synth_* functions wired in)
	 */
	constructor(pFable)
	{
		this.fable = pFable;

		if (!pFable || !pFable.ExpressionParser || typeof pFable.ExpressionParser.solve !== 'function')
		{
			throw new Error('SynthBeacon-Evaluator: fable.ExpressionParser is not initialized');
		}

		// Initialize the synth context if no one else has yet. SolverFunctions'
		// register call also does this defensively; the duplication is cheap
		// and keeps the Evaluator usable even if a downstream caller wires
		// only the Evaluator without the SolverFunctions module.
		this.fable.SynthContext = this.fable.SynthContext || { seed: '', entity: '', recordIndex: 0 };
	}

	/**
	 * Generate the full record set defined by the spec.
	 *
	 * @param {object} pSpec - the synth spec (Entity, Count, Fields[])
	 * @param {string} [pGlobalSeed] - override for the spec's GlobalSeed (or default if neither set)
	 * @returns {Array<object>} array of generated records
	 */
	generate(pSpec, pGlobalSeed)
	{
		_validateSpec(pSpec);
		let tmpCount = parseInt(pSpec.Count, 10) || 0;
		return this.generateRange(pSpec, pGlobalSeed, 0, tmpCount);
	}

	/**
	 * Generate a paginated slice of the spec's records.
	 *
	 * Begin/count are clamped against spec.Count so a caller asking for
	 * (begin=950, count=100) on a 1000-row spec gets the last 50 rows
	 * rather than an error.
	 *
	 * @param {object} pSpec
	 * @param {string} [pGlobalSeed]
	 * @param {number} pBeginIndex - 0-based inclusive start
	 * @param {number} pCount - max rows to return
	 * @returns {Array<object>}
	 */
	generateRange(pSpec, pGlobalSeed, pBeginIndex, pCount)
	{
		_validateSpec(pSpec);

		let tmpSpecCount = parseInt(pSpec.Count, 10) || 0;
		let tmpBegin = Math.max(0, parseInt(pBeginIndex, 10) || 0);
		let tmpRequest = Math.max(0, parseInt(pCount, 10) || 0);
		let tmpEnd = Math.min(tmpSpecCount, tmpBegin + tmpRequest);

		// Effective globalSeed precedence:
		//   explicit arg > spec.GlobalSeed > spec.Entity > 'default'
		// Falling back to the entity name still gives stable output without
		// the operator having to remember to set a seed for casual/demo
		// usage; same spec on two different machines still matches.
		let tmpGlobalSeed = (pGlobalSeed != null && pGlobalSeed !== '') ? String(pGlobalSeed)
			: (pSpec.GlobalSeed != null && pSpec.GlobalSeed !== '') ? String(pSpec.GlobalSeed)
			: String(pSpec.Entity || 'default');

		let tmpEntity = String(pSpec.Entity);
		let tmpFields = pSpec.Fields;
		let tmpRecords = [];

		// Snapshot/restore the SynthContext around the generation so that a
		// caller using ExpressionParser elsewhere in the same fable doesn't
		// see the synth context bleed into their solves. (Single-threaded
		// node; we don't need a deeper guard.)
		let tmpPrevContext = this.fable.SynthContext;
		this.fable.SynthContext =
		{
			seed: '',
			globalSeed: tmpGlobalSeed,
			entity: tmpEntity,
			recordIndex: 0
		};

		try
		{
			for (let tmpRowIndex = tmpBegin; tmpRowIndex < tmpEnd; tmpRowIndex++)
			{
				let tmpRecord = this._generateOneRecord(tmpGlobalSeed, tmpEntity, tmpRowIndex, tmpFields);
				tmpRecords.push(tmpRecord);
			}
		}
		finally
		{
			this.fable.SynthContext = tmpPrevContext;
		}

		return tmpRecords;
	}

	/**
	 * Build one record. The data source object accumulates field-by-field so
	 * later expressions can reference earlier columns by name.
	 */
	_generateOneRecord(pGlobalSeed, pEntity, pRecordIndex, pFields)
	{
		// Seed the data source with row metadata. These are reachable from
		// expressions as bare symbols (RecordIndex, Entity, GlobalSeed) for
		// specs that want stable IDs derived from row position.
		let tmpDataObject =
		{
			RecordIndex: pRecordIndex,
			Entity: pEntity,
			GlobalSeed: pGlobalSeed
		};

		this.fable.SynthContext.recordIndex = pRecordIndex;

		for (let i = 0; i < pFields.length; i++)
		{
			let tmpField = pFields[i];
			let tmpColumn = tmpField.Column;
			let tmpExpression = tmpField.Expression;

			// Per-cell seed. Mutate the existing context object instead of
			// reassigning so a synth_* function holding an early reference
			// still sees the new seed.
			this.fable.SynthContext.seed = _cellSeed(pGlobalSeed, pEntity, pRecordIndex, tmpColumn);

			// Empty / whitespace-only expression → empty-string column. This
			// is the most common shape for "passthrough" columns and keeps
			// specs from blowing up on a typo.
			if (!tmpExpression || !tmpExpression.trim())
			{
				tmpDataObject[tmpColumn] = '';
				continue;
			}

			// fable's ExpressionParser writes assignments into a destination
			// object via Manyfest hash addressing. We give it a fresh dest
			// object per cell so collisions across columns are impossible
			// even if a spec author accidentally writes `Result = ...`
			// expressions; we then read whichever assignment landed.
			let tmpResultObject = {};
			let tmpDestinationObject = {};
			let tmpExprToSolve = tmpExpression.trim();

			// Auto-prefix with `Result =` if the spec author didn't write an
			// assignment. This is the ergonomic shape we want — spec authors
			// shouldn't have to repeat `Result = ` on every field.
			if (!_hasAssignment(tmpExprToSolve))
			{
				tmpExprToSolve = 'Result = ' + tmpExprToSolve;
			}

			let tmpValue;
			try
			{
				this.fable.ExpressionParser.solve(tmpExprToSolve, tmpDataObject, tmpResultObject, undefined, tmpDestinationObject);

				// Pull the value out of wherever the assignment landed. If
				// the spec uses `Result = ...` (auto or explicit) we read
				// .Result; otherwise we read whatever the LHS was.
				tmpValue = _extractAssignedValue(tmpDestinationObject, tmpResultObject);
			}
			catch (pError)
			{
				// Don't kill the whole generation for one bad expression —
				// degrade to NULL and surface the error in a metadata
				// column so the operator can find it. The REST layer can
				// expose the error count back to callers via headers.
				if (this.fable && this.fable.log && typeof this.fable.log.warn === 'function')
				{
					this.fable.log.warn(`SynthBeacon-Evaluator: row ${pRecordIndex} column [${tmpColumn}] expression failed: ${pError.message || pError}`);
				}
				tmpValue = null;
			}

			tmpDataObject[tmpColumn] = tmpValue;
		}

		// Strip the row-metadata symbols before returning so the produced
		// record is exactly the spec's columns. Spec authors who actually
		// want RecordIndex on the wire can declare a column for it.
		delete tmpDataObject.RecordIndex;
		delete tmpDataObject.Entity;
		delete tmpDataObject.GlobalSeed;

		return tmpDataObject;
	}
}

/**
 * Detect a top-level `=` assignment. We can't just regex on `=` because
 * `==`, `>=`, `<=`, and `!=` would all false-positive. Cheap walk: count
 * one bare `=` not followed/preceded by another `=`/`<`/`>`/`!`.
 *
 * Conservative: when in doubt, assume no assignment (we'll auto-prefix).
 * That just means an explicit `Result = X` becomes `Result = Result = X`
 * which the parser would error on, so we want this detector to be reliable.
 */
function _hasAssignment(pExpression)
{
	for (let i = 0; i < pExpression.length; i++)
	{
		if (pExpression[i] !== '=') continue;
		let tmpPrev = (i > 0) ? pExpression[i - 1] : '';
		let tmpNext = (i < pExpression.length - 1) ? pExpression[i + 1] : '';
		// Skip comparison operators and double-equals.
		if (tmpPrev === '=' || tmpPrev === '<' || tmpPrev === '>' || tmpPrev === '!') continue;
		if (tmpNext === '=') continue;
		return true;
	}
	return false;
}

/**
 * Pull the assigned value out of the destination/results object. Order:
 *   1. destObj.Result    — the auto-prefix path uses this
 *   2. resultsObj.LastResult — fallback the parser populates internally
 *   3. first own key of destObj — handles user-explicit `Foo = ...`
 */
function _extractAssignedValue(pDestObj, pResultsObj)
{
	if (pDestObj && Object.prototype.hasOwnProperty.call(pDestObj, 'Result'))
	{
		return pDestObj.Result;
	}
	if (pDestObj)
	{
		let tmpKeys = Object.keys(pDestObj);
		if (tmpKeys.length > 0)
		{
			return pDestObj[tmpKeys[0]];
		}
	}
	if (pResultsObj && Object.prototype.hasOwnProperty.call(pResultsObj, 'LastResult'))
	{
		return pResultsObj.LastResult;
	}
	return null;
}

module.exports = SynthBeaconEvaluator;
module.exports._cellSeed = _cellSeed;
module.exports._hasAssignment = _hasAssignment;
