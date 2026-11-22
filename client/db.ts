import type { CachedLicense, CachedSegment } from "./types.js";

const DATABASE_NAME = "nimbus-controlled-player";
const DATABASE_VERSION = 1;
const META_STORE = "meta";
const SEGMENT_STORE = "segments";
const LICENSE_STORE = "licenses";

let databasePromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE);
        }
        if (!database.objectStoreNames.contains(SEGMENT_STORE)) {
          database.createObjectStore(SEGMENT_STORE, { keyPath: "segmentId" });
        }
        if (!database.objectStoreNames.contains(LICENSE_STORE)) {
          database.createObjectStore(LICENSE_STORE, { keyPath: "segmentId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
    });
  }
  return databasePromise;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE, "readonly");
  return requestResult(transaction.objectStore(META_STORE).get(key)) as Promise<T | undefined>;
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  transaction.objectStore(META_STORE).put(value, key);
  await transactionDone(transaction);
}

export async function deleteMeta(key: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  transaction.objectStore(META_STORE).delete(key);
  await transactionDone(transaction);
}

export async function getAllSegments(): Promise<CachedSegment[]> {
  const database = await openDatabase();
  const transaction = database.transaction(SEGMENT_STORE, "readonly");
  return requestResult(transaction.objectStore(SEGMENT_STORE).getAll()) as Promise<CachedSegment[]>;
}

export async function getSegment(segmentId: string): Promise<CachedSegment | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(SEGMENT_STORE, "readonly");
  return requestResult(transaction.objectStore(SEGMENT_STORE).get(segmentId)) as Promise<CachedSegment | undefined>;
}

export async function putSegment(segment: CachedSegment): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SEGMENT_STORE, "readwrite");
  transaction.objectStore(SEGMENT_STORE).put(segment);
  await transactionDone(transaction);
}

export async function clearSegments(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SEGMENT_STORE, "readwrite");
  transaction.objectStore(SEGMENT_STORE).clear();
  await transactionDone(transaction);
}

export async function getAllLicenses(): Promise<CachedLicense[]> {
  const database = await openDatabase();
  const transaction = database.transaction(LICENSE_STORE, "readonly");
  return requestResult(transaction.objectStore(LICENSE_STORE).getAll()) as Promise<CachedLicense[]>;
}

export async function getLicense(segmentId: string): Promise<CachedLicense | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(LICENSE_STORE, "readonly");
  return requestResult(transaction.objectStore(LICENSE_STORE).get(segmentId)) as Promise<CachedLicense | undefined>;
}

export async function putLicenses(licenses: CachedLicense[]): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(LICENSE_STORE, "readwrite");
  const store = transaction.objectStore(LICENSE_STORE);
  for (const license of licenses) {
    store.put(license);
  }
  await transactionDone(transaction);
}

export async function clearLicenses(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(LICENSE_STORE, "readwrite");
  transaction.objectStore(LICENSE_STORE).clear();
  await transactionDone(transaction);
}

export async function ensureWrappingKey(): Promise<CryptoKey> {
  const existing = await getMeta<CryptoKey>("wrappingKey");
  if (existing) {
    return existing;
  }
  const { createWrappingKey } = await import("./crypto.js");
  const created = await createWrappingKey();
  await putMeta("wrappingKey", created);
  return created;
}

export async function resetMediaCache(): Promise<void> {
  await Promise.all([clearSegments(), clearLicenses(), deleteMeta("cacheMeta")]);
}

export async function deleteLocalDatabase(): Promise<void> {
  const database = await openDatabase();
  database.close();
  databasePromise = null;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
