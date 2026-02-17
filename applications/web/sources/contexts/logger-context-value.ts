import { createContext } from 'react';
import { type Logger } from '@audio-underview/logger';

export const LoggerContext = createContext<Logger | null>(null);
