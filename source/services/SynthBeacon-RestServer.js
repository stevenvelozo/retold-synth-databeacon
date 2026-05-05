/**
 * SynthBeacon — Rest Server
 *
 * Wires HTTP routes that mimic meadow's standard endpoint shape, so the
 * retold-data-mapper PullRecords action (which speaks meadow REST via
 * MeadowProxy) can use a synth spec as a drop-in source.
 *
 * Meadow-shaped routes (consumed by PullRecords / generic meadow clients):
 *
 *   GET /1.0/:specName/:entityPlural                     - small default page
 *   GET /1.0/:specName/:entityPlural/Count               - row count
 *   GET /1.0/:specName/:entityPlural/:offset/:count      - paginated list
 *
 * Discovery routes (for the data-mapper UI / operators):
 *
 *   GET /synth/health                                    - liveness ping
 *   GET /synth/specs                                     - list all registered specs
 *   GET /synth/specs/:specName                           - one spec's metadata
 *   GET /synth/specs/:specName/entity/:entityName        - one entity's full definition
 *
 * Entity URL shape
 * ----------------
 * Meadow's standard route uses the trailing-s plural form for list
 * endpoints (`/Customers/0/100` for the entity `Customer`). On lookup we
 * strip a single trailing `s` first; if that doesn't resolve we try the
 * literal segment too (so an entity already ending in `s` like `Status`
 * still works).
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

class SynthBeaconRestServer extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'SynthBeaconRestServer';
	}

	connectRoutes(pOratorServiceServer)
	{
		let tmpServer = pOratorServiceServer.server || pOratorServiceServer;

		tmpServer.get('/synth/health', this._handleHealth.bind(this));
		tmpServer.get('/synth/specs', this._handleListSpecs.bind(this));
		tmpServer.get('/synth/specs/:specName', this._handleGetSpec.bind(this));
		tmpServer.get('/synth/specs/:specName/entity/:entityName', this._handleGetEntity.bind(this));

		// Meadow-shaped routes. Order matters: more-specific routes (Count,
		// offset/count) must be registered before the catch-all default.
		tmpServer.get('/1.0/:specName/:entityPlural/Count', this._handleCount.bind(this));
		tmpServer.get('/1.0/:specName/:entityPlural/:offset/:count', this._handlePaginatedList.bind(this));
		tmpServer.get('/1.0/:specName/:entityPlural', this._handleDefaultList.bind(this));

		this.fable.log.info('SynthBeacon-RestServer: routes connected (/synth/* discovery + /1.0/:spec/:entity* meadow-shape)');
	}

	// ── Discovery ────────────────────────────────────────────────────

	_handleHealth(pRequest, pResponse, fNext)
	{
		pResponse.send(200, { Status: 'OK', Service: 'retold-synth-databeacon' });
		return fNext();
	}

	_handleListSpecs(pRequest, pResponse, fNext)
	{
		let tmpRegistry = this.fable.SynthBeaconSpecRegistry;
		pResponse.send(200, tmpRegistry.listSpecs());
		return fNext();
	}

	_handleGetSpec(pRequest, pResponse, fNext)
	{
		let tmpSpec = this.fable.SynthBeaconSpecRegistry.getSpec(pRequest.params.specName);
		if (!tmpSpec)
		{
			pResponse.send(404, { Error: 'Spec not found: ' + pRequest.params.specName });
			return fNext();
		}
		// Strip the internal _EntityIndex (private to the registry) before
		// serializing — operators don't need to see it and it bloats the
		// payload.
		let tmpClone = JSON.parse(JSON.stringify(tmpSpec));
		delete tmpClone._EntityIndex;
		pResponse.send(200, tmpClone);
		return fNext();
	}

	_handleGetEntity(pRequest, pResponse, fNext)
	{
		let tmpEntity = this._lookupEntity(pRequest.params.specName, pRequest.params.entityName);
		if (!tmpEntity)
		{
			pResponse.send(404, { Error: 'Entity [' + pRequest.params.entityName + '] not found in spec [' + pRequest.params.specName + ']' });
			return fNext();
		}
		pResponse.send(200, tmpEntity);
		return fNext();
	}

	// ── Meadow-shaped data routes ────────────────────────────────────

	_handleCount(pRequest, pResponse, fNext)
	{
		let tmpEntity = this._lookupEntity(pRequest.params.specName, pRequest.params.entityPlural);
		if (!tmpEntity)
		{
			pResponse.send(404, { Error: 'Entity not found: ' + pRequest.params.entityPlural + ' in spec ' + pRequest.params.specName });
			return fNext();
		}
		// Meadow's /Count returns a bare integer, not an object — match it.
		pResponse.send(200, parseInt(tmpEntity.Count, 10) || 0);
		return fNext();
	}

	_handlePaginatedList(pRequest, pResponse, fNext)
	{
		let tmpEntity = this._lookupEntity(pRequest.params.specName, pRequest.params.entityPlural);
		if (!tmpEntity)
		{
			pResponse.send(404, { Error: 'Entity not found: ' + pRequest.params.entityPlural + ' in spec ' + pRequest.params.specName });
			return fNext();
		}

		let tmpOffset = parseInt(pRequest.params.offset, 10);
		let tmpCount = parseInt(pRequest.params.count, 10);
		if (isNaN(tmpOffset) || tmpOffset < 0) tmpOffset = 0;
		if (isNaN(tmpCount) || tmpCount < 0) tmpCount = 0;

		this._generateAndSend(tmpEntity, tmpOffset, tmpCount, pResponse, fNext);
	}

	/**
	 * Default list — meadow returns the first page (default 100 rows). The
	 * data-mapper rarely hits this; PullRecords always passes explicit
	 * offset/count. Kept for parity so direct curl-based exploration works.
	 */
	_handleDefaultList(pRequest, pResponse, fNext)
	{
		let tmpEntity = this._lookupEntity(pRequest.params.specName, pRequest.params.entityPlural);
		if (!tmpEntity)
		{
			pResponse.send(404, { Error: 'Entity not found: ' + pRequest.params.entityPlural + ' in spec ' + pRequest.params.specName });
			return fNext();
		}
		this._generateAndSend(tmpEntity, 0, Math.min(100, tmpEntity.Count || 100), pResponse, fNext);
	}

	// ── Helpers ──────────────────────────────────────────────────────

	/**
	 * Resolve a URL entity segment back to a spec entity. Tries:
	 *   1. exact name match (handles already-pluralized entity names like Status)
	 *   2. trailing-s strip (the meadow plural convention: Customers → Customer)
	 */
	_lookupEntity(pSpecName, pEntityRouteName)
	{
		let tmpRegistry = this.fable.SynthBeaconSpecRegistry;
		if (!tmpRegistry || !tmpRegistry.hasSpec(pSpecName))
		{
			return null;
		}

		let tmpEntity = tmpRegistry.getEntity(pSpecName, pEntityRouteName);
		if (tmpEntity)
		{
			return tmpEntity;
		}

		if (pEntityRouteName.length > 1 && pEntityRouteName.endsWith('s'))
		{
			let tmpSingular = pEntityRouteName.slice(0, -1);
			tmpEntity = tmpRegistry.getEntity(pSpecName, tmpSingular);
			if (tmpEntity)
			{
				return tmpEntity;
			}
		}

		return null;
	}

	/**
	 * Synchronously generate the requested slice and ship it as JSON.
	 * Generation is CPU-bound and cooperates poorly with the event loop
	 * for huge slices (10K+); the BeaconProvider path that runs through
	 * UV's worker model is the right venue for those.
	 */
	_generateAndSend(pEntitySpec, pOffset, pCount, pResponse, fNext)
	{
		try
		{
			let tmpEvaluator = this.fable.SynthBeaconEvaluator;
			let tmpRecords = tmpEvaluator.generateRange(pEntitySpec, pEntitySpec.GlobalSeed, pOffset, pCount);
			pResponse.send(200, tmpRecords);
			return fNext();
		}
		catch (pError)
		{
			this.fable.log.error(`SynthBeacon-RestServer: generation failed for ${pEntitySpec.Entity}: ${pError.message || pError}`);
			pResponse.send(500, { Error: pError.message || String(pError) });
			return fNext();
		}
	}
}

module.exports = SynthBeaconRestServer;
