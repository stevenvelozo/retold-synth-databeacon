/**
 * SynthBeacon — Beacon Provider
 *
 * Registers the synth beacon as a beacon in the Ultravisor mesh, exposing
 * the MeadowProxy capability so consumers (e.g. retold-data-mapper's
 * PullRecords) can read records over the mesh as if the synth beacon were
 * a real database.
 *
 * Capability surface (one):
 *   MeadowProxy — proxies HTTP /1.0/<spec>/<entity>* requests to the
 *                 local RestServer. Same shape retold-databeacon ships, so
 *                 PullRecords works against either source unchanged.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libMeadowProxy = require('./SynthBeacon-MeadowProxyProvider.js');

let libBeaconService = null;
try
{
	libBeaconService = require('ultravisor-beacon');
}
catch (pError)
{
	// ultravisor-beacon is optional at load time; the synth beacon still
	// works as a standalone REST surface without it.
}

const defaultBeaconProviderOptions =
{
	RoutePrefix: '/synth'
};

class SynthBeaconBeaconProvider extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		let tmpOptions = Object.assign({}, defaultBeaconProviderOptions, pOptions);
		super(pFable, tmpOptions, pServiceHash);
		this.serviceType = 'SynthBeaconBeaconProvider';
		this._BeaconService = null;
	}

	/**
	 * Connect to an Ultravisor coordinator as a beacon and register the
	 * MeadowProxy capability.
	 *
	 * @param {object} pConfig
	 *   - ServerURL    {string} required
	 *   - Name         {string} default 'retold-synth-databeacon'
	 *   - Password     {string} default ''
	 *   - MaxConcurrent {number} default 3
	 *   - Tags         {object} default {}
	 *   - AllowWrites  {boolean} default false (synth is read-only by nature)
	 * @param {Function} fCallback called with (pError)
	 */
	connectBeacon(pConfig, fCallback)
	{
		if (!libBeaconService)
		{
			return fCallback(new Error('ultravisor-beacon module is not installed.'));
		}
		if (!pConfig || !pConfig.ServerURL)
		{
			return fCallback(new Error('connectBeacon requires a ServerURL in the config.'));
		}
		if (this._BeaconService && this._BeaconService.isEnabled())
		{
			this.log.warn('SynthBeaconBeaconProvider: beacon already connected.');
			return fCallback(null);
		}

		this.fable.addServiceTypeIfNotExists('UltravisorBeacon', libBeaconService);
		this._BeaconService = this.fable.instantiateServiceProviderWithoutRegistration('UltravisorBeacon',
		{
			ServerURL: pConfig.ServerURL,
			Name: pConfig.Name || 'retold-synth-databeacon',
			Password: pConfig.Password || '',
			MaxConcurrent: pConfig.MaxConcurrent || 3,
			Tags: pConfig.Tags || {}
		});

		// Register MeadowProxy capability before enabling the beacon —
		// registerCapability mutates an internal capability map that the
		// beacon flushes to UV at enable time, so order matters.
		libMeadowProxy.registerMeadowProxyCapability(this._BeaconService, this.fable,
		{
			AllowWrites: !!pConfig.AllowWrites
		});

		this._BeaconService.enable((pErr) =>
		{
			if (pErr)
			{
				this.log.error(`SynthBeaconBeaconProvider: enable failed — ${pErr.message || pErr}`);
				return fCallback(pErr);
			}
			this.log.info(`SynthBeaconBeaconProvider: registered with UV at ${pConfig.ServerURL} as "${pConfig.Name || 'retold-synth-databeacon'}"`);
			return fCallback(null);
		});
	}

	disconnectBeacon(fCallback)
	{
		if (!this._BeaconService || !this._BeaconService.isEnabled())
		{
			return fCallback(null);
		}
		this._BeaconService.disable((pErr) =>
		{
			if (pErr)
			{
				this.log.warn(`SynthBeaconBeaconProvider: disable error — ${pErr.message || pErr}`);
			}
			return fCallback(pErr);
		});
	}
}

module.exports = SynthBeaconBeaconProvider;
