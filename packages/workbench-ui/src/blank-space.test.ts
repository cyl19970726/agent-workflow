import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BusinessStateDto } from '@signal-room/workflow-space-api/contracts';
import { BlankBusinessState } from './understanding.js';
import { defaultMethodVersionId, mainMethodVersionId, publishedDefinitionParams, shouldOpenBlankGoal, versionPurposeFor } from './workbench.js';
import { readSelection, writeSelection } from './selection.js';

const blank: BusinessStateDto = {
  workflowVersions: 0, understandingRevisions: 0, methodDesignRevisions: 0,
  cases: 0, runs: 0, businessAssets: 0, assetVersions: 0,
  adoptions: 0, understandingRevisionId: null,
};

describe('new Space entry', () => {
  it('opens a genuinely blank Space at the goal only from an ordinary URL', () => {
    const summary = { businessState: blank, latestVersionId: null, adoptedVersionId: null };
    expect(shouldOpenBlankGoal(new URLSearchParams(), summary)).toBe(true);
    const ordinary = new URLSearchParams();
    const goalUrl = writeSelection(ordinary, { ...readSelection(ordinary), view: 'goal' });
    expect(readSelection(goalUrl).view).toBe('goal');
    expect(shouldOpenBlankGoal(new URLSearchParams('view=workflow'), summary)).toBe(false);
    expect(shouldOpenBlankGoal(new URLSearchParams('version=saved-version'), summary)).toBe(false);
    expect(shouldOpenBlankGoal(new URLSearchParams('view=goal&understandingRevision=revision-1'), summary)).toBe(false);
    expect(shouldOpenBlankGoal(new URLSearchParams('view=assets&sourceRevision=revision-1&sourceIndex=0&asset=asset-1'), summary)).toBe(false);
    expect(readSelection(new URLSearchParams('version=saved-version')).version).toBe('saved-version');
    expect(shouldOpenBlankGoal(new URLSearchParams(), { ...summary, businessState: { ...blank, workflowVersions: 1 }, latestVersionId: 'saved-version' })).toBe(false);
    expect(shouldOpenBlankGoal(new URLSearchParams(), { latestVersionId: null, adoptedVersionId: null })).toBe(false);
  });

  it('shows actual zero business counts and makes unavailable saving explicit', () => {
    const html = renderToStaticMarkup(createElement(BlankBusinessState, { state: blank, writable: false }));
    for (const name of ['理解修订', '设计修订', '方法版本', '案例', '运行', '业务资产']) {
      expect(html).toContain(`<dt>${name}</dt><dd>0</dd>`);
    }
    expect(html).toContain('Agent 会根据你的请求形成理解');
    expect(html).toContain('当前身份没有保存理解修订的入口');
    expect(html).not.toContain('技术 schema');
    expect(html).not.toContain('CLI');
  });
  it('can enter business before any method version exists', () => {
    expect(versionPurposeFor(undefined, undefined)).toBeUndefined();
    expect(versionPurposeFor({ id: 'version-1', purpose: '准确用途' }, undefined)).toBeUndefined();
    expect(versionPurposeFor({ id: 'version-1', purpose: '准确用途' }, 'version-1')).toBe('准确用途');
  });
});

describe('default primary method navigation', () => {
  const summary = { adoptedVersionId: null, defaultVersionId: 'reliable-main', latestVersionId: 'observed-latest' };
  it('prefers an unadopted reliable main method over the latest execution observation', () => {
    expect(defaultMethodVersionId(readSelection(new URLSearchParams()), summary)).toBe('reliable-main');
    expect(defaultMethodVersionId(readSelection(new URLSearchParams()), { ...summary, adoptedVersionId: 'adopted-main' })).toBe('adopted-main');
  });
  it('preserves an explicit observation link, while the goal action opens the primary definition', () => {
    const params = new URLSearchParams('view=goal&version=observed-latest&candidateReader=1');
    const selection = readSelection(params);
    expect(defaultMethodVersionId(selection, summary)).toBe('observed-latest');
    const target = mainMethodVersionId(summary, defaultMethodVersionId(selection, summary));
    const methodLink = publishedDefinitionParams(params, selection, target!);
    expect(readSelection(methodLink)).toMatchObject({ view: 'workflow', tab: 'definition', version: 'reliable-main' });
    expect(methodLink.has('candidateReader')).toBe(false);
  });
});
