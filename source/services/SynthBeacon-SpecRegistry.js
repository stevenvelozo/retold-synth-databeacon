/**
 * SynthBeacon — Spec Registry
 *
 * In-memory store for named synthetic-data specs. Each spec file is a
 * multi-entity bundle:
 *
 *   {
 *     "Name":       "industrial-supply-v1",
 *     "GlobalSeed": "industrial-supply-v1",   // optional; defaults to Name
 *     "Description":"A 14-table industrial-supply demo dataset",
 *     "Entities":
 *     [
 *       { "Entity": "Company",  "Count": 50,   "Fields": [ ... ] },
 *       { "Entity": "Customer", "Count": 1000, "Fields": [ ... ] },
 *       ...
 *     ]
 *   }
 *
 * The registry exposes:
 *
 *   listSpecs()                    → [ { Name, Description, Entities[] } ]
 *   getSpec(specName)              → full spec object or null
 *   getEntity(specName, entity)    → { Entity, Count, Fields, GlobalSeed } or null
 *   listEntities(specName)         → [ { Entity, Count } ]
 *
 * Spec files are loaded from `source/specs/` at startup; the registry can
 * also be augmented at runtime via `registerSpec(obj)` for tests and
 * dynamically-uploaded specs.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */
const libFs = require('fs');
const libPath = require('path');

class SynthBeaconSpecRegistry
{
	constructor(pFable)
	{
		this.fable = pFable;

		// Internal store: { [specName]: { full spec obj } }
		this._specs = {};
	}

	/**
	 * Register one multi-entity spec object. Validates the shape and
	 * indexes its entities so getEntity() is O(1).
	 *
	 * @returns {string} the spec name that was registered
	 */
	registerSpec(pSpecObject)
	{
		if (!pSpecObject || typeof pSpecObject !== 'object')
		{
			throw new Error('SynthBeacon-SpecRegistry: spec must be an object');
		}
		if (!pSpecObject.Name || typeof pSpecObject.Name !== 'string')
		{
			throw new Error('SynthBeacon-SpecRegistry: spec.Name (string) is required');
		}
		if (!Array.isArray(pSpecObject.Entities) || pSpecObject.Entities.length < 1)
		{
			throw new Error('SynthBeacon-SpecRegistry: spec.Entities (non-empty array) is required for [' + pSpecObject.Name + ']');
		}

		// Build per-entity index inside a clone so callers can't mutate our
		// stored copy by holding a reference.
		let tmpClone = JSON.parse(JSON.stringify(pSpecObject));
		tmpClone._EntityIndex = {};

		for (let i = 0; i < tmpClone.Entities.length; i++)
		{
			let tmpEntity = tmpClone.Entities[i];
			if (!tmpEntity || typeof tmpEntity.Entity !== 'string')
			{
				throw new Error('SynthBeacon-SpecRegistry: entity #' + i + ' in spec [' + tmpClone.Name + '] missing .Entity name');
			}
			if (tmpClone._EntityIndex.hasOwnProperty(tmpEntity.Entity))
			{
				throw new Error('SynthBeacon-SpecRegistry: duplicate entity [' + tmpEntity.Entity + '] in spec [' + tmpClone.Name + ']');
			}
			tmpClone._EntityIndex[tmpEntity.Entity] = tmpEntity;
		}

		this._specs[tmpClone.Name] = tmpClone;

		if (this.fable && this.fable.log)
		{
			this.fable.log.info(`SynthBeacon-SpecRegistry: registered spec [${tmpClone.Name}] with ${tmpClone.Entities.length} entities`);
		}

		return tmpClone.Name;
	}

