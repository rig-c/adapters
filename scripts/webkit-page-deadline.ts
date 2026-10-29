/** Bound page creation independently of the enclosing Playwright test timeout. */
export async function webkitPageDeadline<T>(pending: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`newPage did not resolve within ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } catch (error) {
    throw new Error(`POOL_WEBKIT_NEWPAGE: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
