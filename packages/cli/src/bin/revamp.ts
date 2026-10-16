#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createPatch } from "diff";
import { scanProject } from "@revamp/core";
import {
  createInMemoryProject,
  loadSourceFile,
  enumerateAddressableNodes,
  addressKey,
  parseEditBatch,
  applyEditBatch,
  type EditBatch,
  type EditOp,
} from "@revamp/ast";
import { generateForProject } from "@revamp/generator";

const program = new Command();
program
  .name("revamp")
  .description(
    "Revamp Engine — scan a React project, discover addressable JSX, and apply a validated edit batch. " +
      "Nothing is written to disk unless `apply` is given --write."
  )
  .version("0.0.1");

program
  .command("scan")
  .argument("<projectPath>", "path to the React project to scan")
  .option("--json", "print the full scan result as JSON instead of a summary")
  .action((projectPath: string, opts: { json?: boolean }) => {
    const rootDir = path.resolve(process.cwd(), projectPath);
    const scan = scanProject(rootDir);

    if (opts.json) {
      console.log(JSON.stringify(scan, null, 2));
      return;
    }

    console.log(`\nrevamp scan — ${rootDir}\n`);

    console.log("stack");
    console.log(`  react           ${scan.stack.reactVersion ?? "not found"}`);
    console.log(`  build tool      ${scan.stack.buildTool}`);
    console.log(
      `  tailwind        ${scan.stack.tailwind.present ? `v${scan.stack.tailwind.major ?? "?"}` : "not found"}${
        scan.stack.tailwind.themeFile ? ` (theme: ${path.relative(rootDir, scan.stack.tailwind.themeFile)})` : ""
      }`
    );
    console.log(
      `  shadcn          ${scan.stack.shadcn.present ? `present (alias: ${scan.stack.shadcn.aliasComponents})` : "not found"}`
    );
    console.log(`  package manager ${scan.stack.packageManager}`);

    console.log("\nproduct brief");
    console.log(`  ${scan.productBrief.brief}`);

    console.log("\ncomponents");
    console.log(`  routes          ${scan.routeCount}`);
    console.log(`  shadcn primitives ${scan.primitiveCount}`);
    console.log(`  total found     ${scan.components.length}`);
    for (const c of scan.components) {
      const tag = c.isRoute ? "route" : c.isPrimitive ? "primitive" : "component";
      console.log(`    - ${c.name.padEnd(20)} [${tag}]${c.hooksUsed.length ? `  hooks: ${c.hooksUsed.join(", ")}` : ""}`);
    }

    console.log("\nlogic-skeleton fingerprints (this is what a revamp run must not move)");
    for (const f of scan.fileFingerprints) {
      console.log(`  ${f.hash.slice(0, 12)}…  ${f.relativePath}`);
    }
    console.log("");
  });

program
  .command("addresses")
  .description(
    "list every addressable JSX node in one component — the {root, path} values an edit batch's address fields need. " +
      "There's no other way to discover these; hand-guessing them is exactly the kind of mistake resolveAddress is designed to catch, loudly, rather than silently resolve to the wrong node."
  )
  .argument("<file>", "path to the .tsx/.jsx file")
  .argument("<componentName>", "the component's name (as it appears in source)")
  .option("--json", "print raw {address, fingerprint} objects as JSON instead of a summary")
  .action((filePath: string, componentName: string, opts: { json?: boolean }) => {
    const resolvedFile = path.resolve(process.cwd(), filePath);
    let source: string;
    try {
      source = readFileSync(resolvedFile, "utf8");
    } catch (err) {
      console.error(`Could not read ${resolvedFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const project = createInMemoryProject();
    const sourceFile = loadSourceFile(project, resolvedFile, source);
    const nodes = enumerateAddressableNodes(sourceFile, componentName);

    if (opts.json) {
      console.log(JSON.stringify(nodes.map((n) => ({ address: n.address, fingerprint: n.fingerprint })), null, 2));
      return;
    }

    if (nodes.length === 0) {
      console.log(
        `\nNo addressable JSX found for "${componentName}" in ${path.relative(process.cwd(), resolvedFile)}.\n` +
          `Either the component wasn't found under that name, or every JSX it returns is inside a .map()/ternary ` +
          `callback — see the addressing scope cut in docs/phase-1-edit-safety-layer.md.\n`
      );
      return;
    }

    console.log(`\nrevamp addresses — ${componentName} (${path.relative(process.cwd(), resolvedFile)})\n`);
    for (const n of nodes) {
      console.log(`  ${addressKey(n.address)}`);
      console.log(`    root: ${n.address.root}  path: [${n.address.path.join(", ")}]`);
      console.log(`    fingerprint: ${n.fingerprint}`);
    }
    console.log("");
  });

/** Every file-bearing field in a batch, resolved against the CLI's CWD the
 * same way — so a batch file can write any of these as relative paths
 * (the natural thing to do by hand) without the validator's
 * `address.file !== batch.file` cross-check failing just because one was
 * typed relative and another absolute. This is a CLI-only convenience:
 * the equality checks themselves stay exactly as strict in validator.ts —
 * a batch whose ops genuinely target different files still gets caught,
 * since each field is resolved independently. */
