import { basename, dirname, extname, join, resolve } from 'path';
import { blue, gray, green, red, yellow } from 'colorette';
import { performance } from "perf_hooks";
import * as glob from 'glob-promise';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Writable } from 'stream';
import {
  BundleOutputFormat,
  Config,
  LintConfig,
  NormalizedProblem,
  ResolveError,
  YamlParseError,
} from '@redocly/openapi-core';
import { Totals, outputExtensions } from './types';

export async function getFallbackEntryPointsOrExit(argsEntrypoints: string[] | undefined, config: Config) {
  const { apiDefinitions } = config;
  const shouldFallbackToAllDefinitions = !isNotEmptyArray(argsEntrypoints) && apiDefinitions && Object.keys(apiDefinitions).length > 0;
  const res = shouldFallbackToAllDefinitions
    ? Object.values(apiDefinitions).map((fileName) => resolve(getConfigDirectory(config), fileName))
    : await expandGlobsInEntrypoints(argsEntrypoints!, config);

  if (!isNotEmptyArray(res)) {
    process.stderr.write('error: missing required argument `entrypoints`.\n');
    process.exit(1);
  }
  return res;
}

function getConfigDirectory(config: Config) {
  return config.configFile ? dirname(config.configFile) : process.cwd();
}

function isNotEmptyArray(args?: string[]): boolean {
  return Array.isArray(args) && !!args.length;
}
function getAliasOrPath(config: Config, aliasOrPath: string) {
  return config.apiDefinitions[aliasOrPath] || aliasOrPath;
}

async function expandGlobsInEntrypoints(args: string[], config: Config) {
  return (await Promise.all((args as string[]).map(async aliasOrPath => {
    return glob.hasMagic(aliasOrPath)
      ? (await glob(aliasOrPath)).map((g: string) => getAliasOrPath(config, g))
      : getAliasOrPath(config, aliasOrPath);
  }))).flat();
}

export function getTotals(problems: (NormalizedProblem & { ignored?: boolean })[]): Totals {
  let errors = 0;
  let warnings = 0;
  let ignored = 0;

  for (const m of problems) {
    if (m.ignored) {
      ignored++;
      continue;
    }
    if (m.severity === 'error') errors++;
    if (m.severity === 'warn') warnings++;
  }

  return {
    errors,
    warnings,
    ignored,
  };
}

export function getExecutionTime(startedAt: number) {
  return process.env.NODE_ENV === 'test'
    ? '<test>ms'
    : `${Math.ceil(performance.now() - startedAt)}ms`;
}

export function printExecutionTime(commandName: string, startedAt: number, entrypoint: string) {
  const elapsed = getExecutionTime(startedAt);
  process.stderr.write(gray(`\n${entrypoint}: ${commandName} processed in ${elapsed}\n\n`));
}

export function pathToFilename(path: string) {
  return path
    .replace(/~1/g, '/')
    .replace(/~0/g, '~')
    .substring(1)
    .replace(/\//g, '@');
}

export class CircularJSONNotSupportedError extends Error {
  constructor(public originalError: Error) {
    super(originalError.message);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, CircularJSONNotSupportedError.prototype);
  }
}

export function dumpBundle(obj: any, format: BundleOutputFormat, dereference?: boolean): string {
  if (format === 'json') {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (e) {
      if (e.message.indexOf('circular') > -1) {
        throw new CircularJSONNotSupportedError(e);
      }
      throw e;
    }
  } else {
    return yaml.safeDump(obj, {
      noRefs: !dereference,
    });
  }
}

export function saveBundle(filename: string, output: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, output);
}

export async function promptUser(query: string, hideUserInput = false): Promise<string> {
  return new Promise((resolve) => {
    let output: Writable = process.stdout;
    let isOutputMuted = false;

    if (hideUserInput) {
      output = new Writable({
        write: (chunk, encoding, callback) => {
          if (!isOutputMuted) {
            process.stdout.write(chunk, encoding);
          }
          callback();
        },
      });
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output,
      terminal: true,
      historySize: hideUserInput ? 0 : 30,
    });

    rl.question(`${query}:\n\n  `, (answer) => {
      rl.close();
      resolve(answer);
    });

    isOutputMuted = hideUserInput;
  });
}

export function readYaml(filename: string) {
  return yaml.safeLoad(fs.readFileSync(filename, 'utf-8'), { filename });
}

export function writeYaml(data: any, filename: string, noRefs = false) {
  return fs.writeFileSync(filename, yaml.safeDump(data, { noRefs }));
}

export function pluralize(label: string, num: number) {
  if (label.endsWith('is')) {
    [label] = label.split(' ');
    return num === 1 ? `${label} is` : `${label}s are`;
  }
  return num === 1 ? `${label}` : `${label}s`;
}

