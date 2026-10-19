/**
 * errors.js — the page's own record of what went wrong.
 *
 * `tools/shot.mjs` reads `window.__creekErrors` and exits non-zero if it is not
 * empty, and the CI job runs that tool. It is therefore the mechanism that stops
 * a broken contribution from being merged, which is worth more than it looks:
 * a model that quietly fails to appear is invisible in a still.
 *
 * Uncaught code errors only. A missing favicon, or a CDN that one network
 * blocks, shows up in the console but is not this list's business — mixing
 * network noise in would make the check fail for reasons that have nothing to
 * do with the change under review.
 */

window.__creekErrors = window.__creekErrors || [];

window.addEventListener('error', (e) => {
  // a resource that fails to load dispatches a bare Event with no `error` on
  // it; only a genuine uncaught exception carries one
  if (!e.error) return;
  window.__creekErrors.push(String(e.error.stack || e.error.message || e.error));
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  window.__creekErrors.push(String((r && r.stack) || r || 'unhandled rejection'));
});

/**
 * Record a failure that was caught somewhere, rather than swallowed. Anything
 * optional in this scene fails soft — the creek carries on without it — but
 * "carries on" and "went unnoticed" are different things.
 */
export function noteError(where, err) {
  window.__creekErrors.push(`${where}: ${(err && err.message) || err}`);
}
