# Local LLM Chat

A React and Vite chat interface backed by a small local Node.js service. The browser sends requests through the Vite development proxy to the LocalChat backend, which communicates with Ollama at `http://127.0.0.1:11434`. Chat replies come from the configured local Ollama model; date/time questions use the backend's current local clock. No `llama-server.exe`, database, or cloud API is used.

Install dependencies and start the backend and frontend together from this folder:

```powershell
npm install
npm run dev
```

Start Ollama and verify `llama3.2:latest` is already installed:

```powershell
ollama list
```

The app does not download models. Open http://localhost:5173. Chat history is saved in this browser's local storage.