function resolveBatchPaths(batch: EditBatch, cwd: string): EditBatch {
  const resolve = (f: string) => path.resolve(cwd, f);
  const ops: EditOp[] = batch.ops.map((op) => {
    switch (op.op) {
      case "set_class_list":
      case "wrap_element":
        return { ...op, address: { ...op.address, file: resolve(op.address.file) } };
      case "insert_presentational":
        return { ...op, parentAddress: { ...op.parentAddress, file: resolve(op.parentAddress.file) } };
      case "set_cva_variants":
      case "add_import":
        return { ...op, file: resolve(op.file) };
    }
  });
  return { file: resolve(batch.file), ops };
}

program
  .command("apply")
  .description(
    "validate and apply an edit batch (a JSON file shaped like {file, ops: [...]}) to the file it targets. " +
      "Dry-run by default — prints a diff, writes nothing. Pass --write to actually land it."
  )
  .argument("<batchFile>", "path to a JSON file containing one edit batch")
  .option("--write", "write the result to disk (default: dry-run diff only)")
  .option("--json", "print the raw ApplyResult as JSON instead of a diff/summary")
  .action((batchFilePath: string, opts: { write?: boolean; json?: boolean }) => {
    const cwd = process.cwd();
    const resolvedBatchFile = path.resolve(cwd, batchFilePath);

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolvedBatchFile, "utf8"));
    } catch (err) {
      console.error(`Could not read/parse ${resolvedBatchFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    let batch: EditBatch;
    try {
      batch = parseEditBatch(raw);
    } catch (err) {
      // Duck-typed rather than `instanceof ZodError`: this package doesn't
      // depend on zod directly (only @revamp/ast does), and instanceof
      // across a package boundary is one more thing that can silently
      // break if versions ever diverge. A zod error's shape is stable.
      const issues = (err as { issues?: unknown }).issues;
      console.error(`Invalid edit batch (${resolvedBatchFile}):`);
      if (Array.isArray(issues)) {
        for (const issue of issues as { path?: unknown[]; message: string }[]) {
          console.error(`  - ${(issue.path ?? []).join(".") || "(root)"}: ${issue.message}`);
        }
      } else {
        console.error(`  ${(err as Error).message}`);
      }
      process.exitCode = 1;
      return;
    }

    batch = resolveBatchPaths(batch, cwd);
    const targetFile = batch.file;

    let originalSource: string;
    try {
      originalSource = readFileSync(targetFile, "utf8");
    } catch (err) {
      console.error(`Could not read target file ${targetFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const project = createInMemoryProject();
    const sourceFile = loadSourceFile(project, targetFile, originalSource);
    const result = applyEditBatch(sourceFile, targetFile, batch);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }

    const relPath = path.relative(cwd, targetFile);

    if (!result.ok) {
      console.error(`\nrevamp apply — rejected (${relPath})\n`);
      for (const e of result.errors) {
        console.error(`  [op ${e.opIndex}] ${e.op}: ${e.reason}`);
      }
      console.error("\nNothing was written.\n");
      process.exitCode = 1;
      return;
    }

    if (result.code === originalSource) {
      console.log(`\nrevamp apply — ${relPath} is already exactly this batch's result. Nothing to do.\n`);
      return;
    }

    console.log(
      createPatch(relPath, originalSource, result.code, "before", opts.write ? "after (written)" : "after (dry run)")
    );

    if (opts.write) {
      writeFileSync(targetFile, result.code);
      console.log(`Wrote ${relPath}.`);
    } else {
      console.log(`Dry run — nothing written. Pass --write to apply this change to ${relPath}.`);
    }
  });

program
  .command("generate")
  .description(
    "deterministically pick a design direction (color re-hueing + radius normalization — no AI involved) and " +
      "preview or apply it across a project. Dry-run by default; --write lands every generated batch."
  )
  .argument("<projectPath>", "path to the React project")
  .option("--write", "write every generated batch to disk (default: dry-run diff only)")
  .option("--json", "print the raw plan (direction + batches) as JSON instead of diffs")
  .action((projectPath: string, opts: { write?: boolean; json?: boolean }) => {
    const rootDir = path.resolve(process.cwd(), projectPath);
    const plan = generateForProject(rootDir);

    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    console.log(`\nrevamp generate — ${rootDir}`);
    console.log(
      `design direction: ${plan.direction.name} (neutral=${plan.direction.neutral}, primary=${plan.direction.primary}, danger=${plan.direction.danger}, radius=${plan.direction.radius})\n`
    );

    if (plan.batches.length === 0) {
      console.log("Every file already matches this direction — nothing to change.\n");
      return;
    }

    let anyRejected = false;
    for (const batch of plan.batches) {
      const relPath = path.relative(rootDir, batch.file);
      const originalSource = readFileSync(batch.file, "utf8");
      const project = createInMemoryProject();
      const sourceFile = loadSourceFile(project, batch.file, originalSource);
      const result = applyEditBatch(sourceFile, batch.file, batch);

      if (!result.ok) {
        anyRejected = true;
        console.error(`[${relPath}] rejected:`);
        for (const e of result.errors) console.error(`  [op ${e.opIndex}] ${e.op}: ${e.reason}`);
        continue;
      }
      if (result.code === originalSource) continue; // the generator already guards against this; kept as a second check, consistent with `apply`

      console.log(createPatch(relPath, originalSource, result.code, "before", opts.write ? "after (written)" : "after (dry run)"));
      if (opts.write) writeFileSync(batch.file, result.code);
    }

    console.log(
      opts.write
        ? `Wrote ${plan.batches.length} file(s).`
        : `Dry run — nothing written. Pass --write to apply ${plan.batches.length} file(s).`
    );
    if (anyRejected) process.exitCode = 1;
  });

program.parseAsync(process.argv);
