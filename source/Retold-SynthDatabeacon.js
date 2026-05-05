/**
 * Retold SynthDatabeacon
 *
 * On-demand synthetic record generator that mirrors meadow's REST surface.
 * Drop-in source for retold-data-mapper PullRecords — looks like a
 * real database from the outside, but the records are generated per
 * request from a declarative spec (deterministic per-cell seeding).
 *
 * Architecture:
 *   - SpecRegistry      — loads named *.json specs from disk
 *   - SolverFunctions   — registers synth_* functions on fable's parser
 *   - Evaluator         — drives the parser cell-by-cell with seed plumbing
 *   - RestServer        — meadow-shape /1.0/:spec/:entity* routes + /synth/* discovery
 *   - BeaconProvider    — (added in a subsequent step) UV capability registration
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libPath = require('path');

const libOrator = require('orator');
const libOratorServiceServerRestify = require('orator-serviceserver-restify');

const libExpressionParser = require('fable/source/services/Fable-Service-ExpressionParser.js');

const libSolverFunctions = require('./services/SynthBeacon-SolverFunctions.js');
const libEvaluator = require('./services/SynthBeacon-Evaluator.js');
const libSpecRegistry = require('./services/SynthBeacon-SpecRegistry.js');
const libRestServer = require('./services/SynthBeacon-RestServer.js');
const libBeaconProvider = require('./services/SynthBeacon-BeaconProvider.js');

const defaultSynthDatabeaconSettings =
{
	AutoStartOrator: true,

	// Where *.json spec files live. Defaults to the bundled `source/specs/`.
	SpecDirectory: libPath.join(__dirname, 'specs'),

	// Optional inline specs registered after directory load. Useful for tests.
	InlineSpecs: [],

	Endpoints:
	{
		RestServer: true,
		BeaconProvider: true
	},

	SynthDatabeacon:
	{
		RoutePrefix: '/synth'
	}
};

class RetoldSynthDatabeacon extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		let tmpOptions = Object.assign({}, JSON.parse(JSON.stringify(defaultSynthDatabeaconSettings)), pOptions);
		super(pFable, tmpOptions, pServiceHash);
		this.serviceType = 'RetoldSynthDatabeacon';

		// Re-apply the defaults after super() (super may have munged them).
		this.options = Object.assign({}, JSON.parse(JSON.stringify(defaultSynthDatabeaconSettings)), this.options);

		// Orator stack (HTTP server)
		this.fable.serviceManager.addServiceType('OratorServiceServer', libOratorServiceServerRestify);
		this.fable.serviceManager.addServiceType('Orator', libOrator);
		this.fable.serviceManager.instantiateServiceProvider('OratorServiceServer', this.options);
		this.fable.serviceManager.instantiateServiceProvider('Orator', this.options);

		// ExpressionParser is the engine that evaluates spec expressions.
		this.fable.serviceManager.addServiceTypeIfNotExists('ExpressionParser', libExpressionParser);
		this.fable.serviceManager.instantiateServiceProviderIfNotExists('ExpressionParser');

		// Register synth_* functions on the parser.
		libSolverFunctions.registerSynthSolverFunctions(this.fable, this.fable.ExpressionParser);

		// Spec registry + evaluator. These are plain (non-orator) services
		// used by the REST handlers.
		this.fable.SynthBeaconSpecRegistry = new libSpecRegistry(this.fable);
		this.fable.SynthBeaconEvaluator = new libEvaluator(this.fable);

		// Sub-services
		this.fable.serviceManager.addServiceType('SynthBeaconRestServer', libRestServer);
		this.fable.serviceManager.instantiateServiceProvider('SynthBeaconRestServer', { RoutePrefix: this.options.SynthDatabeacon.RoutePrefix });

		this.fable.serviceManager.addServiceType('SynthBeaconBeaconProvider', libBeaconProvider);
		this.fable.serviceManager.instantiateServiceProvider('SynthBeaconBeaconProvider', { RoutePrefix: this.options.SynthDatabeacon.RoutePrefix });

		this.serviceInitialized = false;
	}

	isEndpointGroupEnabled(pName)
	{
		if (!this.options.Endpoints) return false;
		if (!this.options.Endpoints.hasOwnProperty(pName)) return false;
		return !!this.options.Endpoints[pName];
	}

	initializeService(fCallback)
	{
		if (this.serviceInitialized)
		{
			return fCallback(new Error('RetoldSynthDatabeacon already initialized'));
		}

		let tmpAnticipate = this.fable.newAnticipate();

		this.fable.log.info('Retold SynthDatabeacon initializing...');

		// Start Orator
		tmpAnticipate.anticipate((fInit) =>
		{
			if (this.options.AutoStartOrator)
			{
				this.fable.Orator.startWebServer(fInit);
			}
			else
			{
				return fInit();
			}
		});

		// Body + query parsing
		tmpAnticipate.anticipate((fInit) =>
		{
			this.fable.OratorServiceServer.server.use(this.fable.OratorServiceServer.bodyParser());
			this.fable.OratorServiceServer.server.use(require('restify').plugins.queryParser());
			return fInit();
		});

		// Load specs from disk
		tmpAnticipate.anticipate((fInit) =>
		{
			let tmpRegistered = this.fable.SynthBeaconSpecRegistry.loadSpecsFromDirectory(this.options.SpecDirectory);
			this.fable.log.info(`SynthDatabeacon: loaded ${tmpRegistered.length} spec(s) from ${this.options.SpecDirectory}: [${tmpRegistered.join(', ')}]`);
			return fInit();
		});

		// Register inline specs (test/operator-supplied)
		tmpAnticipate.anticipate((fInit) =>
		{
			let tmpInline = Array.isArray(this.options.InlineSpecs) ? this.options.InlineSpecs : [];
			for (let i = 0; i < tmpInline.length; i++)
			{
				try
				{
					this.fable.SynthBeaconSpecRegistry.registerSpec(tmpInline[i]);
				}
				catch (pErr)
				{
					this.fable.log.warn(`SynthDatabeacon: inline spec #${i} rejected: ${pErr.message || pErr}`);
				}
			}
			return fInit();
		});

		// Wire REST routes
		tmpAnticipate.anticipate((fInit) =>
		{
			if (this.isEndpointGroupEnabled('RestServer'))
			{
				this.fable.SynthBeaconRestServer.connectRoutes(this.fable.OratorServiceServer);
			}
			return fInit();
		});

		tmpAnticipate.wait((pError) =>
		{
			if (pError)
			{
				this.log.error(`SynthDatabeacon initialization error: ${pError}`);
				return fCallback(pError);
			}
			this.serviceInitialized = true;
			return fCallback();
		});
	}

	stopService(fCallback)
	{
		if (!this.serviceInitialized)
		{
			return fCallback(new Error('RetoldSynthDatabeacon is not initialized'));
		}
		this.fable.log.info('Retold SynthDatabeacon stopping Orator');
		this.fable.Orator.stopWebServer((pError) =>
		{
			if (pError)
			{
				this.log.error(`SynthDatabeacon stop error: ${pError}`);
				return fCallback(pError);
			}
			this.serviceInitialized = false;
			return fCallback();
		});
	}
}

module.exports = RetoldSynthDatabeacon;
