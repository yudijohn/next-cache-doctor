#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const { runScan } = require('../src/index');
const pkg = require('../package.json');

const program = new Command();

program
  .name('next-cache-doctor')
  .description(
    "Static analysis for Next.js 'use cache' directive: catches missing cacheLife and possible private-data leaks."
  )
  .version(pkg.version);

program
  .command('scan')
  .description("Scan a directory for 'use cache' issues")
  .argument('[path]', 'directory to scan', '.')
  .option('--json', 'output raw JSON instead of a formatted report')
  .option('--fail-on <level>', "exit non-zero if findings of this severity exist: 'error' or 'warning'", 'error')
  .action(async (targetPath, options) => {
    try {
      const { findings, filesScanned, filesWithCache } = await runScan(targetPath);

      if (options.json) {
        console.log(JSON.stringify({ findings, filesScanned, filesWithCache }, null, 2));
      } else {
        printReport(findings, filesScanned, filesWithCache);
      }

      const errorCount = findings.filter((f) => f.severity === 'error').length;
      const warningCount = findings.filter((f) => f.severity === 'warning').length;

      if (options.failOn === 'warning' && (errorCount > 0 || warningCount > 0)) {
        process.exitCode = 1;
      } else if (errorCount > 0) {
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(chalk.red(`next-cache-doctor: ${err.message}`));
      process.exitCode = 2;
    }
  });

function printReport(findings, filesScanned, filesWithCache) {
  console.log('');
  console.log(chalk.bold(`next-cache-doctor`) + chalk.dim(` v${pkg.version}`));
  console.log(
    chalk.dim(`Scanned ${filesScanned} file(s), ${filesWithCache} contain a 'use cache' scope.`)
  );
  console.log('');

  if (findings.length === 0) {
    console.log(chalk.green('✓ No issues found. Every cache scope looks explicit and safe.'));
    console.log('');
    return;
  }

  const byFile = groupBy(findings, (f) => f.file);
  for (const [file, items] of Object.entries(byFile)) {
    console.log(chalk.underline(file));
    for (const item of items.sort((a, b) => a.line - b.line)) {
      const badge =
        item.severity === 'error'
          ? chalk.bgRed.black(' ERROR ')
          : chalk.bgYellow.black(' WARN  ');
      console.log(`  ${badge} ${chalk.dim(`L${item.line}`)}  ${chalk.dim(`[${item.rule}]`)}`);
      console.log(`         ${item.message}`);
    }
    console.log('');
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  console.log(
    chalk.bold(
      `${errorCount} error(s), ${warningCount} warning(s) across ${Object.keys(byFile).length} file(s).`
    )
  );
  console.log('');
}

function groupBy(list, keyFn) {
  return list.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] = acc[key] || []).push(item);
    return acc;
  }, {});
}

program.parse();
