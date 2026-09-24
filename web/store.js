// Ключи устройства в IndexedDB. Запись идёт только при «запомнить это устройство»:
// на чужой машине всё остаётся в памяти вкладки.

const DB_NAME = 'web-clipboard';
const DB_STORE = 'kv';
const DB_KEY = 'device';

export function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadDevice() {
  try {
    const db = await openDb();
    return await tx(db, 'readonly', (s) => s.get(DB_KEY));
  } catch (err) {
    return null;
  }
}

// Решение «писать или нет» принимает вызывающий: сюда приходит уже готовая запись.
// Ошибку не глотаем — тому, кто вызвал, есть что сказать пользователю.
export async function saveDevice({ roomKey, encKey, seqs, deviceName, autoRefresh }) {
  const db = await openDb();
  await tx(db, 'readwrite',
    (s) => s.put({ roomKey, encKey, seqs, deviceName, autoRefresh }, DB_KEY));
}

export async function wipeDevice() {
  try {
    const db = await openDb();
    await tx(db, 'readwrite', (s) => s.delete(DB_KEY));
    db.close();
  } catch (err) { /* nothing worth reporting; the page reloads either way */ }
}
