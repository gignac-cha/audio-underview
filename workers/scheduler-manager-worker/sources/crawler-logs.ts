/**
 * The limits of the logs of one crawler run, applied to logs put together from several runs
 * (the items of a fan-out stage). The crawler manager applies the same function to the logs of a run.
 */
export { limitCrawlerLogs } from '@audio-underview/worker-tools';
