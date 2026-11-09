// Background work: the Analysis queue and the Export queue. Each runs one job at a time,
// independently of the other; queued work lives in the database.
//   worker.ts    generic serial loop with cancel/stop
//   analysis.ts  'full': probe → extract-audio → transcribe → prepare-preview → signals → candidates;
//                'highlights': extract-audio → signals → candidates (analysis-steps.ts, analysis-highlights.ts)
//   export.ts    SRT/ASS + clip mp4
//   progress.ts  throttled, weighted progress
//   errors.ts    readable failure messages
export type { JobDeps, JobDepsInput, JobQueue } from './types'
export { resolveDeps } from './types'
export { abortKind, JobAbort, SerialWorker, throwIfAborted } from './worker'
export type { StopKind, WorkerOptions } from './worker'
export { createStepProgress, createThrottledProgress } from './progress'
export { CANCELLED_MESSAGE, MISSING_SOURCE_MESSAGE, readableError, stripStackTrace } from './errors'
export { ANALYSIS_STEPS, AnalysisQueue, analysisFiles, checkAudioTrack, runAnalysis, SIGNALS_STEP_SHARES } from './analysis'
export { clipFiles, ExportQueue, runExport } from './export'
export { isFile } from './files'
