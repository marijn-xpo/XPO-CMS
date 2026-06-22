// XPO Screens productkennis — geport uit de Alysium AI plugin (class-xpo-knowledge.php).
// Dient als basis-kennisbank voor de assistent, los van de site-content.

export type Product = { name: string; description: string; tags: string[]; priceStart: number | null };

export const XPO_PRODUCTS: Product[] = [
  { name: "INVITE", description: "Standaard indoor liftdisplay, opbouw-gemonteerd, premium designopties. Verkrijgbaar in 15\", 21\", 27\", 32\", 42\", 46\".", tags: ["lift", "indoor", "opbouw", "lobby", "entree", "design"], priceStart: 1500 },
  { name: "ZENITH", description: "Liftdisplay met inbouw-optie, meer geïntegreerd uiterlijk dan INVITE. 15\", 21\", 27\". Opbouw of inbouw.", tags: ["lift", "inbouw", "geïntegreerd", "indoor"], priceStart: 1500 },
  { name: "SERENITY", description: "Maatwerk spiegel-/flush-integratie. Volledig vlak in de wand of verborgen achter spiegelglas. Architecturale maatoplossing.", tags: ["maatwerk", "flush", "spiegel", "architectuur", "premium", "verborgen"], priceStart: 5000 },
  { name: "SPHERIX", description: "Onderscheidend rond/sferisch wanddisplay-object. Unieke vormfactor.", tags: ["rond", "onderscheidend", "wandobject", "experience"], priceStart: null },
  { name: "SQUARIX", description: "Onderscheidend vierkant wanddisplay-object.", tags: ["vierkant", "onderscheidend", "wandobject"], priceStart: null },
  { name: "ARCADIA", description: "Vrijstaand kiosk-display voor retail en wayfinding.", tags: ["vrijstaand", "kiosk", "retail", "wayfinding"], priceStart: null },
  { name: "ELYSIUM", description: "Premium ultradun dubbelzijdig vrijstaand display. 55\" of 37\" touch-tabletop.", tags: ["dubbelzijdig", "vrijstaand", "premium", "showroom", "retail"], priceStart: null },
];

export type KDoc = { id: string; title: string; text: string; source: string; url: string };

export function productDocs(): KDoc[] {
  return XPO_PRODUCTS.map((p) => ({
    id: "product:" + p.name,
    title: p.name + " — XPO display",
    text: `${p.name}. ${p.description} Trefwoorden: ${p.tags.join(", ")}.` + (p.priceStart ? ` Vanafprijs €${p.priceStart}.` : ""),
    source: "product",
    url: "/site/solutions",
  }));
}
