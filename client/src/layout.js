// Channel list layout helpers shared by the sidebar (drag and drop) and server settings (arrow buttons).
// A layout is { cats: [categoryId...], chans: [{ id, categoryId | null }...] } in display order:
// ungrouped channels first, then each category with its channels.
export function layoutOf(server) {
  const cats = server.categories || [];
  const ids = new Set(cats.map((c) => c.id));
  const group = (catId) => server.channels.filter((c) => (catId ? c.categoryId === catId : !c.categoryId || !ids.has(c.categoryId)));
  const chans = [...group(null).map((c) => ({ id: c.id, categoryId: null })), ...cats.flatMap((cat) => group(cat.id).map((c) => ({ id: c.id, categoryId: cat.id })))];
  return { cats: cats.map((c) => c.id), chans };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const sameLayout = (a, b) => same(a, b);

// Put a channel into `categoryId` (null = ungrouped) just before `beforeId`, or at the end of that group.
export function moveChannel(layout, id, categoryId, beforeId = null) {
  const moving = layout.chans.find((c) => c.id === id);
  if (!moving || id === beforeId) return layout;
  const rest = layout.chans.filter((c) => c.id !== id);
  const item = { id, categoryId };
  let at;
  if (beforeId) at = rest.findIndex((c) => c.id === beforeId);
  else { // end of the group: after its last member, or (empty group) where the group would start
    const last = rest.map((c, i) => (c.categoryId === categoryId ? i : -1)).filter((i) => i >= 0).pop();
    at = last === undefined ? emptyGroupSpot(layout, rest, categoryId) : last + 1;
  }
  if (at < 0) at = rest.length;
  rest.splice(at, 0, item);
  return { ...layout, chans: rest };
}
// An empty category has no channels to anchor to, so place the channel after the last channel of the closest earlier category.
function emptyGroupSpot(layout, rest, categoryId) {
  if (!categoryId) return 0;
  const order = layout.cats, mine = order.indexOf(categoryId);
  for (let i = mine - 1; i >= 0; i--) {
    const last = rest.map((c, k) => (c.categoryId === order[i] ? k : -1)).filter((k) => k >= 0).pop();
    if (last !== undefined) return last + 1;
  }
  return rest.filter((c) => !c.categoryId).length;
}
// Put a category just before `beforeId` (or last). Its channels travel with it because the channel order is rebuilt from the category order.
export function moveCategory(layout, id, beforeId = null) {
  if (!layout.cats.includes(id) || id === beforeId) return layout;
  const cats = layout.cats.filter((c) => c !== id);
  const at = beforeId ? cats.indexOf(beforeId) : -1;
  cats.splice(at < 0 ? cats.length : at, 0, id);
  const rank = new Map(cats.map((c, i) => [c, i]));
  const chans = [...layout.chans].sort((a, b) => (a.categoryId ? rank.get(a.categoryId) + 1 : 0) - (b.categoryId ? rank.get(b.categoryId) + 1 : 0)); // stable: keeps order inside a group
  return { cats, chans };
}
export const saveLayout = (api, serverId, layout) => api(`/servers/${serverId}/layout`, { method: 'PUT', body: { categories: layout.cats, channels: layout.chans } });
