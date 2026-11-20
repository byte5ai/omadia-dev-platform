import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { StreamRedactor, redactCredentials } from '../src/llmProxyRedaction.js';

/**
 * The proxy no longer holds the provider key (the kernel adds it), so it
 * redacts the SHAPE of an Anthropic credential. These pin the streaming
 * edges: a key split anywhere across chunks, a key longer than any chunk, and
 * prose that only names the prefix.
 */

const KEY = 'sk-ant-api03-Abc_def-0123456789ABCDEFGHIJKLMNOPqrstuvwxyz';

function streamThrough(chunks: string[]): string {
  const r = new StreamRedactor();
  const out = chunks.map((c) => r.push(Buffer.from(c, 'utf8')));
  out.push(r.flush());
  return Buffer.concat(out).toString('utf8');
}

describe('llmProxyRedaction', () => {
  it('redacts a credential in a buffered body and leaves other bytes intact', () => {
    const body = Buffer.from(`{"error":"bad key ${KEY}","ü":"ß"}`, 'utf8');
    assert.equal(redactCredentials(body).toString('utf8'), '{"error":"bad key [REDACTED]","ü":"ß"}');
  });

  it('catches a credential split at EVERY position across two chunks', () => {
    const text = `before ${KEY} after`;
    for (let cut = 1; cut < text.length; cut++) {
      const out = streamThrough([text.slice(0, cut), text.slice(cut)]);
      assert.equal(out, 'before [REDACTED] after', `cut at ${String(cut)}`);
    }
  });

  it('redacts a credential delivered one byte at a time', () => {
    const text = `x ${KEY} y`;
    assert.equal(streamThrough([...text]), 'x [REDACTED] y');
  });

  it('a credential running to the end of the stream is still redacted', () => {
    assert.equal(streamThrough(['tail ', KEY.slice(0, 30), KEY.slice(30)]), 'tail [REDACTED]');
  });

  it('leaves the bare prefix and short look-alikes alone', () => {
    const text = 'keys look like sk-ant-… or sk-ant-[a-z]+ or sk-ant-short';
    assert.equal(streamThrough([text.slice(0, 20), text.slice(20)]), text);
    assert.equal(redactCredentials(Buffer.from(text)).toString(), text);
  });

  it('keeps multi-byte UTF-8 intact across a held-back boundary', () => {
    const text = 'ä sk-an'; // ends in a prefix of the credential prefix → held back
    assert.equal(streamThrough([text, 'd ö']), 'ä sk-and ö');
  });
});
