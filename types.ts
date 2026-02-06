
export interface Message {
  role: 'user' | 'maya';
  text: string;
  timestamp: Date;
}

export enum MayaMode {
  LIVE = 'LIVE', // Real-time voice
  DEEP_THOUGHT = 'DEEP_THOUGHT', // Thinking budget
  SEARCH = 'SEARCH', // Google Search grounding
}

export interface AudioState {
  isRecording: boolean;
  isPlaying: boolean;
  level: number;
}
