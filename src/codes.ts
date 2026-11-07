// Short nature words: easy to say at a stand, and they never name an item for sale.
const WORDS = [
  "WREN", "FERN", "OWL", "MOSS", "OAK", "ELM", "ROBIN", "LARK", "HAWK", "FOX",
  "DEER", "HARE", "OTTER", "BIRCH", "PINE", "CEDAR", "MAPLE", "ASPEN", "DOVE", "JAY",
  "FINCH", "HERON", "CRANE", "SWAN", "LYNX", "MINK", "TERN", "RAVEN", "BROOK", "COVE",
  "RIDGE", "GLEN", "DUNE", "REEF", "STONE", "CLOUD", "FROST", "STAR", "MOON", "TIDE",
];

function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] ?? 0) % max;
}

/** A code for the basket label, such as "WREN-27". */
export function orderCode(): string {
  const word = WORDS[randomInt(WORDS.length)] ?? "WREN";
  const digits = String(10 + randomInt(90));
  return `${word}-${digits}`;
}

/** A URL-safe random token (base64url, no padding). */
export function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
