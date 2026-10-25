/**
 * @audio-underview/newscast-audio
 *
 * Dependency-free audio assembly for the "GeekNews -> 2-host Korean audio
 * newscast" pipeline — no ffmpeg, no decoder. Two paths:
 * - Raw PCM (current, Gemini Developer API TTS): concatenate per-chunk PCM
 *   buffers and derive EXACT per-chunk timing from byte length via
 *   {@link mergePcmChunks} / {@link pcmDurationMs}.
 * - MP3 (legacy Chirp 3 HD): concatenate per-line MP3 buffers and derive timing
 *   by walking MPEG frame headers via {@link mergeLineAudio} /
 *   {@link estimateMp3DurationMs}.
 */

// Raw PCM merge + exact timing (current path)
export { mergePcmChunks, pcmDurationMs } from './pcm-merge.ts';
export type { MergedPcm, PcmChunkSegment } from './pcm-merge.ts';

// PCM -> MP3 encoding (pure JS, Workers-compatible; final delivered audio)
export { encodePcmToMp3 } from './mp3-encode.ts';

// MP3 merge + timing (legacy path)
export { mergeLineAudio } from './merge.ts';
export { estimateMp3DurationMs } from './mp3-duration.ts';
export type { MergedAudio } from './merge.ts';

// Whisper transcription + fuzzy caption-timing alignment (real per-line timings)
export { transcribeWords } from './transcribe.ts';
export type { TranscriptWord, TranscribeOptions } from './transcribe.ts';
export { alignScriptToTranscript } from './align.ts';
