// Copyright 2022 Google LLC
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
import {describe, it} from 'mocha';
import {SentenceCase} from '../../src/plugins/sentence-case';
import {expect} from 'chai';

import {GitHub} from '../../src/github';

describe('SentenceCase Plugin', () => {
  let github: GitHub;
  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'googleapis',
      repo: 'node-test-repo',
      defaultBranch: 'main',
    });
  });
  describe('processCommits', () => {
    it('converts description to sentence case', async () => {
      const plugin = new SentenceCase(github, 'main', {});
      const commits = await plugin.processCommits([
        {
          sha: 'abc123',
          message: 'fix: hello world',
        },
        {
          sha: 'abc123',
          message: 'fix: Goodnight moon',
        },
      ]);
      expect(commits[0].message).to.equal('fix: Hello world');
      expect(commits[1].message).to.equal('fix: Goodnight moon');
    });
    it('leaves reserved words lowercase', async () => {
      const plugin = new SentenceCase(github, 'main', {});
      const commits = await plugin.processCommits([
        {
          sha: 'abc123',
          message: 'feat: gRPC can now handle proxies',
        },
        {
          sha: 'abc123',
          message: 'fix: npm now rocks',
        },
      ]);
      expect(commits[0].message).to.equal('feat: gRPC can now handle proxies');
      expect(commits[1].message).to.equal('fix: npm now rocks');
    });
    it('handles sentences with now breaks', async () => {
      const plugin = new SentenceCase(github, 'main', {});
      const commits = await plugin.processCommits([
        {
          sha: 'abc123',
          message: 'feat: beep-boop-hello',
        },
        {
          sha: 'abc123',
          message: 'fix:log4j.foo.bar',
        },
      ]);
      expect(commits[0].message).to.equal('feat: Beep-boop-hello');
      expect(commits[1].message).to.equal('fix: Log4j.foo.bar');
    });
  });
  it('allows a custom list of specialWords to be provided', async () => {
    const plugin = new SentenceCase(github, 'main', {}, ['hello']);
    const commits = await plugin.processCommits([
      {
        sha: 'abc123',
        message: 'fix: hello world',
      },
      {
        sha: 'abc123',
        message: 'fix: Goodnight moon',
      },
    ]);
    expect(commits[0].message).to.equal('fix: hello world');
    expect(commits[1].message).to.equal('fix: Goodnight moon');
  });
});
