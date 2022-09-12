// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {readFileSync} from 'fs';
import {
  ProjectGraph,
  ProjectGraphProjectNode,
} from 'nx/src/config/project-graph';
import {createProjectGraphAsync} from 'nx/src/project-graph/project-graph';
import {CandidateReleasePullRequest} from '../manifest';
import {ReleasePullRequest} from '../release-pull-request';
import {Changelog} from '../updaters/changelog';
import {RawContent} from '../updaters/raw-content';
import {BranchName} from '../util/branch-name';
import {jsonStringify} from '../util/json-stringify';
import {PullRequestBody} from '../util/pull-request-body';
import {PullRequestTitle} from '../util/pull-request-title';
import {Version, VersionsMap} from '../version';
import {PatchVersionUpdate} from '../versioning-strategy';
import {
  addPath,
  AllPackages,
  appendDependenciesSectionToChangelog,
  DependencyGraph,
  DependencyNode,
  WorkspacePlugin,
} from './workspace';

// const args = {base: 'HEAD~1', head: 'HEAD'};
// const affectedGraph = filterAffected(
//   createProjectGraphAsync(),
//   calculateFileChanges(parseFiles(args).files)
// ).nodes;
// const affectedApps = Object.keys(affectedGraph).filter(k => affectedGraph[k].type === ProjectType.app)
// console.log(affectedApps) // ['app1', 'app2', ..., 'appN']

interface Project extends ProjectGraphProjectNode {
  packageVersion: string;
  packageName: string;
  packageJson: object;
  packageJsonRaw: string;
}

export class NxWorkspace extends WorkspacePlugin<Project> {
  private projectGraph: ProjectGraph | undefined;

  protected bumpVersion(pkg: Project): Version {
    const version = Version.parse(pkg.packageVersion);
    return new PatchVersionUpdate().bump(version);
  }
  protected updateCandidate(
    existingCandidate: CandidateReleasePullRequest,
    project: Project,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    return existingCandidate;
  }

  protected newCandidate(
    project: Project,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    const graphProject = this.projectGraph?.nodes[project.name];
    if (!graphProject) {
      throw new Error(`Could not find graph project for ${project.name}`);
    }

    const packageToUpdate = JSON.parse(JSON.stringify(project));
    const newVersion = updatedVersions.get(project.packageName);
    if (newVersion) {
      this.logger.info(`Updating ${project.packageName} to ${newVersion}`);
      packageToUpdate.version = newVersion.toString();
    }

    const dependencyNotes = getChangelogDepsNotes();
    const version = Version.parse(project.packageVersion);
    const pullRequest: ReleasePullRequest = {
      title: PullRequestTitle.ofTargetBranch(this.targetBranch),
      body: new PullRequestBody([
        {
          component: project.packageName,
          version,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        },
      ]),
      updates: [
        {
          path: addPath(project.data.root, 'package.json'),
          createIfMissing: false,
          updater: new RawContent(
            jsonStringify(project.packageJson, project.packageJsonRaw)
          ),
        },
        {
          path: addPath(project.data.root, 'CHANGELOG.md'),
          createIfMissing: false,
          updater: new Changelog({
            version,
            changelogEntry: appendDependenciesSectionToChangelog(
              '',
              dependencyNotes,
              this.logger
            ),
          }),
        },
      ],
      labels: [],
      headRefName: BranchName.ofTargetBranch(this.targetBranch).toString(),
      version,
      draft: false,
    };

    return {
      path: project.data.root,
      pullRequest,
      config: {
        releaseType: 'node',
      },
    };
  }

  protected async buildAllPackages(
    candidates: CandidateReleasePullRequest[]
  ): Promise<AllPackages<Project>> {
    // allPackages
    let allPackages: Project[] = [];
    this.projectGraph = await createProjectGraphAsync();
    if (this.projectGraph.externalNodes) {
      const nodes = Object.values(this.projectGraph.nodes);
      allPackages = nodes.map(node => {
        const packagePath = addPath(node.data.root, 'package.json');
        const rawJson = readFileSync(packagePath).toString();
        const packageData = JSON.parse(rawJson);
        return {
          ...node,
          packageName: packageData.name,
          packageVersion: packageData.version,
          packageJson: packageData,
          packageJsonRaw: rawJson,
        };
      });
    }

    // candidatesByPackage
    const candidatesByPath = new Map<string, CandidateReleasePullRequest>();
    for (const candidate of candidates) {
      candidatesByPath.set(candidate.path, candidate);
    }
    const candidatesByPackage: Record<string, CandidateReleasePullRequest> = {};

    for (const path in this.repositoryConfig) {
      const candidate = candidatesByPath.get(path);

      if (candidate) {
        this.logger.debug(
          `Found candidate pull request for path: ${candidate.path}`
        );

        const candidatePackage = allPackages.find(
          pkg => pkg.data.root === candidate.path
        );
        if (candidatePackage) {
          candidatesByPackage[candidatePackage.name] = candidate;
        } else {
          this.logger.warn(
            `Found candidate pull request for path: ${candidate.path}, but did not find NX affected package`
          );
        }
      }
    }

    return {
      allPackages,
      candidatesByPackage,
    };
  }

  protected async buildGraph(
    allProjects: Project[]
  ): Promise<DependencyGraph<Project>> {
    const graph = new Map<string, DependencyNode<Project>>();
    const workspacePackageNames = new Set(allProjects.map(pkg => pkg.name));

    for (const project of allProjects) {
      const projectDeps = this.projectGraph?.dependencies[project.name] || [];
      const workspaceDeps = projectDeps
        .filter(dep => workspacePackageNames.has(dep.target))
        .map(dep => dep.target);
      graph.set(project.packageName, {
        deps: workspaceDeps,
        value: project,
      });
    }

    return graph;
  }
  protected inScope(candidate: CandidateReleasePullRequest): boolean {
    return candidate.config.releaseType === 'node';
  }
  protected packageNameFromPackage = (pkg: Project): string => pkg.name;

  protected pathFromPackage = (pkg: Project): string => pkg.data.root;

  protected postProcessCandidates(
    candidates: CandidateReleasePullRequest[],
    _updatedVersions: VersionsMap
  ): CandidateReleasePullRequest[] {
    return candidates;
  }
}

function getChangelogDepsNotes(): string {
  // TODO: Implement this, once I figure it out
  return '';
}
