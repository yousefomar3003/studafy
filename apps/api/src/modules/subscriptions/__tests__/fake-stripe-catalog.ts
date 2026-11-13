/**
 * An in-memory stand-in for the slice of the Stripe client that price sync uses: products and
 * prices, with create / retrieve / update / list-by-lookup-key / search.
 *
 * It keeps the Stripe behaviours the sync depends on, because those are what make a run repeatable
 * or not: retrieving an unknown id throws `resource_missing`; a price's amount, currency, interval
 * and product are fixed once created; a lookup key belongs to one price, and creating or updating
 * another with it fails unless `transfer_lookup_key` moves it; and a create sent again with the same
 * idempotency key returns the first answer instead of a second object (with different parameters,
 * an `idempotency_error`). Every create, update and archive is counted so a test can say "this run
 * wrote nothing".
 */

import Stripe from "stripe";

interface FakeProduct {
  id: string;
  object: "product";
  name: string;
  description: string | null;
  active: boolean;
  metadata: Record<string, string>;
  created: number;
}

interface FakePrice {
  id: string;
  object: "price";
  product: string;
  unit_amount: number;
  currency: string;
  recurring: { interval: "month" | "year"; interval_count: number };
  active: boolean;
  lookup_key: string | null;
  metadata: Record<string, string>;
  created: number;
}

interface RequestOptions {
  idempotencyKey?: string;
}

function missing(kind: string, id: string): Stripe.errors.StripeError {
  return new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    code: "resource_missing",
    message: `No such ${kind}: '${id}'`,
    statusCode: 404,
  } as never);
}

function invalid(message: string): Stripe.errors.StripeError {
  return new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    message,
    statusCode: 400,
  } as never);
}

function hasMetadata(metadata: Record<string, string>, key: string, value: string): boolean {
  return Object.entries(metadata).some(([k, v]) => k === key && v === value);
}

