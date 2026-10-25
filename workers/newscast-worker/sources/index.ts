export { default } from './http.ts';
// The Workers runtime only accepts classes and types as named exports of the entry module.
// The entrypoint the scheduler starts the task group "newscast" through
export { NewscastTaskGroup } from './task-group.ts';
// One instance makes one newscast
export { NewscastWorkflow } from './workflow.ts';
