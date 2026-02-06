
export interface Message {
  role: 'user' | 'maya';
  text: string;
  timestamp: Date;
  imageUrl?: string;
}

export enum MayaMode {
  LIVE = 'LIVE', // Real-time voice
  DEEP_THOUGHT = 'DEEP_THOUGHT', // Thinking budget
  SEARCH = 'SEARCH', // Google Search & Maps grounding
  IMAGE = 'IMAGE', // Image generation
}

export interface AudioState {
  isRecording: boolean;
  isPlaying: boolean;
  level: number;
}
