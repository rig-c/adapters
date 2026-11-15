import assert from 'node:assert/strict';
import { packListing } from './workspaces.mjs';
const name = '@rig-c/probe';
const listing = { name, filename: 'probe.tgz', files: [{ path: 'package.json' }] };
for (const value of [[listing], { [name]: listing }]) assert.deepEqual(packListing(JSON.stringify(value), name), listing);
for (const value of [null, [], {}, [listing, listing], { other: listing }, { [name]: { ...listing, files: null } }, [{ ...listing, name: 'other' }], [{ ...listing, filename: null }], [{ ...listing, files: [null] }]]) {
  assert.throws(() => packListing(JSON.stringify(value), name), /PACK_JSON/);
}
assert.throws(() => packListing('invalid', name), /PACK_JSON/);
console.log('PACK_JSON: array and keyed object accepted; 10 malformed/mismatched planted inputs refused; PASS');
