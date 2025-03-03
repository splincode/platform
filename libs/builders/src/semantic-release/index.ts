import { dirname } from 'path';

import { BuilderOutput, createBuilder, BuilderContext, BuilderRun } from '@angular-devkit/architect';
import { readJsonFile } from '@nrwl/workspace/src/utilities/fileutils';
import { JSONSchemaForNPMPackageJsonFiles } from '@schemastore/package';
import { emptyDir } from 'fs-extra';
import semanticRelease, { BranchSpec, PluginSpec, Result } from 'semantic-release';

import {
  createLoggerStream,
  getAnalyzeCommitsOptions,
  getGenerateNotesOptions,
  calculateProjectDependencies,
  getGithubOptions,
  getBuildTargetOptions,
} from './lib';
import { PluginConfig } from './plugins/plugin-config';
import { SemanticReleaseSchema } from './schema';

const buildPluginName = require.resolve('./plugins/build');
const updatePackageVersionPluginName = require.resolve('./plugins/update-package-version');
const updateDependenciesPluginName = require.resolve('./plugins/update-dependencies');

export default createBuilder(semanticReleaseBuilder);

async function semanticReleaseBuilder(options: SemanticReleaseSchema, context: BuilderContext): Promise<BuilderOutput> {
  const { project } = context.target ?? {};

  if (project == null) {
    return failureOutput(context, `Invalid project`);
  }

  // Validate build target
  const { packageJson, outputPath } = await getBuildTargetOptions(context, project);
  await emptyDir(`${outputPath}-tar`);

  // Validate source package json
  const sourcePackageJson: JSONSchemaForNPMPackageJsonFiles = readJsonFile(packageJson);
  const packageName: string | undefined = sourcePackageJson.name;
  if (packageName == null) {
    return failureOutput(context, `File ${packageJson} doesn't have a valid package name`);
  }

  // Launch semantic release
  context.logger.info(`Starting semantic release for project "${project}" with package name ${packageName} from path ${outputPath}`);
  context.logger.info(`Using configuration:`);
  context.logger.info(JSON.stringify(options, null, 2));

  const pluginConfig: PluginConfig = {
    project,
    packageName,
    packageJson,
    outputPath,
    releaseCommitMessage: options.releaseCommitMessage,
    changelog: `${dirname(packageJson)}/CHANGELOG.md`,
    dependencies: await calculateProjectDependencies(context),
    build: async () => {
      const buildRun: BuilderRun = await context.scheduleTarget({ project, target: 'build' });
      return await buildRun.result;
    },
  };

  const commitAnalyzerPlugin: PluginSpec = ['@semantic-release/commit-analyzer', getAnalyzeCommitsOptions(project, options.mode)];
  const releaseNotesPlugin: PluginSpec = ['@semantic-release/release-notes-generator', getGenerateNotesOptions(project)];
  const changelogPlugin: PluginSpec = ['@semantic-release/changelog', { changelogFile: pluginConfig.changelog }];
  const buildPlugin: PluginSpec = [buildPluginName, pluginConfig];
  const npmPlugin: PluginSpec = ['@semantic-release/npm', { pkgRoot: outputPath, tarballDir: `${outputPath}-tar` }];
  const githubPlugin: PluginSpec = ['@semantic-release/github', getGithubOptions(outputPath, packageName)];
  const updatePackageVersionPlugin: PluginSpec = [updatePackageVersionPluginName, pluginConfig];
  const updateDependenciesPlugin: PluginSpec = [updateDependenciesPluginName, pluginConfig];

  const plugins: PluginSpec[] = [
    commitAnalyzerPlugin,
    releaseNotesPlugin,
    options.changelog ? changelogPlugin : null,
    buildPlugin,
    options.npm ? npmPlugin : null,
    options.github ? githubPlugin : null,
    updatePackageVersionPlugin,
    updateDependenciesPlugin,
  ].filter<[string, any]>((plugin): plugin is [string, any] => plugin != null);

  try {
    const result: Result = await semanticRelease(
      {
        tagFormat: `${packageName}@\${version}`,
        branches: options.branches as ReadonlyArray<BranchSpec>,
        extends: undefined,
        dryRun: options.dryRun,
        plugins,
        ci: !options.force,
      },
      {
        env: { ...process.env } as { [key: string]: string },
        cwd: '.',
        stdout: createLoggerStream(context) as unknown as NodeJS.WriteStream,
        stderr: createLoggerStream(context) as unknown as NodeJS.WriteStream,
      }
    );

    if (result) {
      const { nextRelease } = result;
      context.logger.info(`The "${project}" project was released with version ${nextRelease.version}`);
    } else {
      context.logger.info(`No new release for the "${project}" project`);
    }
  } catch (err) {
    if (err instanceof Error) {
      context.logger.info(`${err.name}: ${err.message}`);
    }
    return { success: false, error: `The automated release failed with error: ${err}` };
  }

  return { success: true };
}

function failureOutput(context: BuilderContext, error?: string): BuilderOutput {
  if (error != null) {
    context.logger.info(error);
  }
  return { success: false, error: error as unknown as string };
}
