// Not an arbitrary value — an ordinary-looking class that simply is not in the
// sheet core serves. Core's ingest scan does NOT catch this shape; only the
// whitelist diff does, which is the reason that diff exists.
const a = "flex items-center bg-blue-500 p-4";
export { a };
