/**
 * Gzipped JSON dictionary loader using the Web Streams `DecompressionStream('gzip')` API.
 * Works natively in both Chrome Manifest V3 Service Workers and Node.js 20+.
 */

/**
 * Decompresses a gzip `ReadableStream<Uint8Array>` and parses it as JSON.
 *
 * @param {ReadableStream<Uint8Array>} compressedStream
 * @returns {Promise<Record<string, Array<[string, number[]?, number?]>>>}
 */
export async function decompressJsonStream(compressedStream) {
  const decompressed = compressedStream.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(decompressed).json();
}

/**
 * Creates a memoized dictionary loader so concurrent lookup calls share one single load Promise.
 *
 * @param {() => Promise<ReadableStream<Uint8Array>>} getCompressedStream
 */
export function createCachedDictLoader(getCompressedStream) {
  /** @type {Promise<Record<string, Array<[string, number[]?, number?]>>> | null} */
  let cachedPromise = null;

  return function getDict() {
    if (!cachedPromise) {
      cachedPromise = (async () => {
        try {
          const stream = await getCompressedStream();
          return await decompressJsonStream(stream);
        } catch (err) {
          cachedPromise = null;
          throw err;
        }
      })();
    }
    return cachedPromise;
  };
}
