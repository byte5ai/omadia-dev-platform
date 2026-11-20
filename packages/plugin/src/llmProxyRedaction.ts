/**
 * Response redaction for the LLM proxy — a provider credential must never be
 * handed to the job container the proxy exists to keep it away from.
 *
 * Until spec 2042 §5.10 the proxy held the provider key itself and scrubbed
 * that exact byte sequence. Now the KERNEL adds the instance's credentials
 * (`modelPassthrough@1`) and this plugin never sees them, so it cannot match
 * the exact key any more. It matches the SHAPE instead: an Anthropic
 * credential is `sk-ant-` followed by a long run of `[A-Za-z0-9_-]` (API keys
 * `sk-ant-api03-…`, OAuth tokens `sk-ant-oat01-…`). Anything of that shape in
 * a response body, streamed or buffered, success or error, becomes
 * `[REDACTED]` before it reaches the runner.
 *
 * The match runs on raw bytes through a latin1 round-trip (1:1 with bytes, so
 * arbitrary binary survives). The credential alphabet is ASCII, and ASCII
 * bytes never occur inside a multi-byte UTF-8 sequence, so matching the bytes
 * is matching the text.
 */

const KEY_PREFIX = 'sk-ant-';
/** Characters after the prefix before a run counts as a credential. Short
 *  enough for every real key, long enough that prose naming the prefix
 *  (`sk-ant-…`, `sk-ant-[a-z]+`) is left alone. */
const MIN_KEY_BODY = 20;
const KEY_PATTERN = new RegExp(`${KEY_PREFIX}[A-Za-z0-9_-]{${String(MIN_KEY_BODY)},}`, 'g');
const REDACTED = '[REDACTED]';

function isKeyChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

function redactLatin(latin: string): string {
  return latin.replace(KEY_PATTERN, REDACTED);
}

/** Redact every credential-shaped run in a complete (buffered) body. */
export function redactCredentials(buf: Buffer): Buffer {
  const latin = buf.toString('latin1');
  const redacted = redactLatin(latin);
  return redacted === latin ? buf : Buffer.from(redacted, 'latin1');
}

/**
 * Rolling redactor for the STREAMED response path. A credential can arrive
 * split over two chunks, so the redactor holds back the tail of a chunk that
 * could still be the start of one — a trailing run that contains `sk-ant-`
 * but is still too short to decide, or that ends in a proper prefix of
 * `sk-ant-` — and decides once the next chunk arrives. A run already long
 * enough to be a credential is redacted at once and the rest of it is
 * dropped as it streams in, so nothing is held without bound.
 */
export class StreamRedactor {
  private carry = '';
  /** Inside a credential already replaced by `[REDACTED]`: drop key chars. */
  private inKey = false;

  /** Feed one upstream chunk; return the bytes safe to write to the client now. */
  push(chunk: Buffer): Buffer {
    let text = this.carry + chunk.toString('latin1');
    this.carry = '';
    if (this.inKey) {
      let i = 0;
      while (i < text.length && isKeyChar(text[i])) i++;
      text = text.slice(i);
      if (text.length === 0) return Buffer.alloc(0);
      this.inKey = false;
    }

    // The trailing run of credential characters is the only part that can
    // still grow into a credential with the next chunk.
    let runStart = text.length;
    while (runStart > 0 && isKeyChar(text[runStart - 1])) runStart--;
    const run = text.slice(runStart);
    const keyAt = run.indexOf(KEY_PREFIX);

    if (keyAt !== -1) {
      const start = runStart + keyAt;
      const head = text.slice(0, start);
      if (text.length - start - KEY_PREFIX.length >= MIN_KEY_BODY) {
        // Already a credential: redact it now and drop the rest as it arrives.
        this.inKey = true;
        return Buffer.from(redactLatin(head) + REDACTED, 'latin1');
      }
      this.carry = text.slice(start);
      return Buffer.from(redactLatin(head), 'latin1');
    }

    for (let len = KEY_PREFIX.length - 1; len > 0; len--) {
      if (run.endsWith(KEY_PREFIX.slice(0, len))) {
        this.carry = text.slice(text.length - len);
        return Buffer.from(redactLatin(text.slice(0, text.length - len)), 'latin1');
      }
    }
    return Buffer.from(redactLatin(text), 'latin1');
  }

  /** Emit the held-back tail once the stream ended (too short to be a credential). */
  flush(): Buffer {
    const out = redactLatin(this.carry);
    this.carry = '';
    this.inKey = false;
    return Buffer.from(out, 'latin1');
  }
}
