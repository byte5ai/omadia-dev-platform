/**
 * `ApiError` — ported from `web-ui/app/_lib/api.ts`.
 *
 * The dev-platform pages imported exactly one name from core's 4,827-line
 * browser API client: this class. Porting the class rather than the module is
 * the whole of that dependency, and it is the difference between this package
 * owning ~30 lines and owning core's entire fetch layer.
 *
 * `body` is the raw response text, kept unparsed because callers need it two
 * ways: `devPlatformErrorCode()` reads a `{ code }` field out of it, and the
 * panels show it verbatim when there is no code to read.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