export function handleError(e: Error, ref: string) {
  if (e instanceof ResolveError) {
    process.stderr.write(
      `Failed to resolve entrypoint definition at ${ref}:\n\n  - ${e.message}.\n\n`,
    );
  } else if (e instanceof YamlParseError) {
    process.stderr.write(
      `Failed to parse entrypoint definition at ${ref}:\n\n  - ${e.message}.\n\n`,
    );
    // TODO: codeframe
  } else { // @ts-ignore
    if (e instanceof CircularJSONNotSupportedError) {
      process.stderr.write(
        red(`Detected circular reference which can't be converted to JSON.\n`) +
        `Try to use ${blue('yaml')} output or remove ${blue('--dereferenced')}.\n\n`,
      );
    } else {
      process.stderr.write(`Something went wrong when processing ${ref}:\n\n  - ${e.message}.\n\n`);
      throw e;
    }
  }
}

export function printLintTotals(totals: Totals, definitionsCount: number) {
  const ignored = totals.ignored
    ? yellow(`${totals.ignored} ${pluralize('problem is', totals.ignored)} explicitly ignored.\n\n`)
    : '';

  if (totals.errors > 0) {
    process.stderr.write(
      red(
        `❌ Validation failed with ${totals.errors} ${pluralize('error', totals.errors)}${
          totals.warnings > 0
            ? ` and ${totals.warnings} ${pluralize('warning', totals.warnings)}`
            : ''
        }.\n${ignored}`,
      ),
    );
  } else if (totals.warnings > 0) {
    process.stderr.write(
      green(`Woohoo! Your OpenAPI ${pluralize('definition is', definitionsCount)} valid. 🎉\n`),
    );
    process.stderr.write(
      yellow(`You have ${totals.warnings} ${pluralize('warning', totals.warnings)}.\n${ignored}`),
    );
  } else {
    process.stderr.write(
      green(
        `Woohoo! Your OpenAPI ${pluralize(
          'definition is',
          definitionsCount,
        )} valid. 🎉\n${ignored}`,
      ),
    );
  }

  if (totals.errors > 0) {
    process.stderr.write(
      gray(`run with \`--generate-ignore-file\` to add all problems to ignore file.\n`),
    );
  }

  process.stderr.write('\n');
}

export function getOutputFileName(
  entrypoint: string,
  entries: number,
  output?: string,
  ext?: BundleOutputFormat,
) {
  if (!output) {
    return { outputFile: 'stdout', ext: ext || 'yaml' };
  }

  let outputFile = output;
  if (entries > 1) {
    ext = ext || (extname(entrypoint).substring(1) as BundleOutputFormat);
    if (!outputExtensions.includes(ext as any)) {
      throw new Error(`Invalid file extension: ${ext}.`);
    }
    outputFile = join(output, basename(entrypoint, extname(entrypoint))) + '.' + ext;
  } else {
    if (output) {
      ext = ext || (extname(output).substring(1) as BundleOutputFormat);
    }
    ext = ext || (extname(entrypoint).substring(1) as BundleOutputFormat);
    if (!outputExtensions.includes(ext as any)) {
      throw new Error(`Invalid file extension: ${ext}.`);
    }
    outputFile = join(dirname(outputFile), basename(outputFile, extname(outputFile))) + '.' + ext;
  }
  return { outputFile, ext };
}

export function printUnusedWarnings(config: LintConfig) {
  const { preprocessors, rules, decorators } = config.getUnusedRules();
  if (rules.length) {
    process.stderr.write(
      yellow(
        `[WARNING] Unused rules found in ${blue(config.configFile || '')}: ${rules.join(', ')}.\n`,
      ),
    );
  }
  if (preprocessors.length) {
    process.stderr.write(
      yellow(
        `[WARNING] Unused preprocessors found in ${blue(
          config.configFile || '',
        )}: ${preprocessors.join(', ')}.\n`,
      ),
    );
  }
  if (decorators.length) {
    process.stderr.write(
      yellow(
        `[WARNING] Unused decorators found in ${blue(config.configFile || '')}: ${decorators.join(
          ', ',
        )}.\n`,
      ),
    );
  }

  if (rules.length || preprocessors.length) {
    process.stderr.write(`Check the spelling and verify you added plugin prefix.\n`);
  }
}

export function exitWithError(message: string) {
  process.stderr.write(red(message)+ '\n\n');
  process.exit(1);
}


/**
 * Convert Windows backslash paths to slash paths: foo\\bar ➔ foo/bar
 */
export function slash(path: string): string {
  const isExtendedLengthPath = /^\\\\\?\\/.test(path)
  if (isExtendedLengthPath) {
    return path
  }

  return path.replace(/\\/g, '/');
}