// House style no linter rule covers: a return that follows other statements in its block needs a blank line before
// it, `--fix` inserts the blank line; a file that declares a class declares one, named as the file in
// kebab case.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";

const fix = process.argv.includes("--fix");
const roots = process.argv.slice(2).filter((a) => a !== "--fix");
const files = roots.flatMap((r) =>
  readdirSync(r, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(r, f)),
);

const statementsOf = (node) =>
  ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node) ? node.statements : null;
const needsBlank = (src, prev, ret) => !/\n[ \t]*\n/.test(src.text.slice(prev.getEnd(), ret.getStart(src)));
const kebab = (name) => name.replace(/(?<=[a-z0-9])([A-Z])/g, "-$1").toLowerCase();

const errors = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const cramped = [];
  const visit = (node) => {
    const statements = statementsOf(node);
    statements?.forEach((stmt, i) => {
      if (i > 0 && ts.isReturnStatement(stmt) && needsBlank(src, statements[i - 1], stmt))
        cramped.push(statements[i - 1]);
    });
    ts.forEachChild(node, visit);
  };
  visit(src);
  if (fix && cramped.length) {
    let out = text;
    for (const at of cramped.map((prev) => text.indexOf("\n", prev.getEnd()) + 1).toSorted((a, b) => b - a))
      out = out.slice(0, at) + "\n" + out.slice(at);
    writeFileSync(file, out);
    continue;
  }
  const lineOf = (pos) => src.getLineAndCharacterOfPosition(pos).line + 1;
  const classes = src.statements.filter((stmt) => ts.isClassDeclaration(stmt) && stmt.name);
  const stem = basename(file, ".ts");
  if (classes.length > 1)
    errors.push(`${file}:${lineOf(classes[1].getStart(src))}: one class per file; move ${classes[1].name.text} out`);
  else if (classes.length && kebab(classes[0].name.text) !== stem)
    errors.push(`${file}: holds class ${classes[0].name.text}, so name it ${kebab(classes[0].name.text)}.ts`);
  for (const prev of cramped) errors.push(`${file}:${lineOf(prev.getEnd()) + 1}: add a blank line before this return`);
}

for (const e of errors) console.error(e);
if (errors.length) process.exit(1);
