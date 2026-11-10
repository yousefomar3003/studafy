/**
 * Pagination limits as plain numbers, with no zod in this module. Clients that only need the
 * numbers (the web API client checks list params before sending them) import
 * `@studafy/shared-schemas/limits`, so their bundle does not pull in zod and every schema in this
 * package just to read two constants.
 */
export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;
