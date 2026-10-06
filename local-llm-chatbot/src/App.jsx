import { useCallback, useEffect, useRef, useState } from 'react';

const MODEL_NAME = 'llama3.2:latest';
const STORAGE_KEY = 'local-llm-chat-history-v1';
const OLLAMA_ERROR = 'Ollama is not running. Start Ollama and try again.';
const MODEL_ERROR = `${MODEL_NAME} model is not installed.`;

function loadChats() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const chats = JSON.parse(saved);
    return Array.isArray(chats) ? chats : [];
  } catch {
    return [];
  }
}

function makeChat() {
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    messages: [],
    updatedAt: Date.now(),
  };
}

async function checkOllama() {
  let response;
  try {
    response = await fetch('/api/ollama/tags');
  } catch {
    throw new Error(OLLAMA_ERROR);
  }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || OLLAMA_ERROR);
  }

  const data = await response.json();
  const installed = (data.models ?? []).some(
    (model) => model.name === MODEL_NAME || model.model === MODEL_NAME,
  );
  if (!installed) throw new Error(MODEL_ERROR);
}

function Icon({ name, size = 18 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  if (name === 'plus') {
    return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  }
  if (name === 'trash') {
    return <svg {...common}><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6" /></svg>;
  }
  if (name === 'send') {
    return <svg {...common}><path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" /></svg>;
  }
  if (name === 'refresh') {
    return <svg {...common}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3" /></svg>;
  }
  return <svg {...common}><path d="M12 3v10m0 0 4-4m-4 4-4-4" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>;
}

export default function App() {
  const [chats, setChats] = useState(loadChats);
  const [activeChatId, setActiveChatId] = useState(() => loadChats()[0]?.id ?? null);
  const [connection, setConnection] = useState('checking');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sendingRef = useRef(false);
  const textareaRef = useRef(null);
  const bottomRef = useRef(null);

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const messages = activeChat?.messages ?? [];

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    } catch {
      setError('Chat history could not be saved in this browser.');
    }
  }, [chats]);

  const refreshConnection = useCallback(async () => {
    setChecking(true);
    try {
      await checkOllama();
      setConnection('connected');
      setConnectionMessage('');
      setError((current) => current === OLLAMA_ERROR || current === MODEL_ERROR ? '' : current);
    } catch (connectionError) {
      const message = connectionError.message === MODEL_ERROR ? MODEL_ERROR : OLLAMA_ERROR;
      setConnection(message === MODEL_ERROR ? 'missing' : 'offline');
      setConnectionMessage(message);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refreshConnection();
  }, [refreshConnection]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  function startNewChat() {
    const chat = makeChat();
    setChats((current) => [chat, ...current]);
    setActiveChatId(chat.id);
    setInput('');
    setError('');
    setSidebarOpen(false);
    textareaRef.current?.focus();
  }

  function clearChat() {
    if (!activeChat) return;
    setChats((current) =>
      current.map((chat) =>
        chat.id === activeChat.id
          ? { ...chat, title: 'New chat', messages: [], updatedAt: Date.now() }
          : chat,
      ),
    );
    setError('');
    textareaRef.current?.focus();
  }

  function updateMessages(chatId, nextMessages) {
    setChats((current) =>
      current
        .map((chat) => {
          if (chat.id !== chatId) return chat;
          const firstUserMessage = nextMessages.find((message) => message.role === 'user');
          const title = firstUserMessage?.content?.trim().slice(0, 42) || 'New chat';
          return { ...chat, title, messages: nextMessages, updatedAt: Date.now() };
        })
        .sort((left, right) => right.updatedAt - left.updatedAt),
    );
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const content = input;
    if (!content.trim() || sendingRef.current) return;

    let chat = activeChat;
    if (!chat) {
      chat = makeChat();
      setChats((current) => [chat, ...current]);
      setActiveChatId(chat.id);
    }

    const currentMessages = [...chat.messages, { role: 'user', content }];
    updateMessages(chat.id, currentMessages);
    setInput('');
    setError('');
    sendingRef.current = true;
    setSending(true);

    try {
      const response = await fetch('/api/ollama/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: currentMessages.map(({ role, content: messageContent }) => ({
            role,
            content: messageContent,
          })),
          stream: false,
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 404 || /model .* not found/i.test(data?.error ?? '')) {
          throw new Error(MODEL_ERROR);
        }
        throw new Error(data?.error || `The chat request failed (HTTP ${response.status}).`);
      }

      if (!data || typeof data !== 'object') {
        throw new Error('The chat backend returned an invalid response.');
      }
      const answer = data.message?.content?.trim();
      if (!answer) throw new Error('Ollama returned an empty response. Please try again.');
      updateMessages(chat.id, [...currentMessages, { role: 'assistant', content: answer }]);
      setConnection('connected');
      setConnectionMessage('');
    } catch (sendError) {
      const message = sendError.message === MODEL_ERROR
        ? MODEL_ERROR
        : sendError instanceof TypeError
          ? OLLAMA_ERROR
          : sendError.message;
      setError(message);
      if (message === OLLAMA_ERROR) {
        setConnection('offline');
        setConnectionMessage(message);
      } else if (message === MODEL_ERROR) {
        setConnection('missing');
        setConnectionMessage(message);
      } else if (/ollama is not running/i.test(message)) {
        setConnection('offline');
        setConnectionMessage(message);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function onInputKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  }

  function selectChat(chatId) {
    setActiveChatId(chatId);
    setError('');
    setSidebarOpen(false);
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
            <span className="brand-mark"><span /></span>
            <span>Local<span className="brand-light">Chat</span></span>
          </a>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close chat history">
            ×
          </button>
        </div>

        <button className="new-chat-button" onClick={startNewChat}>
          <Icon name="plus" />
          <span>New chat</span>
        </button>

        <div className="history-heading">Recent</div>
        <nav className="chat-history" aria-label="Chat history">
          {chats.length === 0 ? (
            <p className="history-empty">Your conversations will appear here.</p>
          ) : chats.map((chat) => (
            <button
              className={`history-item ${chat.id === activeChatId ? 'history-item-active' : ''}`}
              key={chat.id}
              onClick={() => selectChat(chat.id)}
              title={chat.title}
            >
              <span className="history-dot" />
              <span className="history-title">{chat.title}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="privacy-icon">⌑</span>
          <div>
            <strong>Private by design</strong>
            <span>Chats stay in this browser</span>
          </div>
        </div>
      </aside>

      <section className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open chat history">
              <span className="menu-lines" />
            </button>
            <div className="model-label">
              <span className="model-indicator" />
              <span>Model</span>
              <strong>{MODEL_NAME}</strong>
            </div>
          </div>
          <div className="topbar-actions">
            <div className={`connection-status status-${connection}`} aria-live="polite">
              <span className="status-dot" />
              <span>{connection === 'checking' ? 'Checking' : connection === 'connected' ? 'Connected' : 'Disconnected'}</span>
            </div>
            <button
              className="icon-button refresh-button"
              onClick={refreshConnection}
              disabled={checking}
              aria-label="Check Ollama connection"
              title="Check Ollama connection"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        {(connectionMessage || error) && (
          <div className="error-notice" role="alert">
            <span className="error-mark">!</span>
            <span>{error || connectionMessage}</span>
            <button onClick={refreshConnection} disabled={checking}>Retry</button>
          </div>
        )}

        <div className="conversation-area">
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-orb"><span className="orb-core" /></div>
              <p className="eyebrow">YOUR LOCAL AI ASSISTANT</p>
              <h1>Hello. What’s on your mind?</h1>
              <p className="welcome-copy">A private space to think, write, learn, and explore — powered by a model running right on your device.</p>
              <div className="welcome-prompt">
                <span className="prompt-sparkle">✳</span>
                <span>Try asking anything. Your messages never leave this machine.</span>
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((message, index) => (
                <article className={`message message-${message.role}`} key={`${activeChatId}-${index}`}>
                  <div className={`avatar avatar-${message.role}`}>
                    {message.role === 'user' ? 'Y' : <span className="avatar-mark" />}
                  </div>
                  <div className="message-body">
                    <div className="message-author">{message.role === 'user' ? 'You' : 'LocalChat'}</div>
                    <div className="message-content">{message.content}</div>
                  </div>
                </article>
              ))}
              {sending && (
                <article className="message message-assistant">
                  <div className="avatar avatar-assistant"><span className="avatar-mark" /></div>
                  <div className="message-body">
                    <div className="message-author">LocalChat</div>
                    <div className="typing-indicator" aria-label="Assistant is thinking">
                      <span /><span /><span />
                      <span className="typing-label">Thinking...</span>
                    </div>
                  </div>
                </article>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <footer className="composer-section">
          <div className="composer-tools">
            <span>Chatting with <strong>{MODEL_NAME}</strong></span>
            <button className="clear-button" onClick={clearChat} disabled={sending || messages.length === 0}>
              <Icon name="trash" size={14} />
              <span>Clear chat</span>
            </button>
          </div>
          <form className="composer" onSubmit={sendMessage}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Message LocalChat..."
              rows={1}
              aria-label="Type your message"
              disabled={sending}
            />
            <div className="composer-bottom">
              <span className="composer-hint">↵ send <span className="hint-divider">·</span> ⇧↵ new line</span>
              <button className="send-button" type="submit" disabled={sending} aria-label="Send message">
                {sending ? <span className="send-spinner" /> : <Icon name="send" size={17} />}
                <span>{sending ? 'Thinking...' : 'Send'}</span>
              </button>
            </div>
          </form>
          <p className="local-disclaimer">Local model · Your conversations are stored only in this browser</p>
        </footer>
      </section>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close menu" />}
    </main>
  );
}
