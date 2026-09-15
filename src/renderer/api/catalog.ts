import type { CatalogApi } from '@shared/catalog'
import { plainIpcData } from './plain-ipc-data'

declare global {
  interface Window { catalogAPI: CatalogApi }
}

export const catalogApi: CatalogApi = {
  listScopes: () => window.catalogAPI.listScopes(),
  addScope: input => window.catalogAPI.addScope(plainIpcData(input)),
  removeScope: id => window.catalogAPI.removeScope(id),
  startScan: id => window.catalogAPI.startScan(id),
  pauseScan: id => window.catalogAPI.pauseScan(id),
  resumeScan: id => window.catalogAPI.resumeScan(id),
  search: query => window.catalogAPI.search(plainIpcData(query)),
  listTags: () => window.catalogAPI.listTags(),
  setTags: input => window.catalogAPI.setTags(plainIpcData(input)),
  setFavorite: input => window.catalogAPI.setFavorite(plainIpcData(input)),
  listCollections: () => window.catalogAPI.listCollections(),
  saveCollection: input => window.catalogAPI.saveCollection(plainIpcData(input)),
  removeCollection: id => window.catalogAPI.removeCollection(id),
  setEntryCollections: input => window.catalogAPI.setEntryCollections(plainIpcData(input)),
  resolveEntry: input => window.catalogAPI.resolveEntry(plainIpcData(input)),
}
