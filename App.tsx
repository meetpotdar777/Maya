import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Message, MayaMode } from './types';
import { MAYA_IDENTITY, MODELS } from './constants';
import { encode, decode, decodeAudioData } from './utils/audio';

const createBlob = (data: Float32Array): { data: string; mimeType: string } => {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, data[i] * 32768));
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
};

const App: React.FC = () => {
  // Persistence Layer with Unique IDs for safe deletion
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem('maya_neural_link');
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      return parsed.map((m: any) => ({
        ...m,
        timestamp: new Date(m.timestamp),
        id: m.id || Math.random().toString(36).substr(2, 9)
      }));
    } catch { return []; }
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [mode, setMode] = useState<MayaMode>(MayaMode.LIVE);
  const [isActive, setIsActive] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isMayaSpeaking, setIsMayaSpeaking] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [userIsScrolledUp, setUserIsScrolledUp] = useState(false);

  const historyEndRef = useRef<HTMLDivElement>(null);
  const journalScrollRef = useRef<HTMLDivElement>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Persistence and Smart Scroll logic
  useEffect(() => {
    localStorage.setItem('maya_neural_link', JSON.stringify(messages));
    if (!userIsScrolledUp) {
      scrollToBottom();
    }
  }, [messages]);

  const scrollToBottom = () => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleJournalScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    setUserIsScrolledUp(!isAtBottom);
  };

  const addMessage = (role: 'user' | 'maya', text: string, imageUrl?: string) => {
    const newMessage: Message = { 
      id: Math.random().toString(36).substr(2, 9),
      role, 
      text, 
      timestamp: new Date(), 
      imageUrl 
    };
    setMessages(prev => [...prev, newMessage].slice(-50)); // Keep history performant
  };

  const deleteMessage = (id: string) => {
    setMessages(prev => prev.filter((m) => m.id !== id));
  };

  const clearMemories = () => {
    if (confirm("Are you sure you want to clear Maya's memory of this session? This action cannot be undone.")) {
      setMessages([]);
      localStorage.removeItem('maya_neural_link');
    }
  };

  const condenseHistory = async () => {
    if (messages.length < 4) return;
    setIsThinking(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const historyText = messages.map(m => `${m.role}: ${m.text}`).join('\n');
      const response = await ai.models.generateContent({
        model: MODELS.THINKING,
        contents: `Summarize this conversation into a concise "Neural Memory" block. Text: \n${historyText}`,
        config: { systemInstruction: MAYA_IDENTITY }
      });
      const summary = response.text || "History condensed.";
      addMessage('maya', `[System: Memory Condensed] ${summary}`);
    } catch (err) {
      handleApiError(err);
    } finally {
      setIsThinking(false);
    }
  };

  const exportJournal = () => {
    const text = messages.map(m => `[${m.timestamp.toLocaleTimeString()}] ${m.role.toUpperCase()}: ${m.text}`).join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `maya_journal_${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
  };

  const handleApiError = async (err: any) => {
    const msg = err?.message || String(err);
    if (msg.includes("429") || msg.includes("quota")) {
      addMessage('maya', "[System: Neural Link saturated. Please wait a moment for the pathways to clear.]");
    } else {
      addMessage('maya', `[System Link Failure: ${msg.substring(0, 50)}...]`);
    }
  };

  const stopSession = useCallback(async () => {
    setIsActive(false);
    setIsMayaSpeaking(false);
    setInputLevel(0);
    
    if (sessionRef.current) {
      try { await sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      if (inputAudioCtxRef.current.state !== 'closed') await inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      if (outputAudioCtxRef.current.state !== 'closed') await outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }
    sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const startLiveSession = async () => {
    try {
      if (!process.env.API_KEY) return alert("API Key missing");
      await stopSession();
      setIsActive(true);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      const outputNode = outputCtx.createGain();
      outputNode.connect(outputCtx.destination);
      outputNodeRef.current = outputNode;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: MODELS.LIVE,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          systemInstruction: MAYA_IDENTITY,
        },
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setInputLevel(Math.sqrt(sum / inputData.length));
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => { session.sendRealtimeInput({ media: pcmBlob }); });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            addMessage('maya', "[System: Neural Link established. Talk to Maya.]");
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              setIsMayaSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNode);
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsMayaSpeaking(false);
              });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsMayaSpeaking(false);
            }
          },
          onerror: (e) => { handleApiError(e); stopSession(); },
          onclose: () => { if (isActive) stopSession(); },
        },
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { stopSession(); }
  };

  const handleDeepPrompt = async (text: string) => {
    if (!text.trim() || isThinking) return;
    setIsThinking(true);
    addMessage('user', text);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      let response;

      if (mode === MayaMode.DEEP_THOUGHT) {
        response = await ai.models.generateContent({
          model: MODELS.THINKING,
          contents: text,
          config: { systemInstruction: MAYA_IDENTITY, thinkingConfig: { thinkingBudget: 32768 } }
        });
        addMessage('maya', response.text || "Thinking is a complex dance.");
      } else if (mode === MayaMode.SEARCH) {
        response = await ai.models.generateContent({
          model: MODELS.SEARCH,
          contents: text,
          config: { 
            tools: [{ googleSearch: {} }, { googleMaps: {} }],
            systemInstruction: MAYA_IDENTITY 
          }
        });
        addMessage('maya', response.text || "Gathered some fresh insights for you.");
      } else if (mode === MayaMode.IMAGE) {
        response = await ai.models.generateContent({
          model: MODELS.IMAGE,
          contents: `A visual interpretation of: ${text}`,
        });
        
        let imageUrl = '';
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) imageUrl = `data:image/png;base64,${part.inlineData.data}`;
        }
        addMessage('maya', "Vision manifestation complete.", imageUrl);
      }
    } catch (err) {
      handleApiError(err);
    } finally {
      setIsThinking(false);
    }
  };

  const getModeColor = () => {
    switch(mode) {
      case MayaMode.DEEP_THOUGHT: return 'bg-purple-600';
      case MayaMode.SEARCH: return 'bg-amber-600';
      case MayaMode.IMAGE: return 'bg-emerald-600';
      default: return 'bg-indigo-600';
    }
  };

  const filteredMessages = useMemo(() => {
    if (!searchQuery) return messages;
    return messages.filter(m => m.text.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [messages, searchQuery]);

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#0f172a] text-slate-100 p-4 gap-4 max-w-7xl mx-auto overflow-hidden">
      
      {/* Voice Core - On Mobile (default flex-col), this will be order-1 (Top) */}
      <div className="w-full md:w-96 flex flex-col gap-4 order-1 md:order-2">
        <div className={`glass-card rounded-[3rem] p-10 flex flex-col items-center justify-center flex-1 space-y-16 relative overflow-hidden transition-shadow duration-1000 border border-white/5 ${isActive ? 'maya-glow' : ''}`}>
          <div className="relative flex items-center justify-center w-72 h-72">
            <div className={`absolute inset-0 rounded-full blur-[80px] transition-all duration-1000 opacity-30 ${getModeColor()}`}></div>
            <div className={`w-52 h-52 rounded-full bg-gradient-to-tr from-slate-800 to-slate-900 shadow-2xl flex items-center justify-center relative z-10 transition-all duration-700 border border-white/10 ${isActive ? 'scale-110' : 'scale-100'}`}>
              <div className={`absolute inset-0 rounded-full bg-gradient-to-tr opacity-20 transition-colors duration-1000 from-white to-transparent ${getModeColor()}`}></div>
              <div className={`w-44 h-44 rounded-full border-4 border-white/5 flex items-center justify-center bg-slate-900/40 backdrop-blur-md ${isMayaSpeaking ? 'animate-maya-pulse' : ''}`}>
                 {isActive ? (
                    <div className="flex gap-1.5 items-end h-16">
                      {[...Array(12)].map((_, i) => (
                        <div key={i} className={`w-1 rounded-full transition-all duration-150 shadow-lg ${getModeColor()}`} style={{ height: `${Math.max(15, (isMayaSpeaking ? 50 + Math.random() * 50 : inputLevel * 150 * (0.5 + Math.random())))}%` }} />
                      ))}
                    </div>
                 ) : (
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center ${getModeColor()} bg-opacity-20`}>
                      <svg className="w-8 h-8 text-white opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    </div>
                 )}
              </div>
            </div>
          </div>
          <div className="text-center space-y-3 z-20">
            <h1 className="text-4xl font-black text-white tracking-tighter">Maya</h1>
            <p className="text-slate-400 text-xs font-black uppercase tracking-[0.3em]">{isActive ? (isMayaSpeaking ? "Speaking" : "Listening") : "Neural Interface Standby"}</p>
          </div>
          <button onClick={isActive ? stopSession : startLiveSession} className={`z-20 w-24 h-24 rounded-full flex items-center justify-center transition-all duration-700 shadow-2xl relative ${isActive ? 'bg-red-500' : 'bg-white bg-opacity-5 hover:bg-opacity-10'}`}>
            <div className={`absolute inset-0 rounded-full animate-ping opacity-10 ${isActive ? 'bg-red-400' : 'bg-indigo-400'}`}></div>
            {isActive ? <svg className="w-10 h-10 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> : <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          </button>
        </div>

        {/* Mode Selector */}
        <div className="glass-card rounded-[2rem] p-4 flex flex-col gap-4 shadow-xl border border-white/5">
          <div className="grid grid-cols-4 gap-3">
            {[
              { id: MayaMode.LIVE, label: 'Live', icon: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z' },
              { id: MayaMode.DEEP_THOUGHT, label: 'Pro', icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z' },
              { id: MayaMode.SEARCH, label: 'Search', icon: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z' },
              { id: MayaMode.IMAGE, label: 'Vision', icon: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z' }
            ].map(m => (
              <button key={m.id} onClick={() => { stopSession(); setMode(m.id); }} className={`flex flex-col items-center justify-center py-4 rounded-2xl transition-all border ${mode === m.id ? `bg-opacity-20 border-opacity-50 text-white ${getModeColor()} border-white` : 'bg-slate-800/40 border-transparent text-slate-500 hover:text-slate-300'}`}>
                <svg className="w-5 h-5 mb-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d={m.icon} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}/></svg>
                <span className="text-[9px] font-black uppercase tracking-widest">{m.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Journal Panel - On Mobile, this will be order-2 (Bottom) */}
      <div className="flex-1 glass-card rounded-[2.5rem] p-6 flex flex-col h-[70vh] md:h-auto shadow-2xl relative overflow-hidden group border border-white/5 transition-all duration-700 hover:border-white/10 order-2 md:order-1">
        <div className={`absolute -top-24 -left-24 w-64 h-64 opacity-10 rounded-full blur-[100px] pointer-events-none transition-colors duration-1000 ${getModeColor()}`}></div>
        <div className="relative z-10 flex flex-col h-full">
          <div className="mb-6 border-b border-white/5 pb-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border transition-colors duration-500 ${getModeColor().replace('bg-', 'bg-opacity-20 border-').replace('600', '500')}`}>
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-white tracking-tight">Journal</h2>
                  <p className="text-[10px] uppercase tracking-[0.3em] text-indigo-400/70 font-bold">Latest Records</p>
                </div>
              </div>
              <div className="flex gap-2 items-center">
                <button 
                  onClick={clearMemories} 
                  className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[10px] font-bold uppercase tracking-widest rounded-xl transition-all border border-red-500/20 flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeWidth={2}/></svg>
                  <span className="hidden sm:inline">Delete All</span>
                </button>
                <div className="w-px h-6 bg-white/10 mx-1"></div>
                <button onClick={condenseHistory} className="p-2 hover:bg-white/5 rounded-xl text-slate-400 transition-colors" title="Summarize Pathways">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 4h16v16H4V4zm4 4v8m4-8v8m4-8v8" strokeWidth={2}/></svg>
                </button>
                <button onClick={exportJournal} className="p-2 hover:bg-white/5 rounded-xl text-slate-400 transition-colors" title="Export Logs">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" strokeWidth={2}/></svg>
                </button>
              </div>
            </div>
            <div className="relative">
              <input type="text" placeholder="Recall a specific thought..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full bg-white/5 border border-white/5 rounded-2xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500/50 transition-all text-slate-200" />
              <svg className="w-4 h-4 absolute left-3.5 top-3 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </div>
          </div>

          <div 
            ref={journalScrollRef}
            onScroll={handleJournalScroll}
            className="flex-1 overflow-y-auto space-y-6 pr-2 scrollbar-hide relative pb-4"
          >
            {filteredMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center opacity-40">
                <p className="text-lg font-semibold text-slate-300">Quiet mind.</p>
                <p className="text-sm">Initiate a link to record your first interaction.</p>
              </div>
            ) : (
              filteredMessages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} group animate-in fade-in slide-in-from-bottom-4 duration-300`}>
                  <div className={`relative max-w-[88%] min-w-[140px] rounded-3xl px-6 py-5 ${
                    m.role === 'user' ? 'bg-indigo-600 text-white rounded-br-none shadow-xl shadow-indigo-500/10' : 'bg-slate-800/60 backdrop-blur-xl text-slate-100 rounded-bl-none border border-white/10'
                  }`}>
                    <div className="flex justify-between items-center mb-2">
                       <span className={`text-[10px] font-black uppercase tracking-[0.2em] ${m.role === 'user' ? 'text-indigo-200' : 'text-indigo-400'}`}>{m.role === 'user' ? 'You' : 'Maya'}</span>
                       <div className="flex items-center gap-2">
                         <span className="text-[9px] font-bold opacity-30">{m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                         <button 
                          onClick={(e) => { e.stopPropagation(); deleteMessage(m.id); }} 
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-red-400/70 hover:text-red-400 p-1 bg-red-500/10 rounded-lg" 
                          title="Forget Thought"
                        >
                           <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12" strokeWidth={2.5}/></svg>
                         </button>
                       </div>
                    </div>
                    {m.imageUrl && (
                      <div className="mb-3 rounded-xl overflow-hidden border border-white/20 shadow-2xl">
                        <img src={m.imageUrl} alt="AI Manifestation" className="w-full h-auto object-cover max-h-64" />
                      </div>
                    )}
                    <p className={`text-[0.925rem] leading-[1.6] whitespace-pre-wrap font-medium ${m.text.startsWith('[System:') ? 'italic text-indigo-300/60' : ''}`}>{m.text}</p>
                  </div>
                </div>
              ))
            )}
            <div ref={historyEndRef} />
            
            {userIsScrolledUp && (
              <button 
                onClick={scrollToBottom} 
                className="sticky bottom-4 left-1/2 -translate-x-1/2 bg-indigo-500/95 backdrop-blur-md text-white px-5 py-2.5 rounded-full shadow-2xl hover:bg-indigo-400 transition-all z-50 border border-white/20 flex items-center gap-2 text-xs font-black uppercase tracking-widest"
              >
                <span>Latest Signals</span>
                <svg className="w-4 h-4 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 14l-7 7m0 0l-7-7m7 7V3" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            )}
          </div>

          <div className="mt-4 relative">
            <div className="relative flex items-center bg-slate-900/40 backdrop-blur-md border border-white/5 rounded-3xl p-1 md:p-2 shadow-2xl">
              <input type="text" placeholder={mode === MayaMode.LIVE ? (isActive ? "Aura listening..." : "Connect voice to speak...") : `Neural prompt (${mode.toLowerCase()})...`} disabled={mode === MayaMode.LIVE || isThinking} onKeyDown={(e) => { if (e.key === 'Enter') { handleDeepPrompt(e.currentTarget.value); e.currentTarget.value = ''; } }} className="flex-1 bg-transparent border-none px-4 py-3 md:py-4 text-sm focus:outline-none placeholder:text-slate-600 font-medium disabled:opacity-20" />
              {isThinking && <div className="mr-4 flex gap-1.5 animate-pulse"><div className={`w-1.5 h-1.5 rounded-full ${getModeColor()}`} /><div className={`w-1.5 h-1.5 rounded-full ${getModeColor()}`} /><div className={`w-1.5 h-1.5 rounded-full ${getModeColor()}`} /></div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;