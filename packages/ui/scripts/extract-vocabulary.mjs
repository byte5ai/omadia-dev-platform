#!/usr/bin/env node
/**
 * extract-vocabulary.mjs — regenerate `vocabulary/classes.txt` from core's
 * generated plugin stylesheet.
 *
 *     node scripts/extract-vocabulary.mjs \
 *       ../odoo-bot/middleware/assets/plugin-ui/plugin-ui.css \
 *       vocabulary/classes.txt
 *
 * The vocabulary is read out of the COMPILED stylesheet rather than expanded
 * from the `@source inline("{p,px,py}-{0..12}")` declarations that produced
 * it. A brace expander written here would be a second implementation of
 * Tailwind's, and the two would drift silently in the permissive direction —
 * the failure mode this whole gate exists to prevent. The selectors in the
 * artifact are what a browser will actually match, so they are the answer.
 *
 * Escapes are unescaped on the way out: Tailwind writes `.hover\:bg-accent`
 * and `.max-w-2xl`, and the class ATTRIBUTE that matches them contains
 * `hover:bg-accent`. Comparing escaped selectors against attribute text would
 * reject every variant class in the bundle.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Pull every class selector out of a stylesheet.
 *
 * Naively globbing `/\.([\w-]+)/` over the whole file also matches the `.25`
 * in `padding: 0.25rem` and the `.5` in `margin: .5em`, which would seed the
 * whitelist with junk tokens like `25rem`. So the file is walked and only the
 * text that PRECEDES an opening brace — the selector — is examined. Anything
 * after a `;` or inside a declaration block is discarded.
 *
 * @param {string} css
 * @returns {string[]} sorted, unescaped class names
 */
export function extractClasses(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  /** @type {string[]} */
  const selectors = [];
  let buf = '';
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') {
      selectors.push(buf);
      depth += 1;
      buf = '';
    } else if (ch === '}') {
      depth -= 1;
      buf = '';
    } else if (ch === ';') {
      buf = '';
    } else {
      buf += ch;
    }
  }

  const set = new Set();
  // A class starts the selector or follows a combinator/comma/paren — never a
  // digit, which is what keeps decimal values out.
  const CLASS = /(?:^|[\s,>+~()])\.((?:[A-Za-z0-9_-]|\\.)+)/g;
  for (const selector of selectors) {
    if (selector.trimStart().startsWith('@')) continue;
    CLASS.lastIndex = 0;
    let m;
    while ((m = CLASS.exec(` ${selector}`)) !== null) {
      set.add(m[1].replace(/\\(.)/g, '$1'));
    }
  }
  return [...set].sort();
}

const [, , input, output] = process.argv;
if (input && output) {
  const classes = extractClasses(readFileSync(input, 'utf8'));
  if (classes.length < 100) {
    // A parse that quietly produced almost nothing would write an empty
    // whitelist, and an empty whitelist rejects the entire bundle rather than
    // accepting it — loud, but for the wrong reason. Say what happened.
    throw new Error(
      `only ${classes.length} classes extracted from ${input} — that is not a plugin-ui stylesheet`,
    );
  }
  writeFileSync(output, `${classes.join('\n')}\n`);
  console.log(`wrote ${classes.length} classes to ${output}`);
}
