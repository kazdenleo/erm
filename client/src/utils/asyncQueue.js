/**
 * Очередь async-задач с ограничением параллелизма (снижает шторм запросов к API).
 * @param {number} maxConcurrent
 */
export function createAsyncQueue(maxConcurrent = 3) {
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < maxConcurrent && queue.length > 0) {
      active += 1;
      const { task, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}
