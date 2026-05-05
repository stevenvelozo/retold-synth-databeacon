/**
 * SynthBeacon — Meadow Proxy Provider
 *
 * Registers a MeadowProxy beacon capability on the synth beacon. The single
 * `Request` action receives an HTTP request descriptor (Method, Path, Body)
 * from the ultravisor mesh and proxies it to the synth beacon's own
 * localhost REST server. This makes the entire meadow-shape /1.0/* surface
 * (paginated GETs, /Count) reachable through the mesh — and crucially,
 * lets retold-data-mapper's PullRecords use a synth spec as a data source
 * with zero code changes (PullRecords already speaks MeadowProxy).
 *
 * Surface parity with retold-databeacon's MeadowProxy is intentional. UV
 * routes work items by capability name; sharing the name means any
 * consumer that already targets MeadowProxy works against this beacon too.
 *
 * Safety:
 *   - Path is allowlist-gated. /1.0/<spec>/<entity>* by default — synth
 *     itself has no other surface worth proxying.
 *   - Writes are disabled by default — the synth beacon is read-only by
 *     nature; flip AllowWrites only if you bolt an actual write surface
 *     on later.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
const libHTTP = require('http');

// Default allowlist matches the meadow-shape surface the RestServer wires:
// /1.0/<specName>/<entityPlural>... — the spec name is the "connection
// hash" segment that PullRecords' compiled URL fills in.
const DEFAULT_PATH_ALLOWLIST = [/^\/?1\.0\/[a-z0-9][a-z0-9._-]{0,127}\//];

const DEFAULT_OPTIONS =
{
	PathAllowlist: null,        // falls back to DEFAULT_PATH_ALLOWLIST
	AllowWrites: false,         // synth is read-only by default
	InternalHeaderName: 'X-SynthBeacon-MeadowProxy',
	InternalHeaderValue: '1'
};

const compilePathAllowlist = function (pPatterns)
{
	let tmpList = pPatterns || DEFAULT_PATH_ALLOWLIST;
	let tmpCompiled = [];
	for (let i = 0; i < tmpList.length; i++)
	{
		let tmpItem = tmpList[i];
		if (tmpItem instanceof RegExp)
		{
			tmpCompiled.push(tmpItem);
		}
		else if (typeof tmpItem === 'string')
		{
			tmpCompiled.push(new RegExp(tmpItem));
		}
	}
	return tmpCompiled;
};

const isPathAllowed = function (pPath, pCompiledAllowlist)
{
	if (typeof pPath !== 'string' || pPath.length === 0) return false;
	for (let i = 0; i < pCompiledAllowlist.length; i++)
	{
		if (pCompiledAllowlist[i].test(pPath)) return true;
	}
	return false;
};

const loopbackRequest = function (pOptions, fCallback)
{
	let tmpFired = false;
	let tmpComplete = (pError, pResult) =>
	{
		if (tmpFired) return;
		tmpFired = true;
		return fCallback(pError, pResult);
	};

	let tmpBody = (typeof pOptions.body === 'string') ? pOptions.body : '';
	let tmpHeaders = Object.assign({}, pOptions.headers || {},
	{
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(tmpBody)
	});

	let tmpReq = libHTTP.request(
	{
		hostname: pOptions.hostname || '127.0.0.1',
		port: pOptions.port,
		path: pOptions.path,
		method: pOptions.method || 'GET',
		headers: tmpHeaders
	},
	(pResponse) =>
	{
		let tmpData = '';
		pResponse.on('data', (pChunk) => { tmpData += pChunk; });
		pResponse.on('end', () =>
		{
			return tmpComplete(null,
			{
				Status: pResponse.statusCode,
				Headers: pResponse.headers,
				Body: tmpData
			});
		});
		pResponse.on('error', tmpComplete);
	});

	tmpReq.on('error', tmpComplete);
	if (tmpBody.length > 0) tmpReq.write(tmpBody);
	tmpReq.end();
};

let _ActiveConfig = null;

const registerMeadowProxyCapability = function (pBeaconService, pFable, pOptions)
{
	let tmpOptions = Object.assign({}, DEFAULT_OPTIONS, pOptions || {});
	let tmpRuntime =
	{
		compiledAllowlist: compilePathAllowlist(tmpOptions.PathAllowlist),
		allowWrites: tmpOptions.AllowWrites
	};
	_ActiveConfig = tmpRuntime;
	let tmpLog = pFable.log;

	pBeaconService.registerCapability(
	{
		Capability: 'MeadowProxy',
		Name: 'SynthBeaconMeadowProxyProvider',
		actions:
		{
			'Request':
			{
				Description: 'Proxy an HTTP request to the synth beacon\'s localhost REST API',
				SettingsSchema:
				[
					{ Name: 'Method',     DataType: 'String', Required: true },
					{ Name: 'Path',       DataType: 'String', Required: true },
					{ Name: 'Body',       DataType: 'String', Required: false },
					{ Name: 'RemoteUser', DataType: 'String', Required: false }
				],
				Handler: function (pWorkItem, pContext, fCallback)
				{
					let tmpStart = Date.now();
					let tmpSettings = pWorkItem.Settings || {};
					let tmpMethod = (typeof tmpSettings.Method === 'string') ? tmpSettings.Method.toUpperCase() : '';
					let tmpPath = tmpSettings.Path || '';
					let tmpRawBody = (typeof tmpSettings.Body === 'string') ? tmpSettings.Body : '';
					let tmpRemoteUser = tmpSettings.RemoteUser || 'anonymous';

					if (!tmpMethod)
					{
						return fCallback(new Error('MeadowProxy: Method is required.'));
					}
					if (!tmpRuntime.allowWrites && tmpMethod !== 'GET' && tmpMethod !== 'HEAD')
					{
						if (tmpLog) tmpLog.warn(`SynthBeacon-MeadowProxy: rejected ${tmpMethod} ${tmpPath} (writes disabled)`);
						return fCallback(new Error('MeadowProxy: writes are disabled on this beacon.'));
					}
					if (!isPathAllowed(tmpPath, tmpRuntime.compiledAllowlist))
					{
						if (tmpLog) tmpLog.warn(`SynthBeacon-MeadowProxy: rejected ${tmpMethod} ${tmpPath} (not allowlisted)`);
						return fCallback(new Error('MeadowProxy: path is not in the allowlist.'));
					}

					let tmpPort = (pFable.settings && pFable.settings.APIServerPort) || 8390;
					let tmpHostname = (pFable.settings && pFable.settings.APIServerAddress) || '127.0.0.1';
					let tmpRequestPath = (tmpPath.charAt(0) === '/') ? tmpPath : ('/' + tmpPath);

					let tmpHeaders = {};
					tmpHeaders[tmpOptions.InternalHeaderName] = tmpOptions.InternalHeaderValue;
					tmpHeaders['X-Beacon-User'] = tmpRemoteUser;

					loopbackRequest(
					{
						hostname: tmpHostname,
						port: tmpPort,
						path: tmpRequestPath,
						method: tmpMethod,
						headers: tmpHeaders,
						body: tmpRawBody
					},
					(pError, pResult) =>
					{
						let tmpElapsed = Date.now() - tmpStart;
						if (pError)
						{
							if (tmpLog) tmpLog.warn(`SynthBeacon-MeadowProxy: ${tmpMethod} ${tmpPath} failed after ${tmpElapsed}ms — ${pError.message}`);
							return fCallback(pError);
						}
						if (tmpLog) tmpLog.info(`SynthBeacon-MeadowProxy: ${tmpMethod} ${tmpPath} status=${pResult.Status} elapsed=${tmpElapsed}ms user=${tmpRemoteUser}`);
						return fCallback(null,
						{
							Outputs:
							{
								Status: pResult.Status,
								Body: pResult.Body
							},
							Log: []
						});
					});
				}
			}
		}
	});
};

const getActiveConfig = function ()
{
	if (!_ActiveConfig) return null;
	return {
		AllowWrites: _ActiveConfig.allowWrites,
		PathAllowlist: _ActiveConfig.compiledAllowlist.map((pR) => pR.source)
	};
};

const setAllowWrites = function (pAllow)
{
	if (!_ActiveConfig) return false;
	_ActiveConfig.allowWrites = !!pAllow;
	return _ActiveConfig.allowWrites;
};

const _resetActiveConfig = function ()
{
	_ActiveConfig = null;
};

module.exports =
{
	registerMeadowProxyCapability,
	getActiveConfig,
	setAllowWrites,
	DEFAULT_PATH_ALLOWLIST,
	DEFAULT_OPTIONS,
	_compilePathAllowlist: compilePathAllowlist,
	_isPathAllowed: isPathAllowed,
	_loopbackRequest: loopbackRequest,
	_resetActiveConfig
};
