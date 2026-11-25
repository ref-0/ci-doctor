// How many vCPUs a job's runner has, from the labels it ran on. A size named in a label wins: "-4core",
// "32-cores", "4vcpu", Namespace's "4x16", Depot's trailing "-8". Otherwise GitHub's standard runners by
// their documented sizes (docs.github.com, "GitHub-hosted runners", read 21 Nov 2026): Linux and Windows 4 on a
// public repo and 2 on a private one, Intel macOS 4, Apple silicon macOS 3, ubuntu-slim 1. And its larger macOS
// runners, whose labels GitHub names ("Larger runners", read 23 Nov 2026): `-large` 12, `-xlarge` 5. Anything
// else, a self-hosted runner or a larger runner with a name of its own, such as `ubuntu-latest-large`, has no
// known size.

const NAMED = [/(\d+)\s*-?\s*(?:v?cpus?|cores?)\b/i, /\bnscloud-.*?-(\d+)x\d+\b/i, /\bdepot-[a-z]+-[\d.]+-(\d+)\b/i];

/** The vCPUs of the runner that `labels` name, or null where the labels don't say. */
export const vcpusOf = (labels: ReadonlyArray<string>, isPrivate: boolean): number | null => {
  for (const label of labels)
    for (const pattern of NAMED) {
      const size = Number(label.match(pattern)?.[1]);
      if (size > 0) return size;
    }

  const standard = labels.map((label) => label.toLowerCase());
  if (standard.includes('ubuntu-slim')) return 1;
  if (standard.some((label) => /^(ubuntu|windows)-(latest|[\d.]+)(-arm)?$/.test(label))) return isPrivate ? 2 : 4;
  if (standard.some((label) => /^macos-[\w.-]+-large$/.test(label))) return 12;
  if (standard.some((label) => /^macos-[\w.-]+-xlarge$/.test(label))) return 5;
  if (standard.some((label) => /^macos-(13|[\w.]+-intel)$/.test(label))) return 4;
  if (standard.some((label) => /^macos-[\w.-]+$/.test(label))) return 3;

  return null;
};

/** The label a runner is known by: the first that isn't `self-hosted`, or none. */
export const runnerOf = (labels: ReadonlyArray<string>): string | null =>
  labels.find((label) => label !== 'self-hosted') ?? null;
