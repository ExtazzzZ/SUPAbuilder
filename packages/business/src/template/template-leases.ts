/**
 * Timing shared by the sync claim and the sweep that re-dispatches syncs: both
 * must agree on when a claim is dead and when a row is given up on.
 */

/** A claim not renewed within this window belongs to a dead worker (matches installs). */
export const SYNC_LEASE_MS = 15 * 60 * 1000
/** A `pending` sync younger than this may still be on its way to the queue. */
export const SYNC_UNCLAIMED_GRACE_MS = 5 * 60 * 1000
/** The sweep stops retrying a sync this old (same bound as installs). */
export const SYNC_REDISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000
