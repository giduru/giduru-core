#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type {
  LedgerAnalysis,
  LedgerDiagnostic,
  LedgerSourceDocument,
} from 'giduru-core';

const { version } = require('../../package.json') as { version: string };

const LEDGER_EXTENSIONS = new Set(['.hledger', '.journal', '.ledger']);
const IGNORED_DIRECTORIES = new Set(['.git', 'dist', 'node_modules']);

type CommandResult = {
  exitCode: number;
  stderr?: string;
  stdout?: string;
};

type AnalyzeCommandOptions = {
  compact: boolean;
  rootFilePath: string;
};

export async function main(argv = process.argv.slice(2)) {
  const result = await runCli(argv);

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.exitCode;
}

export async function runCli(argv: string[]): Promise<CommandResult> {
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    return {
      exitCode: 0,
      stdout: buildHelpText(),
    };
  }

  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    return {
      exitCode: 0,
      stdout: `${version}\n`,
    };
  }

  const [command, ...args] = argv;

  try {
    switch (command) {
      case 'analyze':
        return await runAnalyzeCommand(args);
      case 'check':
        return await runCheckCommand(args);
      default:
        return {
          exitCode: 1,
          stderr: `Unknown command "${command}".\n\n${buildHelpText()}`,
        };
    }
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `${formatUnexpectedError(error)}\n`,
    };
  }
}

async function runAnalyzeCommand(args: string[]): Promise<CommandResult> {
  const options = parseAnalyzeCommandArgs(args);

  if (typeof options === 'string') {
    return {
      exitCode: 1,
      stderr: `${options}\n\n${buildHelpText()}`,
    };
  }

  const analysis = await analyzeRootFile(options.rootFilePath);
  return {
    exitCode: hasErrorDiagnostics(analysis.diagnostics) ? 1 : 0,
    stdout: `${JSON.stringify(analysis, null, options.compact ? 0 : 2)}\n`,
  };
}

async function runCheckCommand(args: string[]): Promise<CommandResult> {
  const parsed = parseSingleRootFileArg('check', args);

  if ('error' in parsed) {
    return {
      exitCode: 1,
      stderr: `${parsed.error}\n\n${buildHelpText()}`,
    };
  }

  const analysis = await analyzeRootFile(parsed.rootFilePath);
  const counts = countDiagnosticsBySeverity(analysis.diagnostics);

  if (analysis.diagnostics.length === 0) {
    return {
      exitCode: 0,
      stdout: 'No diagnostics.\n',
    };
  }

  return {
    exitCode: counts.error > 0 ? 1 : 0,
    stderr: `${analysis.diagnostics.map(formatDiagnostic).join('\n')}\n`,
    stdout: `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info message(s).\n`,
  };
}

function parseAnalyzeCommandArgs(args: string[]) {
  let compact = false;
  let rootFilePath = '';

  for (const arg of args) {
    if (arg === '--compact') {
      compact = true;
      continue;
    }

    if (arg.startsWith('-')) {
      return `Unknown analyze option "${arg}".`;
    }

    if (rootFilePath) {
      return 'Usage: giduru analyze <root-file> [--compact]';
    }

    rootFilePath = arg;
  }

  if (!rootFilePath) {
    return 'Usage: giduru analyze <root-file> [--compact]';
  }

  return {
    compact,
    rootFilePath,
  } satisfies AnalyzeCommandOptions;
}

function parseSingleRootFileArg(command: 'check', args: string[]) {
  if (args.length !== 1 || args[0]?.startsWith('-')) {
    return {
      error: `Usage: giduru ${command} <root-file>`,
    } as const;
  }

  return {
    rootFilePath: args[0],
  } as const;
}

async function analyzeRootFile(rootFilePath: string): Promise<LedgerAnalysis> {
  const absoluteRootPath = path.resolve(rootFilePath);
  const rootStat = await stat(absoluteRootPath).catch(() => null);

  if (!rootStat?.isFile()) {
    throw new Error(`Ledger root file not found: ${absoluteRootPath}`);
  }

  const documents = await loadLedgerDocuments(absoluteRootPath);
  const { analyzeLedgerDocuments } = await import('giduru-core');
  const { analysis } = await analyzeLedgerDocuments(documents, {
    rootFilePaths: [absoluteRootPath],
    verifyOptions: {
      availableFilePaths: Array.from(documents.keys()),
      rootFilePaths: [absoluteRootPath],
    },
  });

  return analysis;
}

async function loadLedgerDocuments(rootFilePath: string) {
  const scanRoot = selectScanRoot(rootFilePath);
  const discoveredPaths = await collectLedgerFiles(scanRoot);
  const filePaths = sortUnique([rootFilePath, ...discoveredPaths]);
  const documents = new Map<string, LedgerSourceDocument>();

  for (const filePath of filePaths) {
    documents.set(filePath, {
      content: await readFile(filePath, 'utf8'),
      isLedger: true,
      name: path.basename(filePath),
      path: filePath,
    });
  }

  return documents;
}

async function collectLedgerFiles(rootDirectory: string) {
  const discovered: string[] = [];

  const visit = async (directoryPath: string): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }

        await visit(path.join(directoryPath, entry.name));
        continue;
      }

      if (!entry.isFile() || !hasLedgerExtension(entry.name)) {
        continue;
      }

      discovered.push(path.join(directoryPath, entry.name));
    }
  };

  await visit(rootDirectory);
  return discovered;
}

function selectScanRoot(rootFilePath: string) {
  const cwd = process.cwd();

  if (rootFilePath === cwd || rootFilePath.startsWith(`${cwd}${path.sep}`)) {
    return cwd;
  }

  return path.dirname(rootFilePath);
}

function hasLedgerExtension(filePath: string) {
  return LEDGER_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function sortUnique(values: string[]) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function hasErrorDiagnostics(diagnostics: LedgerDiagnostic[]) {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function countDiagnosticsBySeverity(diagnostics: LedgerDiagnostic[]) {
  return diagnostics.reduce(
    (counts, diagnostic) => {
      counts[diagnostic.severity] += 1;
      return counts;
    },
    { error: 0, info: 0, warning: 0 },
  );
}

function formatDiagnostic(diagnostic: LedgerDiagnostic) {
  const relativePath = path.relative(process.cwd(), diagnostic.path) || diagnostic.path;
  const lineSuffix = diagnostic.line != null ? `:${diagnostic.line}` : '';

  return `${diagnostic.severity.toUpperCase()} ${relativePath}${lineSuffix} ${diagnostic.message}`;
}

function buildHelpText() {
  return `giduru-cli ${version}

Usage:
  giduru analyze <root-file> [--compact]
  giduru check <root-file>
  giduru --version
  giduru --help
`;
}

function formatUnexpectedError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

if (require.main === module) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${formatUnexpectedError(error)}\n`);
    process.exitCode = 1;
  });
}
