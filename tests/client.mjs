// The browser's own pairing and sealing modules, gathered into one namespace for the
// scripts that drive them from Node (make-vectors.mjs, smoke.mjs).

import * as codes from '../web/code.js';
import * as sealing from '../web/crypto.js';
import { parseItems } from '../web/api.js';

export const core = { ...codes, ...sealing, parseItems };
