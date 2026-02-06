# Maya Voice Assistant

Maya is a high-fidelity, intuitive, and witty AI voice assistant built on the **Google Gemini API**. She is designed to be more than just a tool—she is a conversational partner with a distinct personality that blends supportive friendship with sharp professional wit.

## ✨ Features

- **🎙️ Maya Live (Voice Mode)**: Real-time, low-latency audio interaction using the `gemini-2.5-flash-native-audio` model. Experience human-like turn-taking and emotional intelligence.
- **🧠 Deep Thought (Pro Mode)**: Leverage `gemini-3-pro` for complex reasoning, long-form creative writing, or technical problem solving with an extended thinking budget.
- **🔍 Neural Search & Maps**: Grounded real-time answers using Google Search and Google Maps. Maya can provide location-aware recommendations and verify facts instantly.
- **🎨 Vision (Image Mode)**: Generate artistic visual manifestations of your thoughts using `gemini-2.5-flash-image`.
- **📜 Persistent Journal**: A sleek, localized memory log that saves your interactions across sessions. Export your "Neural Logs" or clear them at any time.
- **🌈 Adaptive Aura**: A dynamic UI that shifts themes (Indigo, Purple, Amber, Emerald) based on the active neural mode.

## 🚀 Tech Stack

- **Frontend**: React 19 (ES6 Modules)
- **Styling**: Tailwind CSS
- **AI Core**: `@google/genai` (Gemini 2.5 & 3 Series)
- **Grounding**: Google Search & Google Maps Integration
- **Audio**: Web Audio API (PCM Processing)

## 🛠️ Setup

1. **API Key**: Ensure you have a valid Google Gemini API Key.
2. **Environment**: The application expects `process.env.API_KEY` to be available.
3. **Permissions**: Grant microphone access when prompted to enable Live Voice mode.

## 👤 Credits

Created and designed with care by **The Developer**.
