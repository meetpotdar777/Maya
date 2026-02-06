
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Message, MayaMode } from './types';
import { MAYA_IDENTITY, MODELS } from './constants';
import { encode, decode, decodeAudioData } from './utils/audio';

// --- Helper for creating a PCM Blob ---
const createBlob = (data: Float32Array): { data: string; mimeType: string } => {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
};

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<MayaMode>(MayaMode.LIVE);
  const [isActive, setIsActive] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);

  const historyEndRef = useRef<HTMLDivElement>(null);
  
  // Audio context refs
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Transcription buffers
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  const scrollToBottom = () => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const addMessage = (role: 'user' | 'maya', text: string) => {
    setMessages(prev => [...prev, { role, text, timestamp: new Date() }]);
  };

  const stopSession = useCallback(() => {
    setIsActive(false);
    setInputLevel(0);
    
    if (sessionRef.current) {
      const session = sessionRef.current;
      sessionRef.current = null;
      try {
        session.close?.();
      } catch (e) {
        console.warn("Error closing session:", e);
      }
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    if (inputAudioCtxRef.current) {
      if (inputAudioCtxRef.current.state !== 'closed') {
        inputAudioCtxRef.current.close().catch(err => console.error("Error closing inputAudioCtx:", err));
      }
      inputAudioCtxRef.current = null;
    }

    if (outputAudioCtxRef.current) {
      if (outputAudioCtxRef.current.state !== 'closed') {
        outputAudioCtxRef.current.close().catch(err => console.error("Error closing outputAudioCtx:", err));
      }
      outputAudioCtxRef.current = null;
    }

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const startLiveSession = async () => {
    try {
      if (!process.env.API_KEY) {
        alert("API Key missing");
        return;
      }

      setIsActive(true);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // Initialize audio contexts
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      // Browsers often require resume after creation
      if (inputAudioCtxRef.current.state === 'suspended') await inputAudioCtxRef.current.resume();
      if (outputAudioCtxRef.current.state === 'suspended') await outputAudioCtxRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: MODELS.LIVE,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: MAYA_IDENTITY,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log('Maya is listening...');
            if (!inputAudioCtxRef.current) return;
            const source = inputAudioCtxRef.current.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Simple visualization level (input)
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              setInputLevel(Math.sqrt(sum / inputData.length));

              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                if (sessionRef.current) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle transcriptions
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }
            
            if (message.serverContent?.turnComplete) {
              const userInput = currentInputTranscription.current;
              const mayaOutput = currentOutputTranscription.current;
              if (userInput) addMessage('user', userInput);
              if (mayaOutput) addMessage('maya', mayaOutput);
              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
            }

            // Handle Audio by iterating through all parts
            const parts = message.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              const base64Audio = part.inlineData?.data;
              if (base64Audio && outputAudioCtxRef.current) {
                // Ensure context is running
                if (outputAudioCtxRef.current.state === 'suspended') {
                  await outputAudioCtxRef.current.resume();
                }

                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioCtxRef.current.currentTime);
                const audioBuffer = await decodeAudioData(
                  decode(base64Audio),
                  outputAudioCtxRef.current,
                  24000,
                  1
                );
                const source = outputAudioCtxRef.current.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputAudioCtxRef.current.destination);
                
                source.addEventListener('ended', () => {
                  sourcesRef.current.delete(source);
                });
                
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
              }
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch (e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Maya error:', e);
            stopSession();
          },
          onclose: () => {
            if (sessionRef.current) stopSession();
          },
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      stopSession();
    }
  };

  const handleDeepPrompt = async (text: string) => {
    if (!text.trim()) return;
    setIsThinking(true);
    addMessage('user', text);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      let response;

      if (mode === MayaMode.DEEP_THOUGHT) {
        response = await ai.models.generateContent({
          model: MODELS.THINKING,
          contents: text,
          config: {
            systemInstruction: MAYA_IDENTITY + "\nYour thoughts are being processed deeply. Keep the final answer concise as per your persona.",
            thinkingConfig: { thinkingBudget: 32768 }
          }
        });
      } else {
        response = await ai.models.generateContent({
          model: MODELS.SEARCH,
          contents: text,
          config: {
            tools: [{ googleSearch: {} }],
            systemInstruction: MAYA_IDENTITY + "\nUse search to get the latest info. Always conclude with a question."
          }
        });
      }

      const textOutput = response.text || "I'm sorry, I couldn't process that.";
      addMessage('maya', textOutput);
    } catch (err) {
      console.error(err);
      addMessage('maya', "Oops, something went wrong while I was thinking. Let's try again.");
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#0f172a] text-slate-100 p-4 gap-4 max-w-7xl mx-auto">
      <div className="flex-1 glass-card rounded-3xl p-6 flex flex-col h-[60vh] md:h-auto shadow-2xl relative overflow-hidden">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400">
            Maya's Journal
          </h2>
          <div className="flex gap-2">
            <span className={`h-3 w-3 rounded-full ${isActive ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`}></span>
            <span className="text-xs uppercase tracking-widest text-slate-400">{isActive ? 'Live' : 'Standby'}</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 pr-2 scrollbar-hide">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-2 opacity-50">
              <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p>No messages yet. Say hello to Maya!</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
              <div className={`max-w-[85%] rounded-2xl p-4 ${
                m.role === 'user' 
                ? 'bg-indigo-600 text-white rounded-br-none' 
                : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'
              }`}>
                <p className="text-sm leading-relaxed">{m.text}</p>
                <p className="text-[10px] mt-1 opacity-50 text-right">
                  {m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))}
          <div ref={historyEndRef} />
        </div>

        <div className="mt-4 pt-4 border-t border-slate-700/50">
          <div className="relative">
            <input 
              type="text" 
              placeholder={mode === MayaMode.LIVE ? "Switch to Deep Thought or Search to type..." : "Type your question..."}
              disabled={mode === MayaMode.LIVE || isThinking}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleDeepPrompt(e.currentTarget.value);
                  e.currentTarget.value = '';
                }
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:opacity-50 transition-all"
            />
            {isThinking && (
              <div className="absolute right-3 top-3">
                <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="w-full md:w-96 flex flex-col gap-4">
        <div className="glass-card rounded-3xl p-8 flex flex-col items-center justify-center flex-1 space-y-12 relative overflow-hidden maya-glow">
          <div className="relative flex items-center justify-center w-64 h-64">
            <div className={`absolute inset-0 rounded-full blur-3xl transition-all duration-500 ${isActive ? 'bg-indigo-500/30' : 'bg-slate-500/10'}`}></div>
            <div className={`w-48 h-48 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 shadow-[0_0_80px_rgba(99,102,241,0.4)] flex items-center justify-center relative z-10 transition-transform duration-300 ${isActive ? 'scale-110' : 'scale-100'}`}>
              <div className={`w-40 h-40 rounded-full border-4 border-white/20 flex items-center justify-center ${isActive ? 'animate-maya-pulse' : ''}`}>
                 {isActive ? (
                    <div className="flex gap-1 items-end h-12">
                      {[...Array(8)].map((_, i) => (
                        <div 
                          key={i} 
                          className="w-2 bg-white rounded-full transition-all duration-75"
                          style={{ height: `${Math.max(10, inputLevel * 100 * (1 + (Math.random() * 0.5)))}%` }}
                        />
                      ))}
                    </div>
                 ) : (
                    <svg className="w-16 h-16 text-white/40" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                    </svg>
                 )}
              </div>
            </div>
          </div>

          <div className="text-center space-y-2 z-20">
            <h1 className="text-3xl font-extrabold text-white tracking-tight">Maya</h1>
            <p className="text-indigo-300 text-sm font-medium">
              {isActive ? "Maya is listening..." : "Tap to speak with Maya"}
            </p>
          </div>

          <button 
            onClick={isActive ? stopSession : startLiveSession}
            className={`z-20 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 transform hover:scale-105 active:scale-95 shadow-lg ${
              isActive 
              ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20' 
              : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-500/20'
            }`}
          >
            {isActive ? (
              <svg className="w-10 h-10 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
              </svg>
            ) : (
              <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
          </button>
        </div>

        <div className="glass-card rounded-3xl p-4 flex flex-col gap-2 shadow-lg">
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold px-2">Assistant Mode</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: MayaMode.LIVE, label: 'Voice', icon: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z' },
              { id: MayaMode.DEEP_THOUGHT, label: 'Think', icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z' },
              { id: MayaMode.SEARCH, label: 'Search', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' }
            ].map(m => (
              <button
                key={m.id}
                onClick={() => {
                  if (isActive) stopSession();
                  setMode(m.id);
                }}
                className={`flex flex-col items-center justify-center py-3 rounded-2xl transition-all border ${
                  mode === m.id 
                  ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-400' 
                  : 'bg-slate-800/50 border-transparent text-slate-500 hover:bg-slate-800'
                }`}
              >
                <svg className="w-5 h-5 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={m.icon} />
                </svg>
                <span className="text-[10px] font-bold">{m.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
