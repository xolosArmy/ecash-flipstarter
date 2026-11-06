/**
 * P8G-05: recorre el stack Express y lista métodos+rutas montados.
 * Sirve para comparar contra una allowlist y atrapar rutas nuevas olvidadas.
 */
export type MountedRoute = { method: string; path: string };

/** Decodifica el mount path de un layer Express 4 (regexp ^\/api\/?(?=\/|$)). */
export function mountPathFromLayer(layer: {
  regexp?: RegExp & { fast_slash?: boolean; fast_star?: boolean };
  route?: { path: string };
}): string {
  if (layer.route) return layer.route.path;
  const re = layer.regexp;
  if (!re) return '';
  if (re.fast_slash) return '';
  if (re.fast_star) return '*';
  const normalized = re
    .toString()
    .replace('\\/?', '')
    .replace('(?=\\/|$)', '$')
    .match(/^\/\^((?:\\[.*+?^${}()|[\]\\\/]|[^.*+?^${}()|[\]\\\/])*)\$\//);
  if (!normalized) {
    // Fallback: /api desde /^\/api\/?(?=\/|$)/i
    const loose = re.toString().match(/^\/\^(\\.+)\\\/\?\(\?=\\\/\|\$\)\/i?$/);
    if (loose) return loose[1].replace(/\\(.)/g, '$1');
    const simple = re.source.match(/^\^\\\/([^\\/?]+)/);
    if (simple) return `/${simple[1].replace(/\\(.)/g, '$1')}`;
    return '';
  }
  const joined = normalized[1].replace(/\\(.)/g, '$1');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function joinMount(prefix: string, routePath: string): string {
  if (!prefix) return routePath.startsWith('/') ? routePath : `/${routePath}`;
  if (routePath === '/') return prefix;
  const a = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const b = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${a}${b}`;
}

function walkStack(stack: any[] | undefined, prefix: string, out: MountedRoute[]): void {
  if (!Array.isArray(stack)) return;
  for (const layer of stack) {
    if (layer.route) {
      const path = joinMount(prefix, layer.route.path);
      const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
      for (const method of methods) {
        out.push({ method: method.toUpperCase(), path });
      }
      continue;
    }
    if (layer.name === 'router' && layer.handle?.stack) {
      const mount = mountPathFromLayer(layer);
      walkStack(layer.handle.stack, joinMount(prefix, mount || ''), out);
    }
  }
}

/** Inventario de rutas del `app` creado por createApp() (o cualquier Express). */
export function listMountedRoutes(app: { _router?: { stack?: unknown[] } } | any): MountedRoute[] {
  const stack = (app as any)?._router?.stack as any[] | undefined;
  const out: MountedRoute[] = [];
  walkStack(stack, '', out);
  // Estable y sin duplicados
  const key = (r: MountedRoute) => `${r.method} ${r.path}`;
  const seen = new Set<string>();
  const uniq: MountedRoute[] = [];
  for (const r of out) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }
  uniq.sort((a, b) => key(a).localeCompare(key(b)));
  return uniq;
}

export function mutatingRoutes(routes: MountedRoute[]): MountedRoute[] {
  const MUT = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  return routes.filter((r) => MUT.has(r.method));
}

export function routeKey(r: MountedRoute): string {
  return `${r.method} ${r.path}`;
}
