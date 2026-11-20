/**
 * Usage metering for the LLM proxy: pull Anthropic `usage` numbers out of a
 * streamed (SSE) or buffered (JSON) Messages response. Metering reads the raw
 * upstream bytes; what reaches the runner is the redacted copy.
 */

export interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  seen: boolean;
}

export function newUsage(): UsageAccumulator {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, seen: false };
}

/** Pull Anthropic `usage` numbers out of a parsed event/body object. `message_start`
 *  carries input + cache + initial output; `message_delta` carries cumulative output;
 *  a non-streamed JSON body carries the final totals top-level. */
export function applyUsage(acc: UsageAccumulator, u: unknown): void {
  if (!u || typeof u !== 'object') return;
  const r = u as Record<string, unknown>;
  if (typeof r['input_tokens'] === 'number') {
    acc.inputTokens = r['input_tokens'];
    acc.seen = true;
  }
  if (typeof r['output_tokens'] === 'number') {
    acc.outputTokens = r['output_tokens'];
    acc.seen = true;
  }
  if (typeof r['cache_read_input_tokens'] === 'number') {
    acc.cacheReadTokens = r['cache_read_input_tokens'];
    acc.seen = true;
  }
  if (typeof r['cache_creation_input_tokens'] === 'number') {
    acc.cacheCreationTokens = r['cache_creation_input_tokens'];
    acc.seen = true;
  }
}

/** Feed one parsed SSE `data:` JSON object into the accumulator. */
function ingestSseData(acc: UsageAccumulator, data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  const type = d['type'];
  if (type === 'message_start') {
    const msg = d['message'];
    if (msg && typeof msg === 'object') applyUsage(acc, (msg as Record<string, unknown>)['usage']);
  } else if (type === 'message_delta') {
    applyUsage(acc, d['usage']);
  }
}

/** Stateful SSE splitter: events are separated by a blank line; each `data:` line
 *  holds JSON. Returns the unconsumed tail to prepend to the next chunk. */
export function drainSse(acc: UsageAccumulator, buffer: string): string {
  let idx: number;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const block = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    try {
      ingestSseData(acc, JSON.parse(dataLines.join('\n')));
    } catch {
      /* partial/non-JSON event — ignore for metering, still passed through verbatim */
    }
  }
  return buffer;
}
