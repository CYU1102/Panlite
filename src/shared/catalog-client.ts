import { CATALOG_CHANNELS, type CatalogApi } from './catalog'

/** Expose fixed catalog operations, never an arbitrary IPC channel to a page. */
export function createCatalogClient(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): CatalogApi {
  return {
    listScopes: () => invoke(CATALOG_CHANNELS.listScopes) as ReturnType<CatalogApi['listScopes']>,
    addScope: input => invoke(CATALOG_CHANNELS.addScope, input) as ReturnType<CatalogApi['addScope']>,
    removeScope: id => invoke(CATALOG_CHANNELS.removeScope, id) as ReturnType<CatalogApi['removeScope']>,
    startScan: id => invoke(CATALOG_CHANNELS.startScan, id) as ReturnType<CatalogApi['startScan']>,
    pauseScan: id => invoke(CATALOG_CHANNELS.pauseScan, id) as ReturnType<CatalogApi['pauseScan']>,
    resumeScan: id => invoke(CATALOG_CHANNELS.resumeScan, id) as ReturnType<CatalogApi['resumeScan']>,
    search: query => invoke(CATALOG_CHANNELS.search, query) as ReturnType<CatalogApi['search']>,
    listTags: () => invoke(CATALOG_CHANNELS.listTags) as ReturnType<CatalogApi['listTags']>,
    setTags: input => invoke(CATALOG_CHANNELS.setTags, input) as ReturnType<CatalogApi['setTags']>,
    setFavorite: input => invoke(CATALOG_CHANNELS.setFavorite, input) as ReturnType<CatalogApi['setFavorite']>,
    listCollections: () => invoke(CATALOG_CHANNELS.listCollections) as ReturnType<CatalogApi['listCollections']>,
    saveCollection: input => invoke(CATALOG_CHANNELS.saveCollection, input) as ReturnType<CatalogApi['saveCollection']>,
    removeCollection: id => invoke(CATALOG_CHANNELS.removeCollection, id) as ReturnType<CatalogApi['removeCollection']>,
    setEntryCollections: input => invoke(CATALOG_CHANNELS.setEntryCollections, input) as ReturnType<CatalogApi['setEntryCollections']>,
    resolveEntry: input => invoke(CATALOG_CHANNELS.resolveEntry, input) as ReturnType<CatalogApi['resolveEntry']>,
  }
}
