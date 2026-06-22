// Lichtgewicht plugin-/hook-API. Plugins registreren widgets, hooks en betaalproviders
// zonder de kern aan te raken (vervangt het Elementor-plugin-model).

type WidgetRenderer = (settings: any, ctx?: any) => string;
const widgetRenderers = new Map<string, WidgetRenderer>();
export function registerWidget(type: string, render: WidgetRenderer) { widgetRenderers.set(type, render); }
export function getWidgetRenderer(type: string): WidgetRenderer | undefined { return widgetRenderers.get(type); }
export function pluginWidgetTypes(): string[] { return [...widgetRenderers.keys()]; }

// Filters (waarde transformeren) en actions (neveneffecten).
type Hook = { fn: (...a: any[]) => any; prio: number };
const filters = new Map<string, Hook[]>();
const actions = new Map<string, Hook[]>();
const sortHook = (arr: Hook[]) => arr.sort((a, b) => a.prio - b.prio);
export function addFilter(name: string, fn: (value: any, ...args: any[]) => any, prio = 10) {
  const arr = filters.get(name) || []; arr.push({ fn, prio }); filters.set(name, sortHook(arr));
}
export function applyFilters<T>(name: string, value: T, ...args: any[]): T {
  let v = value; for (const h of filters.get(name) || []) v = h.fn(v, ...args); return v;
}
export function addAction(name: string, fn: (...args: any[]) => void, prio = 10) {
  const arr = actions.get(name) || []; arr.push({ fn, prio }); actions.set(name, sortHook(arr));
}
export function doAction(name: string, ...args: any[]) { for (const h of actions.get(name) || []) { try { h.fn(...args); } catch { /* plugin-fout isoleren */ } } }

// Betaalproviders.
export type PaymentProvider = {
  name: string;
  label: string;
  createPayment(input: { orderRef: string; amountCents: number; currency: string; description?: string }): Promise<{ id: string; checkoutUrl?: string }> | { id: string; checkoutUrl?: string };
};
const paymentProviders = new Map<string, PaymentProvider>();
export function registerPaymentProvider(p: PaymentProvider) { paymentProviders.set(p.name, p); }
export function getPaymentProvider(name: string): PaymentProvider | undefined { return paymentProviders.get(name); }
export function listPaymentProviders(): { name: string; label: string }[] { return [...paymentProviders.values()].map((p) => ({ name: p.name, label: p.label })); }

// Plugin-registratie + loader.
export type Plugin = { name: string; setup: () => void };
const loaded: string[] = [];
export function registerPlugin(p: Plugin) { p.setup(); loaded.push(p.name); }
export function loadedPlugins(): string[] { return [...loaded]; }
