import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runnerOf, vcpusOf } from '../src/runners.ts';

describe('vcpusOf', () => {
  it('reads a size a label names', () => {
    assert.equal(vcpusOf(['electron-arc-centralus-linux-amd64-32core'], false), 32);
    assert.equal(vcpusOf(['ubuntu-latest-4-cores'], false), 4);
    assert.equal(vcpusOf(['blacksmith-4vcpu-ubuntu-2404'], false), 4);
    assert.equal(vcpusOf(['nscloud-ubuntu-22.04-amd64-8x16'], false), 8);
    assert.equal(vcpusOf(['depot-ubuntu-24.04-16'], false), 16);
  });

  it("takes GitHub's standard sizes, Linux and Windows halved on a private repo", () => {
    assert.equal(vcpusOf(['ubuntu-latest'], false), 4);
    assert.equal(vcpusOf(['ubuntu-24.04-arm'], true), 2);
    assert.equal(vcpusOf(['windows-2022'], false), 4);
    assert.equal(vcpusOf(['ubuntu-slim'], false), 1);
    assert.equal(vcpusOf(['macos-15-intel'], false), 4);
    assert.equal(vcpusOf(['macos-latest'], true), 3);
  });

  it("takes GitHub's larger macOS runners by the sizes it documents", () => {
    assert.equal(vcpusOf(['macos-latest-large'], false), 12);
    assert.equal(vcpusOf(['macos-15-large'], true), 12);
    assert.equal(vcpusOf(['macos-latest-xlarge'], false), 5);
  });

  it('knows no size for a self-hosted runner, or a larger runner named without one', () => {
    assert.equal(vcpusOf(['self-hosted', 'linux', 'x64'], false), null);
    assert.equal(vcpusOf(['ubuntu-latest-large'], false), null);
    assert.equal(vcpusOf(['windows-2022-xl'], true), null);
    assert.equal(vcpusOf([], false), null);
  });
});

describe('runnerOf', () => {
  it('names a runner by its first label past self-hosted', () => {
    assert.equal(runnerOf(['self-hosted', 'gpu-box']), 'gpu-box');
    assert.equal(runnerOf([]), null);
  });
});
