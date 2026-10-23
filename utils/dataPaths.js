'use strict';
const path = require('node:path');
const config = require('../config');

// One persistent root for user libraries, uploaded media, fleet assignments
// and the signing key. Changing it must never split a backup across directories.
function dataDirectory() {
    return path.resolve(process.env.DATA_DIR || config.DATA_DIR || path.join(__dirname, '..', 'data'));
}

module.exports = { dataDirectory };
