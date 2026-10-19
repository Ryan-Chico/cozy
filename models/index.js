/**
 * The manifest — every guest in the scene, in the order they load.
 *
 * Adding your own model is one line here, plus a folder next to these. That is
 * the whole integration; there is no build step and nothing to register
 * anywhere else. See CONTRIBUTING.md.
 *
 * These are static imports rather than a fetched list on purpose. A spec with a
 * typo in it fails loudly when the page loads, naming the file, instead of
 * quietly not appearing — and a model that is not in this list is a model that
 * does not exist, which is a much easier thing to debug than a 404 nobody reads.
 */

import toad from './toad/index.js';
import b17 from './b17/index.js';
import shogun from './shogun/index.js';

export default [toad, b17, shogun];
