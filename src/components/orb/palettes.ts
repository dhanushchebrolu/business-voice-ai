// Subset of SpaceUI OrbBloop's palettes (MIT): only the blue one ClickAI uses.
const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

export const BLOOP_PALETTES = {
  BLUE: { main: hex("#DCF7FF"), low: hex("#0181FE"), mid: hex("#A4EFFF"), high: hex("#FFFDEF") },
} as const;
