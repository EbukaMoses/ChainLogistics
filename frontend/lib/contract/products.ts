import type { Product } from "@/lib/types/product";
import { CONTRACT_CONFIG } from "./config";
import { trackContractInteraction, trackError } from "@/lib/analytics";
import { HORIZON_URL_BY_NETWORK } from "@/lib/stellar/networks";
import { Address, xdr } from "@stellar/stellar-sdk";

/**
 * Fetches products registered by a given owner address.
 *
 * Strategy:
 *  1. When a contract ID is configured, query the Horizon event stream for
 *     `product_registered` contract events emitted by the owner, then
 *     reconstruct Product objects from the event payloads.
 *  2. In development with no contract configured, return mock data so the
 *     UI is usable without a live deployment.
 */
export async function getProductsByOwner(owner: string): Promise<Product[]> {
  const startedAt = Date.now();

  if (!CONTRACT_CONFIG.CONTRACT_ID) {
    if (process.env.NODE_ENV === "development") {
      return getMockProducts(owner);
    }
    return [];
  }

  try {
    const products = await fetchProductsFromHorizon(owner);

    trackContractInteraction({
      method: "get_products_by_owner",
      durationMs: Date.now() - startedAt,
      success: true,
      context: { owner, resultCount: products.length },
    });

    return products;
  } catch (error) {
    trackContractInteraction({
      method: "get_products_by_owner",
      durationMs: Date.now() - startedAt,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      context: { owner },
    });
    trackError(error, { source: "getProductsByOwner", owner });
    // Degrade gracefully — return empty rather than crashing the page
    return [];
  }
}

// ---------------------------------------------------------------------------
// Horizon event indexing
// ---------------------------------------------------------------------------

type HorizonEventRecord = {
  id: string;
  type: string;
  ledger: number;
  ledger_closed_at: string;
  contract_id: string;
  topic: string[];
  value: string;
  paging_token: string;
};

type HorizonEventsResponse = {
  _embedded?: { records: HorizonEventRecord[] };
};

/**
 * Queries Horizon for `product_registered` contract events emitted by the
 * ChainLogistics contract and owned by `owner`.
 *
 * Horizon's `/contract_events` endpoint lets us filter by contract_id and
 * topic, which maps directly to the on-chain event structure:
 *   topics: [Symbol("product_registered"), String(product_id)]
 *   value:  Product struct (XDR-encoded)
 */
async function fetchProductsFromHorizon(owner: string): Promise<Product[]> {
  const horizonUrl =
    HORIZON_URL_BY_NETWORK[CONTRACT_CONFIG.NETWORK] ??
    HORIZON_URL_BY_NETWORK.testnet;

  // Encode the topic filter: first topic = Symbol "product_registered"
  const url = new URL(
    `/contract_events`,
    horizonUrl
  );
  url.searchParams.set("contract_id", CONTRACT_CONFIG.CONTRACT_ID);
  url.searchParams.set("limit", "200");
  url.searchParams.set("order", "desc");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    // 10-second timeout via AbortController
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Horizon request failed: ${response.status} ${response.statusText}`
    );
  }

  const data: HorizonEventsResponse = await response.json();
  const records = data._embedded?.records ?? [];

  // Parse each event record into a Product
  const products: Product[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    try {
      const product = parseProductFromEvent(record, owner);
      if (product && !seen.has(product.id)) {
        seen.add(product.id);
        products.push(product);
      }
    } catch {
      // Skip malformed events
    }
  }

  return products;
}

/**
 * Parses a Horizon contract event record into a Product.
 * Returns null if the event is not a product_registered event for this owner.
 */
function parseProductFromEvent(
  record: HorizonEventRecord,
  owner: string
): Product | null {
  if (!record.topic || record.topic.length < 2) return null;

  try {
    const firstTopic = xdr.ScVal.fromXDR(record.topic[0], "base64");
    if (
      firstTopic.switch() !== xdr.ScValType.scvSymbol() ||
      firstTopic.sym().toString() !== "product_registered"
    ) {
      return null;
    }

    const valueScVal = xdr.ScVal.fromXDR(record.value, "base64");
    if (valueScVal.switch() !== xdr.ScValType.scvMap()) return null;

    const map = valueScVal.map() as xdr.ScMapEntry[];
    const get = (key: string): string => {
      const entry = map.find(
        (e) =>
          e.key().switch() === xdr.ScValType.scvSymbol() &&
          e.key().sym().toString() === key
      );
      if (!entry) return "";
      const val = entry.val();
      if (val.switch() === xdr.ScValType.scvString()) return val.str().toString();
      if (val.switch() === xdr.ScValType.scvSymbol()) return val.sym().toString();
      return "";
    };

    const productOwner = (() => {
      const entry = map.find(
        (e) =>
          e.key().switch() === xdr.ScValType.scvSymbol() &&
          e.key().sym().toString() === "owner"
      );
      if (!entry) return "";
      const val = entry.val();
      if (val.switch() === xdr.ScValType.scvAddress()) {
        return Address.fromScAddress(val.address()).toString();
      }
      return "";
    })();

    if (productOwner !== owner) return null;

    const id = get("id");
    if (!id) return null;

    const createdAt = (() => {
      const entry = map.find(
        (e) =>
          e.key().switch() === xdr.ScValType.scvSymbol() &&
          e.key().sym().toString() === "created_at"
      );
      if (!entry) return Math.floor(new Date(record.ledger_closed_at).getTime() / 1000);
      const val = entry.val();
      if (val.switch() === xdr.ScValType.scvU64()) return Number(val.u64());
      return Math.floor(new Date(record.ledger_closed_at).getTime() / 1000);
    })();

    const activeEntry = map.find(
      (e) =>
        e.key().switch() === xdr.ScValType.scvSymbol() &&
        e.key().sym().toString() === "active"
    );
    const active =
      activeEntry?.val().switch() === xdr.ScValType.scvBool()
        ? activeEntry.val().b()
        : true;

    return {
      id,
      name: get("name"),
      description: get("description"),
      origin: { location: get("origin_location") || get("origin") },
      owner: productOwner,
      created_at: createdAt,
      active,
      category: get("category"),
      tags: [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mock data (development only)
// ---------------------------------------------------------------------------

function getMockProducts(owner: string): Product[] {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  return [
    {
      id: "PROD-001",
      name: "Organic Coffee Beans",
      description: "Premium organic coffee beans from Colombia",
      origin: { location: "Colombia, South America" },
      owner,
      created_at: Math.floor((now - 30 * day) / 1000),
      active: true,
      category: "Beverages",
      tags: ["organic", "fair-trade"],
      eventCount: 5,
    },
    {
      id: "PROD-002",
      name: "Fresh Avocados",
      description: "Hass avocados from Mexico",
      origin: { location: "Michoacán, Mexico" },
      owner,
      created_at: Math.floor((now - 15 * day) / 1000),
      active: true,
      category: "Produce",
      tags: ["organic", "fresh"],
      eventCount: 3,
    },
    {
      id: "PROD-003",
      name: "Organic Cotton T-Shirt",
      description: "100% organic cotton t-shirt",
      origin: { location: "India" },
      owner,
      created_at: Math.floor((now - 7 * day) / 1000),
      active: true,
      category: "Apparel",
      tags: ["organic", "sustainable"],
      eventCount: 8,
    },
    {
      id: "PROD-004",
      name: "Honey",
      description: "Raw wildflower honey",
      origin: { location: "Vermont, USA" },
      owner,
      created_at: Math.floor((now - 45 * day) / 1000),
      active: false,
      category: "Food",
      tags: ["raw", "local"],
      eventCount: 12,
    },
  ];
}
