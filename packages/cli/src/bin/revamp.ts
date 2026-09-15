#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { scanProject } from "@revamp/core";

const program = new Command();
program
  .name("revamp")
  .description("Revamp Engine — Phase 0: scan a React project and fingerprint it. Never writes anything.")
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

program.parseAsync(process.argv);
