#!/usr/bin/env node
/**
 * Retold SynthDatabeacon — CLI Entry Point
 *
 * On-demand synthetic record generator. Serves a meadow-shape paginated
 * REST surface (drop-in source for retold-data-mapper PullRecords) backed
 * by declarative specs in `source/specs/*.json`.
 *
 * Configuration precedence (highest first):
 *   1. CLI flags          (e.g. `--port 9000`)
 *   2. SYNTHBEACON_* env vars
 *   3. Built-in defaults
 *
 * @author Steven Velozo <steven@velozo.com>
 */
// Plain fable (not pict) — we only need the service-provider container,
// no Pict view/app lifecycle. Saves ~30 MB of runtime image weight.
const libFable = require('fable');
const libRetoldSynthDatabeacon = require('../source/Retold-SynthDatabeacon.js');

const libFs = require('fs');
const libPath = require('path');

function _envOrFile(pVarName)
{
	let tmpValue = process.env[pVarName];
	if (tmpValue !== undefined && tmpValue !== '') return tmpValue;
	let tmpFilePath = process.env[pVarName + '_FILE'];
	if (tmpFilePath)
	{
		try
		{
			return libFs.readFileSync(tmpFilePath, 'utf8').replace(/\s+$/, '');
		}
		catch (pErr)
		{
			console.warn(`Retold SynthDatabeacon: ${pVarName}_FILE set to ${tmpFilePath} but file is unreadable: ${pErr.message}`);
		}
	}
	return undefined;
}

let _CLIPort = null;
let _CLISpecDir = null;
let _CLILogPath = null;

let tmpEnvPort = _envOrFile('SYNTHBEACON_PORT');
if (tmpEnvPort) _CLIPort = parseInt(tmpEnvPort, 10);
let tmpEnvSpecDir = _envOrFile('SYNTHBEACON_SPEC_DIR');
if (tmpEnvSpecDir) _CLISpecDir = libPath.resolve(tmpEnvSpecDir);
let tmpEnvLogPath = _envOrFile('SYNTHBEACON_LOG_PATH');
if (tmpEnvLogPath) _CLILogPath = libPath.resolve(tmpEnvLogPath);

let tmpArgs = process.argv.slice(2);
for (let i = 0; i < tmpArgs.length; i++)
{
	let tmpArg = tmpArgs[i];
	if (tmpArg === '--port' || tmpArg === '-p')
	{
		if (tmpArgs[i + 1]) { _CLIPort = parseInt(tmpArgs[i + 1], 10); i++; }
	}
	else if (tmpArg === '--spec-dir' || tmpArg === '-s')
	{
		if (tmpArgs[i + 1]) { _CLISpecDir = libPath.resolve(tmpArgs[i + 1]); i++; }
	}
	else if (tmpArg === '--log' || tmpArg === '-l')
	{
		if (tmpArgs[i + 1] && !tmpArgs[i + 1].startsWith('-'))
		{
			_CLILogPath = libPath.resolve(tmpArgs[i + 1]); i++;
		}
		else
		{
			_CLILogPath = `${process.cwd()}/SynthDatabeacon-Run-${Date.now()}.log`;
		}
	}
	else if (tmpArg === '--help' || tmpArg === '-h')
	{
		console.log(`
Retold SynthDatabeacon — Synthetic Record Generator

Usage:
  retold-synth-databeacon [options]

Options:
  --port, -p <port>      API server port (default: 8390)
  --spec-dir, -s <path>  Directory of *.json spec files
                         (default: <bundled source/specs>)
  --log, -l [path]       Write log output to a file
  --help, -h             Show this help

Environment variables (CLI flags take precedence):
  SYNTHBEACON_PORT             Same as --port
  SYNTHBEACON_SPEC_DIR         Same as --spec-dir
  SYNTHBEACON_LOG_PATH         Same as --log

  SYNTHBEACON_ULTRAVISOR_URL   If set, auto-connect to this Ultravisor on startup
  SYNTHBEACON_BEACON_NAME      Beacon name to register with (default: retold-synth-databeacon)
  SYNTHBEACON_BEACON_PASSWORD  Auth password for the beacon connection
  SYNTHBEACON_MAX_CONCURRENT   Max concurrent work items (default: 3)

  *_FILE suffix on any secret-bearing var sources its value from a file path
  (mysql/postgres image convention; works with Docker secrets / k8s Secret mounts).

Endpoints (when running):
  /synth/health                                       — liveness
  /synth/specs                                        — list registered specs
  /synth/specs/:specName                              — one spec's metadata
  /synth/specs/:specName/entity/:entityName           — entity definition
  /1.0/:specName/:entityPlural                        — meadow-shape default page
  /1.0/:specName/:entityPlural/Count                  — meadow-shape row count
  /1.0/:specName/:entityPlural/:offset/:count         — meadow-shape paginated list
`);
		process.exit(0);
	}
}