	/**
	 * Scan a directory for *.json spec files and register each one.
	 * Files that fail to parse or validate are logged and skipped — one
	 * bad spec doesn't block the rest.
	 *
	 * @param {string} pDirectoryPath - absolute or process-relative
	 * @returns {Array<string>} names of specs that were successfully loaded
	 */
	loadSpecsFromDirectory(pDirectoryPath)
	{
		let tmpRegistered = [];
		if (!pDirectoryPath || !libFs.existsSync(pDirectoryPath))
		{
			if (this.fable && this.fable.log)
			{
				this.fable.log.warn(`SynthBeacon-SpecRegistry: spec directory [${pDirectoryPath}] does not exist; no specs loaded`);
			}
			return tmpRegistered;
		}

		let tmpEntries;
		try
		{
			tmpEntries = libFs.readdirSync(pDirectoryPath);
		}
		catch (pErr)
		{
			if (this.fable && this.fable.log)
			{
				this.fable.log.error(`SynthBeacon-SpecRegistry: failed to read directory [${pDirectoryPath}]: ${pErr.message || pErr}`);
			}
			return tmpRegistered;
		}

		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpEntry = tmpEntries[i];
			if (!tmpEntry.endsWith('.json'))
			{
				continue;
			}

			let tmpFullPath = libPath.join(pDirectoryPath, tmpEntry);
			try
			{
				let tmpRaw = libFs.readFileSync(tmpFullPath, 'utf8');
				let tmpObj = JSON.parse(tmpRaw);
				let tmpName = this.registerSpec(tmpObj);
				tmpRegistered.push(tmpName);
			}
			catch (pErr)
			{
				if (this.fable && this.fable.log)
				{
					this.fable.log.error(`SynthBeacon-SpecRegistry: failed to load spec file [${tmpFullPath}]: ${pErr.message || pErr}`);
				}
			}
		}

		return tmpRegistered;
	}

	/**
	 * Return the registered spec object (or null). Returns the live stored
	 * copy by reference — mutations will affect future lookups, so callers
	 * that need to mutate must clone first.
	 */
	getSpec(pSpecName)
	{
		if (!this._specs.hasOwnProperty(pSpecName))
		{
			return null;
		}
		return this._specs[pSpecName];
	}

	/**
	 * Return the per-entity sub-spec (the shape the Evaluator consumes).
	 * Adds a `GlobalSeed` field derived from the parent spec if the entity
	 * doesn't carry its own. The parent spec's GlobalSeed is the convention,
	 * but per-entity overrides are allowed for test fixtures that want one
	 * entity's stream isolated.
	 */
	getEntity(pSpecName, pEntityName)
	{
		let tmpSpec = this.getSpec(pSpecName);
		if (!tmpSpec)
		{
			return null;
		}
		if (!tmpSpec._EntityIndex.hasOwnProperty(pEntityName))
		{
			return null;
		}
		let tmpEntity = tmpSpec._EntityIndex[pEntityName];

		// Compose the effective spec the Evaluator wants. We don't mutate
		// the stored entity definition.
		return (
		{
			Entity: tmpEntity.Entity,
			Count: tmpEntity.Count,
			Fields: tmpEntity.Fields,
			GlobalSeed: tmpEntity.GlobalSeed || tmpSpec.GlobalSeed || tmpSpec.Name
		});
	}

	/**
	 * Light summary of all registered specs, suitable for a discovery
	 * endpoint or UI dropdown. Excludes the heavyweight Fields arrays.
	 */
	listSpecs()
	{
		let tmpResult = [];
		let tmpNames = Object.keys(this._specs).sort();
		for (let i = 0; i < tmpNames.length; i++)
		{
			let tmpSpec = this._specs[tmpNames[i]];
			tmpResult.push(
			{
				Name: tmpSpec.Name,
				Description: tmpSpec.Description || '',
				EntityCount: tmpSpec.Entities.length,
				Entities: this.listEntities(tmpSpec.Name)
			});
		}
		return tmpResult;
	}

	/**
	 * Per-entity summary for one spec (Entity name + Count). Used by the
	 * RestServer to answer "what tables does this spec offer?" without
	 * shipping the entire Fields array.
	 */
	listEntities(pSpecName)
	{
		let tmpSpec = this.getSpec(pSpecName);
		if (!tmpSpec)
		{
			return [];
		}
		let tmpResult = [];
		for (let i = 0; i < tmpSpec.Entities.length; i++)
		{
			let tmpEntity = tmpSpec.Entities[i];
			tmpResult.push(
			{
				Entity: tmpEntity.Entity,
				Count: tmpEntity.Count || 0,
				FieldCount: Array.isArray(tmpEntity.Fields) ? tmpEntity.Fields.length : 0
			});
		}
		return tmpResult;
	}

	/**
	 * True if a spec is registered under this name. Useful for cheap
	 * existence checks before doing a full getSpec/getEntity dance.
	 */
	hasSpec(pSpecName)
	{
		return this._specs.hasOwnProperty(pSpecName);
	}
}

module.exports = SynthBeaconSpecRegistry;
