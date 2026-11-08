// To-do channel: a shared task list. Pure functions, so server/todo-test.js can run them without a server; index.js wires them in
// (the "to-do channel" routes) and keeps the data on the channel itself:
//   channel = { id, name, type: 'todo', addRoles: [roleId], todos: [ { id, text, roleId, done, by, at, doneBy, doneAt } ] }
//
//   addRoles  the roles that may add tasks, assign them and delete them. The owner, co-owners and anyone with Manage channels always may.
//   roleId    the role a task is assigned to (null = nobody in particular).
//   done      ticked off. Anyone who may add tasks can tick or untick any task; anyone holding the assigned role can tick or untick that task.
//
// `who` is { owner: bool, manage: bool, roleIds: [the roles this person holds] }, built by index.js.

const LIMITS = { items: 100, text: 200, addRoles: 10 };

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const canAdd = (who, channel) => !!who && (who.owner === true || who.manage === true || (channel.addRoles || []).some((id) => (who.roleIds || []).includes(id)));
const canTick = (who, channel, item) => canAdd(who, channel) || (!!item.roleId && !!who && (who.roleIds || []).includes(item.roleId));

// the roles allowed to add: an array of ids that all exist in the server
function cleanAddRoles(input, serverRoleIds) {
  if (!Array.isArray(input)) return { error: 'Pick the roles that can add tasks' };
  if (new Set(input).size !== input.length) return { error: 'A role is listed twice' };
  if (input.length > LIMITS.addRoles) return { error: `At most ${LIMITS.addRoles} roles can add tasks` };
  if (!input.every((id) => typeof id === 'string' && serverRoleIds.includes(id))) return { error: 'One of those roles does not exist' };
  return { value: [...input] };
}

// a new task: { text, roleId? }
function cleanNew(input, serverRoleIds) {
  const text = clean(input && input.text, LIMITS.text);
  if (!text) return { error: 'Write the task first' };
  const roleId = input.roleId === undefined || input.roleId === null || input.roleId === '' ? null : input.roleId;
  if (roleId !== null && !(typeof roleId === 'string' && serverRoleIds.includes(roleId))) return { error: 'That role does not exist' };
  return { value: { text, roleId } };
}

// a change to a task: any of { text, roleId, done }. `who` decides which of them are allowed.
function cleanChange(input, serverRoleIds, who, channel, item) {
  const out = {};
  const adder = canAdd(who, channel);
  if (input.text !== undefined || input.roleId !== undefined) {
    if (!adder) return { error: 'Only people who can add tasks can change them' };
    if (input.text !== undefined) {
      const text = clean(input.text, LIMITS.text);
      if (!text) return { error: 'The task cannot be empty' };
      out.text = text;
    }
    if (input.roleId !== undefined) {
      const roleId = input.roleId === null || input.roleId === '' ? null : input.roleId;
      if (roleId !== null && !(typeof roleId === 'string' && serverRoleIds.includes(roleId))) return { error: 'That role does not exist' };
      out.roleId = roleId;
    }
  }
  if (input.done !== undefined) {
    if (typeof input.done !== 'boolean') return { error: 'done must be true or false' };
    if (!canTick(who, channel, item)) return { error: 'Only the assigned role or people who can add tasks can tick this' };
    out.done = input.done;
  }
  if (!Object.keys(out).length) return { error: 'Nothing to change' };
  return { value: out };
}

// a deleted role cannot stay on the channel: it stops being an adder, and tasks assigned to it become unassigned
function dropRole(channel, roleId) {
  if (Array.isArray(channel.addRoles)) channel.addRoles = channel.addRoles.filter((id) => id !== roleId);
  for (const t of channel.todos || []) if (t.roleId === roleId) t.roleId = null;
}

module.exports = { LIMITS, canAdd, canTick, cleanAddRoles, cleanNew, cleanChange, dropRole };
