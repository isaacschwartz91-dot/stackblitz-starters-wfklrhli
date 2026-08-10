/**
 * Domain model for the grocery order-picking app.
 *
 * Everything here is plain data so it can round-trip through IndexedDB, JSON
 * backups and Postgres (Supabase) without translation layers. Postgres column
 * names are snake_case; the mapping lives in `supabase-backend.ts`.
 */

export type Role = 'staff' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** A product in the master catalog (Sheet A). */
export interface Item {
  id: string;
  name: string;
  brand: string;
  size: string;
  department: string;
  /** Aisle code exactly as written in the sheet, e.g. "3" or "Produce". */
  aisle: string;
  /** Position within the aisle along the walking path. */
  shelfSequence: number | null;
  unit: string;
  price: number | null;
  barcode: string;
  active: boolean;
  updatedAt: string;
}

/** One aisle of the store, in the order a picker walks it (Sheet B). */
export interface Aisle {
  /** Aisle code; matches `Item.aisle`. */
  id: string;
  sequence: number;
  name: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  createdAt: string;
}

/**
 * A learned shorthand rule: "when the order says {phrase}, it means {itemId}".
 * `customerId === null` means the rule applies to everyone.
 */
export interface Alias {
  id: string;
  phrase: string;
  /** `normalize(phrase)` — the key matching actually looks up. */
  normalizedPhrase: string;
  itemId: string;
  customerId: string | null;
  hits: number;
  createdAt: string;
  createdBy: string;
}

export type OrderStatus = 'draft' | 'ready' | 'picking' | 'complete';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  draft: 'Draft',
  ready: 'Ready to pick',
  picking: 'Picking',
  complete: 'Complete',
};

export interface Order {
  id: string;
  customerId: string | null;
  /** Snapshot of the customer name so history reads correctly after edits. */
  customerName: string;
  /** ISO datetime, or '' when not scheduled. */
  deliveryAt: string;
  notes: string;
  status: OrderStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** How a line got its product. Drives the badge shown next to the match. */
export type MatchSource =
  | 'customer-alias'
  | 'global-alias'
  | 'exact'
  | 'normalized'
  | 'contains'
  | 'fuzzy'
  | 'manual'
  | 'none';

export const MATCH_SOURCE_LABEL: Record<MatchSource, string> = {
  'customer-alias': 'Customer shorthand',
  'global-alias': 'Store shorthand',
  exact: 'Exact match',
  normalized: 'Matched',
  contains: 'Matched',
  fuzzy: 'Best guess',
  manual: 'Chosen by staff',
  none: 'No match',
};

export interface OrderLine {
  id: string;
  orderId: string;
  /** Order the line was entered in; ties are broken by this. */
  position: number;
  /** Exactly what the customer said / wrote. Never rewritten. */
  rawText: string;
  /** The product phrase left after quantity + unit were stripped. */
  phrase: string;
  itemId: string | null;
  qty: number;
  unit: string;
  note: string;
  needsReview: boolean;
  matchSource: MatchSource;
  matchScore: number;
  picked: boolean;
  outOfStock: boolean;
  substituteItemId: string | null;
}

/**
 * A spreadsheet the app re-reads from a URL, so the store keeps editing one
 * sheet and the software follows along.
 */
export interface LinkedSheet {
  id: string;
  /** Any URL that returns .xlsx or .csv bytes. */
  url: string;
  role: 'items' | 'aisles' | 'customers';
  label: string;
  /**
   * Products missing from the sheet are hidden from matching on each sync.
   * Their order history is untouched — nothing is ever deleted.
   */
  retireMissing: boolean;
}

/** App-wide settings an admin can change from the Settings screen. */
export interface AppSettings {
  storeName: string;
  accentColor: string;
  /** Shown before estimated totals. Purely cosmetic. */
  currencySymbol: string;
  /**
   * The store's logo, shown in the top bar. Either a URL to an uploaded file
   * or, when there is no file store to put one in, the image itself as a
   * data URL — both are just something an `<img>` can load.
   */
  logoUrl: string;
  /** Also break pasted orders on commas, not just newlines. */
  splitOnCommas: boolean;
  /** Score at or above which a fuzzy match is accepted without review. */
  autoAcceptScore: number;
  /** Score below which a line is treated as unmatched. */
  reviewFloorScore: number;
  /** Spreadsheets re-read from a URL. */
  linkedSheets: LinkedSheet[];
  /** Re-read them every time the app is opened. */
  autoSyncOnOpen: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  storeName: 'Our Grocery',
  accentColor: '#1f7a4d',
  currencySymbol: '$',
  logoUrl: '',
  splitOnCommas: false,
  autoAcceptScore: 0.86,
  reviewFloorScore: 0.42,
  linkedSheets: [],
  autoSyncOnOpen: true,
};

/** Everything in the database — used for backup, restore and the demo seed. */
export interface Snapshot {
  items: Item[];
  aisles: Aisle[];
  customers: Customer[];
  aliases: Alias[];
  orders: Order[];
  orderLines: OrderLine[];
  settings: AppSettings;
  exportedAt?: string;
  version?: number;
}

export function emptyItem(id: string): Item {
  return {
    id,
    name: '',
    brand: '',
    size: '',
    department: '',
    aisle: '',
    shelfSequence: null,
    unit: '',
    price: null,
    barcode: '',
    active: true,
    updatedAt: new Date().toISOString(),
  };
}

/** "Farmland 2% Half Gallon · Farmland · 1/2 gal" for display and search. */
export function itemLabel(item: Item): string {
  return [item.name, item.brand, item.size].filter((p) => p.trim() !== '').join(' · ');
}

export function itemDetail(item: Item): string {
  return [item.brand, item.size].filter((p) => p.trim() !== '').join(' · ');
}
