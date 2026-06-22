// Centrale toegang tot geheimen. Nu via env; in productie via Azure Key Vault
// (zet de waarden als Key Vault references in App Service, of laad ze hier via @azure/keyvault-secrets).
const cache = new Map<string, string>();
export function getSecret(name: string, fallback = ""): string {
  if (cache.has(name)) return cache.get(name)!;
  const v = process.env[name] || fallback;
  cache.set(name, v);
  return v;
}
export function hasStrongSecret(name: string): boolean {
  const v = process.env[name];
  return !!v && v.length >= 24 && v !== "dev-secret-change-me";
}
