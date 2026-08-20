import { parseArtifactRecord } from '@/lib/prettyArtifact';

/**
 * Epic #470 — a readable render of a JSON artifact (plan, analysis,
 * bootstrap_report, ...) instead of its raw text. Fully generic per field:
 * a string renders as a wrapped paragraph (real line breaks now that JSON
 * parsing has turned `\n` escapes into actual newline characters — the raw
 * text view showed them as literal backslash-n), a string array as a bullet
 * list, anything else as a small indented JSON block. Falls back to the raw
 * text verbatim when it isn't parseable JSON or isn't a plain object at the
 * top level — never worse than the previous behavior.
 */
export function PrettyArtifact({ text }: { text: string }): React.ReactElement {
  const record = parseArtifactRecord(text);
  if (!record) {
    return (
      <pre className="whitespace-pre-wrap rounded-lg border-t border-r border-b border-l border-border bg-bg-soft p-3 font-mono text-xs leading-normal text-fg">
        {text}
      </pre>
    );
  }

  return (
    <dl className="flex flex-col gap-3 rounded-lg border-t border-r border-b border-l border-border bg-bg-soft p-3">
      {Object.entries(record).map(([key, value]) => (
        <div key={key}>
          <dt className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {key}
          </dt>
          <dd className="mt-1">{renderValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderValue(value: unknown): React.ReactElement {
  if (typeof value === 'string') {
    return <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg">{value}</p>;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return (
      <ul className="list-disc space-y-1 pl-4 font-mono text-xs text-fg">
        {value.map((v: string, i) => (
          <li key={i}>{v}</li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return <span className="font-mono text-xs text-fg">{String(value)}</span>;
  }
  if (value === null || value === undefined) {
    return <span className="text-xs text-fg-subtle">—</span>;
  }
  return (
    <pre className="whitespace-pre-wrap rounded border-t border-r border-b border-l border-border px-2 py-1 font-mono text-xs text-fg-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
