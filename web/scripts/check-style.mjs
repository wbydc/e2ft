// House style no linter rule covers: a return that follows other statements in its block needs a blank line before
// it, `--fix` inserts the blank line; a file that declares a class declares one, named as the file in
// kebab case.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseSync } from "oxc-parser";

const fix = process.argv.includes("--fix");
const roots = process.argv.slice(2).filter((a) => a !== "--fix");
const files = roots.flatMap((r) =>
  readdirSync(r, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(r, f)),
);

const statementsOf = (node) =>
  node.type === "BlockStatement" || node.type === "StaticBlock"
    ? node.body
    : node.type === "SwitchCase"
      ? node.consequent
      : null;
const isNode = (value) => typeof value?.type === "string";
const children = (node) =>
  Object.values(node).flatMap((value) => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []));
const needsBlank = (text, prev, ret) => !/\n[ \t]*\n/.test(text.slice(prev.end, ret.start));
const kebab = (name) => name.replace(/(?<=[a-z0-9])([A-Z])/g, "-$1").toLowerCase();

const errors = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const { program } = parseSync(file, text);
  const cramped = [];
  const visit = (node) => {
    const statements = statementsOf(node);
    statements?.forEach((stmt, i) => {
      if (i > 0 && stmt.type === "ReturnStatement" && needsBlank(text, statements[i - 1], stmt))
        cramped.push(statements[i - 1]);
    });
    children(node).forEach(visit);
  };
  visit(program);
  if (fix && cramped.length) {
    let out = text;
    for (const at of cramped.map((prev) => text.indexOf("\n", prev.end) + 1).toSorted((a, b) => b - a))
      out = out.slice(0, at) + "\n" + out.slice(at);
    writeFileSync(file, out);
    continue;
  }

  const lineOf = (pos) => text.slice(0, pos).split("\n").length;
  const classes = program.body
    .map((stmt) => (stmt.type.startsWith("Export") ? stmt.declaration : stmt))
    .filter((stmt) => stmt?.type === "ClassDeclaration" && stmt.id);
  const stem = basename(file, ".ts");
  if (classes.length > 1)
    errors.push(`${file}:${lineOf(classes[1].start)}: one class per file; move ${classes[1].id.name} out`);
  else if (classes.length && kebab(classes[0].id.name) !== stem)
    errors.push(`${file}: holds class ${classes[0].id.name}, so name it ${kebab(classes[0].id.name)}.ts`);
  for (const prev of cramped) errors.push(`${file}:${lineOf(prev.end) + 1}: add a blank line before this return`);
}

for (const e of errors) console.error(e);
if (errors.length) process.exit(1);
