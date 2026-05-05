#!/usr/bin/env node
/**
 * Smoke test for SynthBeacon-Evaluator + SolverFunctions.
 * Bootstraps a minimal fable+ExpressionParser, registers synth_*, runs a
 * 5-row spec, prints the records + a determinism check.
 *
 * Run: node scripts/smoke-evaluator.js
 */
const libFable = require('fable');
const libSolverFunctions = require('../source/services/SynthBeacon-SolverFunctions.js');
const libEvaluator = require('../source/services/SynthBeacon-Evaluator.js');

let _Fable = new libFable({ Product: 'SynthSmoke', LogStreams: [{ streamtype: 'console', level: 'warn' }] });
_Fable.serviceManager.addServiceType('ExpressionParser', require('fable/source/services/Fable-Service-ExpressionParser.js'));
_Fable.serviceManager.instantiateServiceProvider('ExpressionParser');

libSolverFunctions.registerSynthSolverFunctions(_Fable, _Fable.ExpressionParser);

const tmpSpec =
{
	Entity: 'Customer',
	Count: 5,
	GlobalSeed: 'smoke-v1',
	Fields:
	[
		{ Column: 'IDCustomer',   Expression: 'RecordIndex + 1' },
		{ Column: 'GUIDCustomer', Expression: 'synth_guid()' },
		{ Column: 'FirstName',    Expression: 'synth_firstName()' },
		{ Column: 'LastName',     Expression: 'synth_lastName()' },
		{ Column: 'Email',        Expression: 'synth_email()' },
		{ Column: 'City',         Expression: 'synth_city()' },
		{ Column: 'StateCode',    Expression: 'synth_stateCode()' },
		{ Column: 'IDCompany',    Expression: 'synth_referenceTo("Company", 50)' },
		{ Column: 'EmailNullable',Expression: 'synth_coinFlip(0.4) ? "" :: synth_email()' },
		{ Column: 'TenureYears',  Expression: 'synth_integer(0, 25)' },
		{ Column: 'CreatedDate',  Expression: 'synth_dateBetween("2020-01-01", "2025-12-31")' },
		{ Column: 'Region',       Expression: 'synth_pickWeighted("North|South|East|West", "40|30|20|10")' }
	]
};

let tmpEvaluator = new libEvaluator(_Fable);

console.log('--- Pass 1 (full set) ---');
let tmpPass1 = tmpEvaluator.generate(tmpSpec);
console.log(JSON.stringify(tmpPass1, null, 2));

console.log('\n--- Pass 2 (full set, same seed) — must equal Pass 1 ---');
let tmpPass2 = tmpEvaluator.generate(tmpSpec);
let tmpDeterministic = JSON.stringify(tmpPass1) === JSON.stringify(tmpPass2);
console.log('Determinism: ' + (tmpDeterministic ? 'OK' : 'FAIL'));

console.log('\n--- Pass 3 (paginated: rows 2-4) — must equal Pass 1 rows 2-4 ---');
let tmpPass3 = tmpEvaluator.generateRange(tmpSpec, null, 2, 3);
let tmpExpected = tmpPass1.slice(2, 5);
let tmpPaginated = JSON.stringify(tmpPass3) === JSON.stringify(tmpExpected);
console.log('Pagination determinism: ' + (tmpPaginated ? 'OK' : 'FAIL'));

console.log('\n--- Pass 4 (different seed, same spec) — must NOT equal Pass 1 ---');
let tmpPass4 = tmpEvaluator.generate(tmpSpec, 'different-seed-v1');
let tmpDifferent = JSON.stringify(tmpPass1) !== JSON.stringify(tmpPass4);
console.log('Seed-sensitivity: ' + (tmpDifferent ? 'OK' : 'FAIL'));

console.log('\n--- Pass 5 (sample of pass 4) ---');
console.log(JSON.stringify(tmpPass4.slice(0, 2), null, 2));

if (!tmpDeterministic || !tmpPaginated || !tmpDifferent)
{
	process.exit(1);
}
console.log('\nAll determinism checks passed.');
