/**
 * IndexedDB store for captured images.
 *
 * Stitched screenshots are far too large to pass through `chrome.runtime`
 * messaging (JSON-only, so a blob would have to be base64'd) and the service
 * worker has no `URL.createObjectURL`. Instead the worker writes the blob here
 * and hands the UI an id; extension pages share the worker's origin, so they
 * can read the blob back and make an object URL locally.
 */

import type { CaptureResult } from './protocol'

const DB_NAME = 'all-in-one'
const DB_VERSION = 1
const SHOTS = 'shots'

export interface StoredShot {
  id: string
  blob: Blob
  meta: CaptureResult
}

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SHOTS)) {
        db.createObjectStore(SHOTS, { keyPath: 'id' }).createIndex('createdAt', 'meta.createdAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'))
  })
  return dbPromise
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(SHOTS, mode)
        const request = fn(tx.objectStore(SHOTS))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
      }),
  )
}

export function putShot(shot: StoredShot): Promise<IDBValidKey> {
  return run('readwrite', (store) => store.put(shot))
}

export function getShot(id: string): Promise<StoredShot | undefined> {
  return run('readonly', (store) => store.get(id) as IDBRequest<StoredShot | undefined>)
}

export function deleteShot(id: string): Promise<undefined> {
  return run('readwrite', (store) => store.delete(id))
}

export async function listShots(): Promise<CaptureResult[]> {
  const all = await run('readonly', (store) => store.getAll() as IDBRequest<StoredShot[]>)
  return all.map((shot) => shot.meta).sort((a, b) => b.createdAt - a.createdAt)
}

/** Resolve a stored shot to an object URL. The caller owns the URL and must revoke it. */
export async function getShotUrl(id: string): Promise<string> {
  const shot = await getShot(id)
  if (!shot) throw new Error(`Shot "${id}" is no longer in the store`)
  return URL.createObjectURL(shot.blob)
}

/** Drop shots older than `maxAgeMs`, keeping at most `keep` of the newest. */
export async function pruneShots(maxAgeMs = 7 * 24 * 60 * 60 * 1000, keep = 50): Promise<number> {
  const all = await run('readonly', (store) => store.getAll() as IDBRequest<StoredShot[]>)
  const cutoff = Date.now() - maxAgeMs
  const ordered = all.sort((a, b) => b.meta.createdAt - a.meta.createdAt)
  const doomed = ordered.filter((shot, index) => index >= keep || shot.meta.createdAt < cutoff)
  await Promise.all(doomed.map((shot) => deleteShot(shot.id)))
  return doomed.length
}
