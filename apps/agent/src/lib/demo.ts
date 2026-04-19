/**
 * Small demo/timing helpers used by the workspace state handlers.
 *
 * `wait(ms)` is a cancellation-unaware delay (fine for the DO's serial pump).
 * `withTimeout(promise, ms, label)` races a promise against a timer and
 * rejects with a labelled error when the timer wins. Keeping both here so
 * state handlers can stay linear without sprinkling bare `setTimeout`s.
 */

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
