// Per-request CSP-nonce voor inline scripts. Wordt synchroon gezet aan het begin van een
// render-handler en synchroon gelezen tijdens het opbouwen van het document (geen await ertussen).
let current = "";
export function setNonce(n: string | undefined) { current = n || ""; }
export function getNonce(): string { return current; }
export function nonceAttr(): string { return current ? ` nonce="${current}"` : ""; }
