'use strict';
// File types of the Tcl language (read from package.json so the workspace index never drifts from what is registered)
const pkg = require('../package.json');

const EXTENSIONS = ((pkg.contributes.languages.find(l => l.id === 'tcl') || {}).extensions || ['.tcl']).map(e => e.replace(/^\./, ''));
const GLOB = `**/*.{${EXTENSIONS.join(',')}}`;
const EXCLUDE = '**/{node_modules,.git}/**';
const MAX_FILES = 2000;

module.exports = { EXTENSIONS, GLOB, EXCLUDE, MAX_FILES };
