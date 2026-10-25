/**
 * @audio-underview/newscast-tts
 *
 * Text-to-Speech synthesis for the "GeekNews -> 2-host Korean audio newscast"
 * pipeline. Two engines are exported:
 * - Gemini Developer API native TTS (current): native multi-speaker dialogue in
 *   ONE `generateContent` request, authenticated with the same GEMINI_API_KEY as
 *   script generation, style-promptable, returning raw PCM. Chunked via
 *   {@link chunkScriptIntoTurnGroups}, rendered with {@link synthesizeDialogueChunk},
 *   and wrapped to WAV with {@link wrapPcmToWav}.
 * - Chirp 3 HD (legacy, kept for A/B): single-speaker Cloud TTS, one MP3 per line.
 */

// Gemini Developer API multi-speaker dialogue synthesis (current path)
export {
  synthesizeDialogueChunk,
  chunkScriptIntoTurnGroups,
  wrapPcmToWav,
  parseSampleRateFromMimeType,
  extractPcmAudio,
  usesSpeechMetadata,
  GEMINI_TTS_MODEL,
  DEFAULT_DIALOGUE_VOICES,
  MALE_DIALOGUE_VOICES,
  FEMALE_DIALOGUE_VOICES,
  pickRandomDialogueVoices,
  DEFAULT_DIALOGUE_STYLE_PROMPT,
  VERBATIM_READING_STYLE_PROMPT,
  DIALOGUE_SPEECH_STYLE,
  VERBATIM_SPEECH_STYLE,
  DIALOGUE_CHUNK_SIZE,
} from './dialogue-synthesizer.ts';
export type {
  SynthesizeDialogueChunkOptions,
  DialogueChunkAudio,
} from './dialogue-synthesizer.ts';

// Chirp 3 HD single-speaker synthesis (legacy A/B path)
export { synthesizeLine, synthesizeScript } from './synthesizer.ts';

// Default voice mapping
export { DEFAULT_SPEAKER_VOICES } from './synthesizer.ts';

// Types
export type {
  SpeakerVoiceMapping,
  SynthesizeLineOptions,
  SynthesizeScriptOptions,
} from './synthesizer.ts';
