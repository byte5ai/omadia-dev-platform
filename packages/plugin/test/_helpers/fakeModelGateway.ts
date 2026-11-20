/**
 * The kernel's model gateway (`operatorJobs@1` + `modelPassthrough@1`, spec
 * 2042 §5.10), faked for the LLM-proxy suites. Only this fake holds a provider
 * key — exactly as only the kernel does in production.
 */

import type {
  ModelPassthroughService,
  OperatorJob,
  OperatorJobsService,
} from '../../src/host/modelGateway.js';

/** The instance's key. Only the FAKE KERNEL holds it — the proxy never sees it. */
export const INSTANCE_KEY = 'sk-ant-api03-INSTANCEKEY0123456789abcdefXYZ';

/** A recorded forward through the (fake) kernel passthrough. `headers` is what
 *  the PROXY handed the kernel; `upstreamHeaders` what the kernel would send. */
export interface FetchCall {
  url: string;
  headers: Record<string, string | undefined>;
  upstreamHeaders: Record<string, string>;
  body: string;
  job: OperatorJob;
  signal: AbortSignal | undefined;
}

export interface OpenedJob {
  input: Parameters<OperatorJobsService['open']>[0];
  job: OperatorJob;
  controller: AbortController;
  ended: Array<{ failed?: boolean; message?: string } | undefined>;
}

/** The kernel's model gateway, faked: `open` records and issues jobs; the
 *  passthrough applies the kernel's own header allowlist, adds the instance
 *  key and calls `upstream`. A rejection from `upstream` is a rejection of the
 *  forward (a refusal or a network failure). */
export function fakeModelGateway(upstream: (call: FetchCall, attempt: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const opened: OpenedJob[] = [];
  const operatorJobs: OperatorJobsService = {
    open: async (input) => {
      const controller = new AbortController();
      const ended: OpenedJob['ended'] = [];
      const job: OperatorJob = {
        id: `op-${String(opened.length + 1)}`,
        signal: controller.signal,
        end: async (outcome) => {
          ended.push(outcome);
        },
      };
      opened.push({ input, job, controller, ended });
      return job;
    },
  };
  const modelPassthrough: ModelPassthroughService = {
    forwardAnthropicMessages: async (input) => {
      const upstreamHeaders: Record<string, string> = { 'x-api-key': INSTANCE_KEY };
      for (const name of ['anthropic-version', 'anthropic-beta', 'accept', 'content-type']) {
        const v = input.headers[name];
        if (v) upstreamHeaders[name] = v;
      }
      const call: FetchCall = {
        url: `https://upstream.test/v1/messages${input.query ?? ''}`,
        headers: { ...input.headers },
        upstreamHeaders,
        body: typeof input.body === 'string' ? input.body : Buffer.from(input.body).toString('utf8'),
        job: input.job,
        signal: input.signal,
      };
      const attempt = calls.length;
      calls.push(call);
      return upstream(call, attempt);
    },
  };
  return { calls, opened, operatorJobs, modelPassthrough };
}

/** A named error shaped like the kernel's refusals (matched by `name`/`code`). */
export function kernelError(name: string, message: string, code?: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.name = name;
  if (code !== undefined) err.code = code;
  return err;
}
