/**
 * Catalog test fixture. Importing this module is a test failure: the
 * catalog must read manifests only (SPEC-HELP R-18, R-22). The flag lets
 * the test see an import that something else caught.
 *
 * @module plugins/catalog-fixtures/throws
 */

;(globalThis as Record<string, unknown>).__maCatalogFixtureImported = true
throw new Error("catalog fixture handler was imported")
