// Roles and what each one may do. Approval authority is deliberately absent:
// it comes only from being assigned to a stage (or delegated by an assignee),
// never from a role, so no role can approve its way around the approval route.
export const ROLES = ['requester', 'approver', 'security', 'operator', 'auditor', 'admin'];

const GRANTS = {
  requester: ['request.create'],
  approver: [],
  security: ['request.read.all', 'audit.read', 'audit.export', 'report.read', 'policy.write', 'stage.reassign'],
  operator: ['execution.operate'],
  auditor: ['request.read.all', 'audit.read', 'audit.export', 'report.read'],
  admin: [
    'user.manage',
    'token.manage',
    'system.read',
    'policy.write',
    'audit.read',
    'audit.export',
    'report.read',
    'request.read.all',
    'stage.reassign',
  ],
};

/** API token scopes map onto read-only permissions. */
export const TOKEN_SCOPES = {
  'audit:read': ['audit.read', 'audit.export'],
  'requests:read': ['request.read.all'],
  'reports:read': ['report.read'],
};

export function permissionsForRoles(roles) {
  const set = new Set();
  for (const role of roles) for (const p of GRANTS[role] ?? []) set.add(p);
  return [...set].sort();
}

export function permissionsForScopes(scopes) {
  const set = new Set();
  for (const scope of scopes) for (const p of TOKEN_SCOPES[scope] ?? []) set.add(p);
  return [...set].sort();
}

/**
 * A principal is whoever is making the call: a signed-in user or an API token.
 * { type: 'user'|'token'|'system', id, label, roles, permissions, user? }
 */
export function can(principal, permission) {
  return Boolean(principal && principal.permissions.includes(permission));
}

export function hasRole(principal, role) {
  return Boolean(principal && principal.roles.includes(role));
}

export const SYSTEM_ACTOR = Object.freeze({ type: 'system', id: null, label: 'system', ip: null });
