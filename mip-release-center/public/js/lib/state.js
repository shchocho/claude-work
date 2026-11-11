// What the client knows about the signed-in user and the current policy.
import { tl } from './i18n.js';

export const state = { user: null, app: null, policy: null, policyVersion: null, badges: null };

export const can = (permission) => Boolean(state.user?.permissions.includes(permission));

/**
 * Labels, actions and reasons are looked up in the names snapshot stored with
 * a request first, so an old request still reads correctly after the policy
 * has changed, and in the current policy otherwise.
 */
function find(kind, id, names) {
  if (!id) return null;
  return names?.[kind]?.find((item) => item.id === id) ?? state.policy?.[kind]?.find((item) => item.id === id) ?? null;
}

export const labelOf = (id, names) => find('labels', id, names);
export const labelName = (id, names) => tl(find('labels', id, names)?.name) || id || '';
export const actionName = (id, names) => tl(find('actions', id, names)?.name) || id || '';
export const reasonName = (id, names) => tl(find('reasons', id, names)?.name) || id || '';
