import type { CachedAiRowMap } from "./ai-breaker";
import type {
  BatchMasterQueue,
  ImportedSubtitleSheet,
  SubtitleLineBreakRun,
} from "./types";

const DB_NAME = "text_org_linebreak_checkpoints_v1";
const DB_VERSION = 2;
const STORE_ROWS = "row_ai_caches";
const STORE_BATCH = "batch_queue_state";
const STORE_ITEM_DATA = "batch_item_preview_data";
const BATCH_KEY = "active_batch_queue";

const memoryRowFallback = new Map<string, CachedAiRowMap>();
let memoryBatchFallback: BatchMasterQueue | null = null;
const memoryItemDataFallback = new Map<
  string,
  { sheet: ImportedSubtitleSheet; run: SubtitleLineBreakRun }
>();

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_ROWS)) {
          db.createObjectStore(STORE_ROWS);
        }
        if (!db.objectStoreNames.contains(STORE_BATCH)) {
          db.createObjectStore(STORE_BATCH);
        }
        if (!db.objectStoreNames.contains(STORE_ITEM_DATA)) {
          db.createObjectStore(STORE_ITEM_DATA);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function buildSheetCheckpointKey(
  docIdOrFile: string,
  sheetIdOrName: string | number,
  langCode: string,
): string {
  return `${docIdOrFile}::${sheetIdOrName}::${langCode}`;
}

export async function saveSheetAiCheckpoint(
  key: string,
  cache: CachedAiRowMap,
): Promise<void> {
  memoryRowFallback.set(key, cache);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_ROWS, "readwrite");
      tx.objectStore(STORE_ROWS).put(cache, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadSheetAiCheckpoint(
  key: string,
): Promise<CachedAiRowMap | null> {
  const db = await openDb();
  if (!db) {
    return memoryRowFallback.get(key) ?? null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_ROWS, "readonly");
      const req = tx.objectStore(STORE_ROWS).get(key);
      req.onsuccess = () =>
        resolve((req.result as CachedAiRowMap | undefined) ?? memoryRowFallback.get(key) ?? null);
      req.onerror = () => resolve(memoryRowFallback.get(key) ?? null);
    } catch {
      resolve(memoryRowFallback.get(key) ?? null);
    }
  });
}

export async function clearSheetAiCheckpoint(key: string): Promise<void> {
  memoryRowFallback.delete(key);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_ROWS, "readwrite");
      tx.objectStore(STORE_ROWS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function saveBatchItemPreviewBundle(
  itemId: string,
  sheet: ImportedSubtitleSheet,
  run: SubtitleLineBreakRun,
): Promise<void> {
  memoryItemDataFallback.set(itemId, { sheet, run });
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_ITEM_DATA, "readwrite");
      tx.objectStore(STORE_ITEM_DATA).put({ sheet, run }, itemId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadBatchItemPreviewBundle(
  itemId: string,
): Promise<{ sheet: ImportedSubtitleSheet; run: SubtitleLineBreakRun } | null> {
  const db = await openDb();
  if (!db) return memoryItemDataFallback.get(itemId) ?? null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_ITEM_DATA, "readonly");
      const req = tx.objectStore(STORE_ITEM_DATA).get(itemId);
      req.onsuccess = () =>
        resolve(
          (req.result as { sheet: ImportedSubtitleSheet; run: SubtitleLineBreakRun } | undefined) ??
            memoryItemDataFallback.get(itemId) ??
            null,
        );
      req.onerror = () => resolve(memoryItemDataFallback.get(itemId) ?? null);
    } catch {
      resolve(memoryItemDataFallback.get(itemId) ?? null);
    }
  });
}

export async function clearAllBatchPreviewBundles(): Promise<void> {
  memoryItemDataFallback.clear();
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_ITEM_DATA, "readwrite");
      tx.objectStore(STORE_ITEM_DATA).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function saveBatchQueueCheckpoint(
  queue: BatchMasterQueue | null,
): Promise<void> {
  if (!queue) {
    memoryBatchFallback = null;
    await clearAllBatchPreviewBundles();
  } else {
    memoryBatchFallback = {
      ...queue,
      items: queue.items.map((it) => ({
        ...it,
        cachedSheet: undefined,
        cachedRun: undefined,
      })),
    };
  }
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_BATCH, "readwrite");
      const st = tx.objectStore(STORE_BATCH);
      if (!memoryBatchFallback) {
        st.delete(BATCH_KEY);
      } else {
        st.put(memoryBatchFallback, BATCH_KEY);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadBatchQueueCheckpoint(): Promise<BatchMasterQueue | null> {
  const db = await openDb();
  if (!db) return memoryBatchFallback;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_BATCH, "readonly");
      const req = tx.objectStore(STORE_BATCH).get(BATCH_KEY);
      req.onsuccess = async () => {
        const loaded = (req.result as BatchMasterQueue | undefined) ?? null;
        if (!loaded) {
          resolve(null);
          return;
        }
        for (const it of loaded.items) {
          if (it.status === "running") {
            it.status = "paused_key";
            it.errorMessage = "上次运行中断，点击「继续接续处理」可从断点续跑";
          }
          const bundle = await loadBatchItemPreviewBundle(it.id);
          if (bundle) {
            it.cachedSheet = bundle.sheet;
            it.cachedRun = bundle.run;
          }
        }
        resolve(loaded);
      };
      req.onerror = () => resolve(memoryBatchFallback);
    } catch {
      resolve(memoryBatchFallback);
    }
  });
}
