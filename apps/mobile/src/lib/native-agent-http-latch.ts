const owners = new WeakMap<object, Map<string, string>>();
/** Read and write adapters share one native module/origin until the actual OS Promise settles. */
export function mobileAgentHttpPending(module: object): Map<string, string> {
  let pending = owners.get(module);
  if (!pending) { pending = new Map(); owners.set(module, pending); }
  return pending;
}