/** `metadata['key']:'value'` -- the only query shape the adapter sends. */
function parseMetadataQuery(query: string): [string, string] {
  const match = /^metadata\['([^']+)'\]:'((?:[^'\\]|\\.)*)'$/.exec(query);
  if (!match) throw invalid(`unsupported search query: ${query}`);
  return [match[1]!, match[2]!.replaceAll(/\\(.)/g, "$1")];
}

export class FakeStripeCatalog {
  readonly products = new Map<string, FakeProduct>();
  readonly prices = new Map<string, FakePrice>();
  /** Writes made, by kind. A repeated sync should leave all of them where they were. */
  readonly writes = { productCreates: 0, productUpdates: 0, priceCreates: 0, priceUpdates: 0 };
  /** Every idempotency key a create was sent with, in order. */
  readonly idempotencyKeys: string[] = [];
  /** When false, search sees nothing -- Stripe's search index lagging a fresh write. */
  searchIndexed = true;

  private sequence = 0;
  private clock = 1_790_000_000;
  private readonly idempotent = new Map<string, { params: string; response: unknown }>();

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_fake${this.sequence}`;
  }

  /** Replays a create sent before with the same key, as Stripe does for 24 hours. */
  private replay<T>(options: RequestOptions | undefined, params: unknown, run: () => T): T {
    const key = options?.idempotencyKey;
    if (key) this.idempotencyKeys.push(key);
    if (!key) return run();
    const serialized = JSON.stringify(params);
    const previous = this.idempotent.get(key);
    if (previous) {
      if (previous.params !== serialized) {
        throw new Stripe.errors.StripeIdempotencyError({
          type: "idempotency_error",
          message: "Keys for idempotent requests can only be used with the same parameters",
          statusCode: 400,
        } as never);
      }
      return structuredClone(previous.response) as T;
    }
    const response = run();
    this.idempotent.set(key, { params: serialized, response: structuredClone(response) });
    return response;
  }

  private takeLookupKey(lookupKey: string, transfer: boolean | undefined, ownerId: string): void {
    for (const price of this.prices.values()) {
      if (price.lookup_key === lookupKey && price.id !== ownerId) {
        if (!transfer) throw invalid(`lookup_key ${lookupKey} is already in use`);
        price.lookup_key = null;
      }
    }
  }

  /** Seed a product directly, as if a past sync (or a person in the dashboard) had made it. */
  seedProduct(fields: Partial<FakeProduct> & { name: string }): FakeProduct {
    const product: FakeProduct = {
      id: this.nextId("prod"),
      object: "product",
      description: null,
      active: true,
      metadata: {},
      created: (this.clock += 1),
      ...fields,
    };
    this.products.set(product.id, product);
    return product;
  }

  /** Seed a price directly, as if a past sync had made it. */
  seedPrice(
    fields: Partial<FakePrice> & Pick<FakePrice, "product" | "unit_amount" | "currency">,
  ): FakePrice {
    const price: FakePrice = {
      id: this.nextId("price"),
      object: "price",
      recurring: { interval: "month", interval_count: 1 },
      active: true,
      lookup_key: null,
      metadata: {},
      created: (this.clock += 1),
      ...fields,
    };
    this.prices.set(price.id, price);
    return price;
  }

  /** The prices Stripe would let a new checkout use. */
  activePrices(): FakePrice[] {
    return [...this.prices.values()].filter((price) => price.active);
  }

  /** Shaped as the Stripe client, as far as the adapter's catalog sync reaches into it. */
  client(): Stripe {
    const products = {
      create: async (params: Stripe.ProductCreateParams, options?: RequestOptions) => {
        return this.replay(options, params, () => {
          this.writes.productCreates += 1;
          const product = this.seedProduct({
            name: params.name,
            description: params.description ?? null,
            active: params.active ?? true,
            metadata: { ...(params.metadata as Record<string, string>) },
          });
          return structuredClone(product);
        });
      },
      retrieve: async (id: string) => {
        const product = this.products.get(id);
        if (!product) throw missing("product", id);
        return structuredClone(product);
      },
      update: async (id: string, params: Stripe.ProductUpdateParams) => {
        const product = this.products.get(id);
        if (!product) throw missing("product", id);
        this.writes.productUpdates += 1;
        if (params.name !== undefined) product.name = params.name;
        if (params.description !== undefined) product.description = params.description || null;
        if (params.active !== undefined) product.active = params.active;
        if (params.metadata) Object.assign(product.metadata, params.metadata);
        return structuredClone(product);
      },
      search: async (params: Stripe.ProductSearchParams) => {
        const [key, value] = parseMetadataQuery(params.query);
        const data = this.searchIndexed
          ? [...this.products.values()].filter((product) =>
              hasMetadata(product.metadata, key, value),
            )
          : [];
        return { object: "search_result", data: structuredClone(data), has_more: false };
      },
    };
    const prices = {
      create: async (params: Stripe.PriceCreateParams, options?: RequestOptions) => {
        return this.replay(options, params, () => {
          if (typeof params.product !== "string" || !this.products.has(params.product)) {
            throw missing("product", String(params.product));
          }
          this.writes.priceCreates += 1;
          const id = this.nextId("price");
          if (params.lookup_key) {
            this.takeLookupKey(params.lookup_key, params.transfer_lookup_key, id);
          }
          const price = this.seedPrice({
            id,
            product: params.product,
            unit_amount: params.unit_amount!,
            currency: params.currency,
            recurring: {
              interval: params.recurring!.interval as "month" | "year",
              interval_count: 1,
            },
            active: params.active ?? true,
            lookup_key: params.lookup_key ?? null,
            metadata: { ...(params.metadata as Record<string, string>) },
          });
          return structuredClone(price);
        });
      },
      retrieve: async (id: string) => {
        const price = this.prices.get(id);
        if (!price) throw missing("price", id);
        return structuredClone(price);
      },
      update: async (id: string, params: Stripe.PriceUpdateParams) => {
        const price = this.prices.get(id);
        if (!price) throw missing("price", id);
        const immutable = ["unit_amount", "currency", "recurring", "product"];
        const sent = immutable.filter((field) => field in params);
        if (sent.length > 0) throw invalid(`Received unknown parameters: ${sent.join(", ")}`);
        this.writes.priceUpdates += 1;
        if (params.lookup_key !== undefined) {
          this.takeLookupKey(params.lookup_key, params.transfer_lookup_key, id);
          price.lookup_key = params.lookup_key;
        }
        if (params.active !== undefined) price.active = params.active;
        if (params.metadata) Object.assign(price.metadata, params.metadata);
        return structuredClone(price);
      },
      list: async (params: Stripe.PriceListParams) => {
        const keys = params.lookup_keys ?? [];
        const data = [...this.prices.values()].filter(
          (price) => price.lookup_key !== null && keys.includes(price.lookup_key),
        );
        return { object: "list", data: structuredClone(data), has_more: false };
      },
      search: async (params: Stripe.PriceSearchParams) => {
        const [key, value] = parseMetadataQuery(params.query);
        const data = this.searchIndexed
          ? [...this.prices.values()].filter((price) => hasMetadata(price.metadata, key, value))
          : [];
        return { object: "search_result", data: structuredClone(data), has_more: false };
      },
    };
    return { products, prices } as unknown as Stripe;
  }
}
