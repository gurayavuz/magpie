/**
 * IndexedDB store for screen recordings.
 *
 * A recording is written as it happens: `MediaRecorder` hands over a chunk every
 * few seconds and each one goes straight to disk. Holding a twenty-minute
 * capture in memory would not survive, and the offscreen document has no way to
 * stream to a file directly.
 *
 * A separate database from the screenshot store, so adding this needed no
 * version bump or migration of existing captures.
 */

import type { RecordingMeta } from './protocol'

const DB_NAME = 'magpie-recordings'
const DB_VERSION = 1
const META = 'recordings'
const CHUNKS = 'chunks'

let dbPromise: Promise<IDBDatabase> | undefined

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        // Keyed by [recording, index] so chunks read back in capture order.
        db.createObjectStore(CHUNKS, { keyPath: ['recordingId', 'index'] })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the recording store'))
  })
  return dbPromise
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction(store, mode).objectStore(store))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Recording store request failed'))
      }),
  )
}

export function putChunk(recordingId: string, index: number, blob: Blob): Promise<IDBValidKey> {
  return run(CHUNKS, 'readwrite', (store) => store.put({ recordingId, index, blob }))
}

export function putRecording(meta: RecordingMeta): Promise<IDBValidKey> {
  return run(META, 'readwrite', (store) => store.put(meta))
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  const all = await run(META, 'readonly', (store) => store.getAll() as IDBRequest<RecordingMeta[]>)
  return all.sort((a, b) => b.startedAt - a.startedAt)
}

export function getRecording(id: string): Promise<RecordingMeta | undefined> {
  return run(META, 'readonly', (store) => store.get(id) as IDBRequest<RecordingMeta | undefined>)
}

/** Stitch a recording's chunks back into one blob, in capture order. */
export async function assembleRecording(id: string): Promise<Blob> {
  const meta = await getRecording(id)
  if (!meta) throw new Error('That recording is no longer available')

  const rows = await run(
    CHUNKS,
    'readonly',
    (store) =>
      store.getAll(IDBKeyRange.bound([id, -Infinity], [id, Infinity])) as IDBRequest<
        { index: number; blob: Blob }[]
      >,
  )
  if (rows.length === 0) throw new Error('That recording has no data')

  const ordered = rows.sort((a, b) => a.index - b.index).map((row) => row.blob)
  return new Blob(ordered, { type: meta.mimeType })
}

export async function deleteRecording(id: string): Promise<void> {
  await run(META, 'readwrite', (store) => store.delete(id))
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHUNKS, 'readwrite')
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Could not delete the recording'))
  })
}

/**
 * Remove chunks with no surviving recording — what a capture that crashed or was
 * interrupted leaves behind.
 */
export async function pruneOrphans(): Promise<number> {
  const known = new Set((await listRecordings()).map((meta) => meta.id))
  const rows = (await run(CHUNKS, 'readonly', (store) => store.getAllKeys())) as unknown as [
    string,
    number,
  ][]
  const orphans = rows.filter(([recordingId]) => !known.has(recordingId))

  for (const key of orphans) {
    await run(CHUNKS, 'readwrite', (store) => store.delete(key))
  }
  return orphans.length
}