let _Settings =
{
	Product: 'RetoldSynthDatabeacon',
	ProductVersion: '0.0.1',
	APIServerPort: _CLIPort || parseInt(process.env.PORT, 10) || 8390,
	LogStreams: [{ streamtype: 'console' }]
};

if (_CLILogPath)
{
	_Settings.LogStreams.push(
	{
		loggertype: 'simpleflatfile',
		outputloglinestoconsole: false,
		showtimestamps: true,
		formattedtimestamps: true,
		level: 'trace',
		path: _CLILogPath
	});
}

let _Fable = new libFable(_Settings);

_Fable.serviceManager.addServiceType('RetoldSynthDatabeacon', libRetoldSynthDatabeacon);
let tmpService = _Fable.serviceManager.instantiateServiceProvider('RetoldSynthDatabeacon',
{
	SpecDirectory: _CLISpecDir || libPath.join(__dirname, '..', 'source', 'specs'),
	Endpoints: { RestServer: true, BeaconProvider: false }
});

tmpService.initializeService((pInitError) =>
{
	if (pInitError)
	{
		_Fable.log.error(`Initialization error: ${pInitError}`);
		process.exit(1);
	}
	_Fable.log.info(`Retold SynthDatabeacon running on port ${_Settings.APIServerPort}`);
	_Fable.log.info(`Discovery: http://localhost:${_Settings.APIServerPort}/synth/specs`);
	_Fable.log.info(`Health:    http://localhost:${_Settings.APIServerPort}/synth/health`);

	// Optional UV auto-connect. Mirrors retold-databeacon's pattern so a
	// docker-compose stack can wire SYNTHBEACON_ULTRAVISOR_URL and have
	// the beacon register itself on startup with no extra orchestration.
	let tmpUVUrl = _envOrFile('SYNTHBEACON_ULTRAVISOR_URL');
	if (tmpUVUrl)
	{
		let tmpBeaconConfig =
		{
			ServerURL:     tmpUVUrl,
			Name:          _envOrFile('SYNTHBEACON_BEACON_NAME') || 'retold-synth-databeacon',
			Password:      _envOrFile('SYNTHBEACON_BEACON_PASSWORD') || '',
			MaxConcurrent: parseInt(_envOrFile('SYNTHBEACON_MAX_CONCURRENT') || '3', 10),
			AllowWrites:   false
		};
		_Fable.log.info(`Auto-connecting to Ultravisor at ${tmpUVUrl} as "${tmpBeaconConfig.Name}"...`);
		_Fable.SynthBeaconBeaconProvider.connectBeacon(tmpBeaconConfig, (pConnectError) =>
		{
			if (pConnectError)
			{
				_Fable.log.error(`Ultravisor auto-connect failed: ${pConnectError.message || pConnectError}`);
				return;
			}
			_Fable.log.info(`Ultravisor auto-connect succeeded — registered as "${tmpBeaconConfig.Name}".`);
		});
	}
});
