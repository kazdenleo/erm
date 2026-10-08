/**
 * Сессионные advisory-lock PostgreSQL на выделенном соединении.
 */
import { getClient } from '../config/database.js';

/**
 * Сессионный lock принадлежит одному соединению: lock и unlock обязаны идти через один
 * client. Через pool.query unlock попадает на другое соединение, ничего не снимает,
 * и lock залипает в пуле. Соединение занято, пока не вызван release().
 *
 * @param {...number} keys один bigint-ключ или пара integer-ключей
 * @returns {Promise<(() => Promise<void>) | null>} release() или null, если lock занят
 */
export async function trySessionAdvisoryLock(...keys) {
  const pair = keys.length === 2;
  const lockSql = pair
    ? 'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS ok'
    : 'SELECT pg_try_advisory_lock($1::bigint) AS ok';
  const unlockSql = pair
    ? 'SELECT pg_advisory_unlock($1::integer, $2::integer)'
    : 'SELECT pg_advisory_unlock($1::bigint)';

  const client = await getClient();
  try {
    const r = await client.query(lockSql, keys);
    if (r.rows?.[0]?.ok !== true) {
      client.release();
      return null;
    }
  } catch (e) {
    client.release();
    throw e;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query(unlockSql, keys);
    } catch {
      /* ignore */
    } finally {
      client.release();
    }
  };
}
