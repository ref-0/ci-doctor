// The scorer from code: `scoreRepo` returns the report `--json` prints, and the scoring functions take a stored
// report's inputs, so a stored report can be re-scored without reading GitHub again.
export { scoreRepo, measure, provenanceOf, scoreOf, grade, band, sizeClass, expectedWait, expectedMinutesPerMergedPr, expectedVcpuMinutesPerMergedPr, STANDARD_VCPUS, practices, treeProfile, manifestPaths } from './score.ts';
export { BYTES_PER_LINE, CODE_EXT, MAX_SOURCE_FILE, SKIP, WAIT_P50, WAIT_P90, GUIDE } from './score.ts';
export type { Inputs, Inventory, Practices, Report, ScoreOptions } from './score.ts';
export { stackOf, parseManifest, MAX_MANIFESTS, TOP_LIBRARIES, TEST_RUNNERS, LINT_FORMAT } from './stack.ts';
export type { Ecosystem, Manifest, Stack, StackInputs } from './stack.ts';
export { evidenceOf, outsideCiOf, outsideConfigs, DECIDES_BY, FEW_PUSHES, MEASURED_LOW, OUTSIDE_DECIDES, PUSH_CHECKS_WINDOW, SAMPLED_PUSHES, SIZED_ENOUGH, THIN_WAIT, UNSEEN } from './evidence.ts';
export type { Evidence, EvidenceInputs, OutsidePush } from './evidence.ts';
export { ApiCache, Gh } from './gh.ts';
export { CliError } from './errors.ts';
export { graphsOf, MAX_GRAPH_FILES, MAX_TASK_FILES, MAX_REEXPORT_DEPTH } from './graphs.ts';
export type { EntryNode, Graphs } from './graphs.ts';
export { THRESHOLDS } from './graph-core.ts';
