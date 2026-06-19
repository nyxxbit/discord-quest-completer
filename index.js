(async () => {
    "use strict";

    /* ── config (Safe for users to edit) ────────────────────────── */

    const CONFIG = {
        NAME: "Orion",
        VERSION: "v4.9.1",
        THEME: "#5865F2",             // discord blurple
        SUCCESS: "#3BA55C",
        WARN: "#faa61a",
        ERR: "#f04747",
        HIDE_ACTIVITY: false,           // suppress RPC status from friends list
        MAX_LOG_ITEMS: 60               // UI log limit
    };

    /* ── internal system limits (DO NOT EDIT) ─────────────────── */

    const SYS = Object.freeze({
        MAX_TIME: 25 * 60 * 1000,       // hard abort per task (25 min)
        MAX_TASK_FAILURES: 5,           // consecutive network failures
        MAX_RETRIES: 3,                 // 429/5xx transient error retries
        IS_DESKTOP: typeof window.DiscordNative !== 'undefined'
    });

    // mutable runtime state lives here, CONFIG stays read-only
    const RUNTIME = {
        running: true,
        cleanups: new Set(),            // tracks active event listeners for safe shutdown
        autoEnroll: true,               // whether to auto-enroll in quests before execution
        autoClaim: false,               // whether to try auto-claiming quest rewards
        playSound: false,               // whether to play an audio cue on quest completion
        randomDelay: false              // whether to inject randomized 1-30min idle gaps between quests (anti-detection)
    };

    /* ── audio cue ───────────────────────────────────────────────── */
    const Sound = {
        play(type) {
            if (!RUNTIME.playSound) return;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                const ctx = new Ctx();
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.connect(g); g.connect(ctx.destination);
                o.type = 'sine';
                const t0 = ctx.currentTime;
                if (type === 'done') {
                    // C5 E5 G5 arpeggio
                    o.frequency.setValueAtTime(523.25, t0);
                    o.frequency.setValueAtTime(659.25, t0 + 0.12);
                    o.frequency.setValueAtTime(783.99, t0 + 0.24);
                    g.gain.setValueAtTime(0.55, t0);
                    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
                    o.start(t0); o.stop(t0 + 0.6);
                } else {
                    o.frequency.value = 880; // A5
                    g.gain.setValueAtTime(0.45, t0);
                    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
                    o.start(t0); o.stop(t0 + 0.2);
                }
            } catch (_) { }
        }
    };

    const ICONS = Object.freeze({
		OPT: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10.56 1.1c-.46.05-.7.53-.64.98.18 1.16-.19 2.2-.98 2.53-.8.33-1.79-.15-2.49-1.1-.27-.36-.78-.52-1.14-.24-.77.59-1.45 1.27-2.04 2.04-.28.36-.12.87.24 1.14.96.7 1.43 1.7 1.1 2.49-.33.8-1.37 1.16-2.53.98-.45-.07-.93.18-.99.64a11.1 11.1 0 0 0 0 2.88c.06.46.54.7.99.64 1.16-.18 2.2.19 2.53.98.33.8-.14 1.79-1.1 2.49-.36.27-.52.78-.24 1.14.59.77 1.27 1.45 2.04 2.04.36.28.87.12 1.14-.24.7-.95 1.7-1.43 2.49-1.1.8.33 1.16 1.37.98 2.53-.07.45.18.93.64.99a11.1 11.1 0 0 0 2.88 0c.46-.06.7-.54.64-.99-.18-1.16.19-2.2.98-2.53.8-.33 1.79.14 2.49 1.1.27.36.78.52 1.14.24.77-.59 1.45-1.27 2.04-2.04.28-.36.12-.87-.24-1.14-.96-.7-1.43-1.7-1.1-2.49.33-.8 1.37-1.16 2.53-.98.45.07.93-.18.99-.64a11.1 11.1 0 0 0 0-2.88c-.06-.46-.54-.7-.99-.64-1.16.18-2.2-.19-2.53-.98-.33-.8.14-1.79 1.1-2.49.36-.27.52-.78.24-1.14a11.07 11.07 0 0 0-2.04-2.04c-.36-.28-.87-.12-1.14.24-.7.96-1.7 1.43-2.49 1.1-.8-.33-1.16-1.37-.98-2.53.07-.45-.18-.93-.64-.99a11.1 11.1 0 0 0-2.88 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"/></svg>`,
        BOLT: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.29-.62L14.5 3h1l-1 7h3.5c.58 0 .57.32.29.62L11 21z"/></svg>`,
        VIDEO: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`,
        GAME: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
        STREAM: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
        ACTIVITY: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>`,
        CHECK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
        CLOCK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        STOP: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`
    });

    const CONST = Object.freeze({
        ID: "1412491570820812933",  // blacklisted quest — known to break enrollment
        EVT: Object.freeze({
            HEARTBEAT: "QUESTS_SEND_HEARTBEAT_SUCCESS",
            GAME: "RUNNING_GAMES_CHANGE",
            RPC: "LOCAL_ACTIVITY_UPDATE"
        })
    });

    // bail early if another instance is already running in this tab
    if (window.orionLock) {
        const existingUI = document.getElementById('orion-ui');
        if (existingUI) existingUI.style.display = 'flex';
        return console.warn(`[${CONFIG.NAME}] Already running.`);
    }
    window.orionLock = true;

    /* ── util ──────────────────────────────────────────────────── */

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    /* ── error classification ─────────────────────────────────── */
    // Traffic uses this to decide: retry, skip, or propagate.
    // 429/5xx = transient → backoff & retry.  4xx = permanent → skip quest.

    const ErrorHandler = {
        RETRYABLE: new Set([429, 500, 502, 503, 504, 408]),
        CLIENT_ERRORS: new Set([400, 403, 404, 409, 410]),

        classify(error) {
            const status = error?.status ?? error?.statusCode;
            return {
                isRetryable: this.RETRYABLE.has(status),
                isClientError: this.CLIENT_ERRORS.has(status),
                status,
                message: error?.message ?? error?.body?.message ?? `HTTP ${status ?? 'UNKNOWN'}`
            };
        },

        // 404 = quest removed server-side, 403 = region/permission, 410 = gone
        isSkippableQuest(error) {
            const status = error?.status;
            return status === 404 || status === 403 || status === 410;
        }
    };

    /* ── UI + logger ────────────────────────────────────────────
       Injects a draggable dashboard into Discord's DOM.
       Doubles as task-state store — render() rebuilds on every update.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    const Logger = {
        root: null, tasks: new Map(), tickerId: null,

        init() {
            const oldUI = document.getElementById('orion-ui'); if (oldUI) oldUI.remove();
            const oldStyle = document.getElementById('orion-styles'); if (oldStyle) oldStyle.remove();

            const style = document.createElement('style');
            style.id = 'orion-styles';
            style.innerHTML = `
                @keyframes slideIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                @keyframes fadeOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.95); margin: 0; padding: 0; height: 0; border: none; } }

                #orion-ui {
                    position: fixed; top: 32px; left: auto; right: 20px; width: 380px;
                    max-height: 53vh;
                    background: var(--background-base-low); color: var(--text-default);
                    border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-button-overlay); z-index: 1001;
                    font-family: var(--font-primary);
                    overflow: hidden; animation: slideIn 0.3s ease; 
                    display: flex; flex-direction: column; box-sizing: border-box;
                    user-select: none;-webkit-app-region: no-drag;
                }

                #orion-head { padding: 12px 16px; background: var(--background-mod-muted); flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-subtle); cursor: grab; }
                #orion-head.dragging { cursor: grabbing; background: var(--control-secondary-background-default); }
                #orion-title { font-weight: 700; font-size: 15px; color: var(--text-strong); display: flex; align-items: center; gap: 8px; }
                #orion-title svg { color: var(--text-brand); }
                .dev-credit { font-size: 12px; margin-left: -4px; padding-top: 2px; font-weight: 500; color: var(--text-muted); }

                #orion-controls { display: flex; gap: 10px; align-items: center; }
                .ctrl-btn { cursor: pointer; transition: 0.2s; display: flex; align-items: center; }
                .ctrl-hide, .ctrl-opts { font-size: 11px; font-weight: 600; color: var(--text-muted); }
                .ctrl-hide:hover, .ctrl-opts:hover { color: var(--text-default); }
                .ctrl-stop { font-size: 11px; font-weight: 700; gap: 4px; padding: 3px 8px 3px 6px; border-radius: var(--radius-sm); background: transparent; border: 1px solid var(--control-critical-primary-background-default); color: var(--control-critical-primary-background-default); }
                .ctrl-stop:hover { background: var(--control-critical-primary-background-default); color: #fff; }

                #orion-logs { padding: 10px 14px; background: var(--background-base-lower); flex: 0 0 auto; font-family: 'Consolas', 'Monaco', monospace; font-size: 11px; height: 110px; overflow-y: auto; border-top: 1px solid var(--border-subtle); scroll-behavior: smooth; }
                .log-item { margin-bottom: 6px; display: flex; gap: 8px; line-height: 1.4; padding-bottom: 4px; }
                .log-ts { opacity: 0.5; min-width: 50px; font-size: 10px; }
                .c-info { color: var(--text-feedback-info); opacity: .8; } .c-success { color: var(--text-feedback-positive); } .c-err { color: var(--text-feedback-critical); } .c-warn { color: var(--text-feedback-warning); } .c-debug { color: #949ba4; }

                #orion-body { flex: 1 1 auto; padding: 12px; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }

                #orion-picker-form { display: flex; flex-direction: column; min-height: 0; }

                #orion-ui ::-webkit-scrollbar { width: 4px; height: 4px; }
                #orion-ui ::-webkit-scrollbar-track { background: transparent; }
                #orion-ui ::-webkit-scrollbar-thumb { background: var(--scrollbar-auto-scrollbar-color-thumb); border-radius: 4px; }

                .task-card { 
                    --state-color: var(--ansi-bright-blue);
                    --icon-bg-opacity: 15%;
                    --icon-color: var(--state-color);

                    display: flex; gap: 12px; padding: 10px 12px; margin-bottom: 8px; align-items: center;
                    background: var(--control-secondary-background-default); 
                    border-radius: var(--radius-sm); border: 1px solid var(--border-muted); 
                    border-left: 4px solid var(--state-color);
                    box-shadow: var(--shadow-low); transition: 0.3s; flex-shrink: 0;
                }
                .task-card.removing { animation: fadeOut 0.4s forwards; }
                .task-card.done { --state-color: var(--ansi-green); --icon-bg-opacity: 100%; --icon-color: #fff; }
                .task-card.failed { --state-color: var(--ansi-red); }
                .task-card.pending { --state-color: var(--ansi-bright-yellow); }

                .task-icon { position: relative; width: 40px; height: 40px; border-radius: 50%; flex: 0 0 auto; background-color: color-mix(in srgb, var(--state-color) var(--icon-bg-opacity), transparent); display: flex; align-items: center; justify-content: center; }

                .task-card.running .task-icon::before { content: ''; position: absolute; inset: 0; border-radius: 50%; z-index: 1; background: conic-gradient(lch(71 59 139) 0% var(--p, 0%), var(--border-subtle) var(--p, 0%) 100%); -webkit-mask-image: radial-gradient(circle at center, transparent 16px, black 17px); mask-image: radial-gradient(circle at center, transparent 16px, black 17px); }

                .task-icon-inner { z-index: 2; color: var(--icon-color); display: flex; transition: filter 0.2s, opacity 0.2s; }
                .task-card.running:hover .task-icon-inner { filter: blur(2px); opacity: 0.3; }

                .task-icon-overlay { position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: var(--text-default); opacity: 0; transition: opacity 0.2s; pointer-events: none; }
                .task-card.running:hover .task-icon-overlay { opacity: 1; }

                .task-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; justify-content: center; }
                .task-status { font-size: 10px; font-weight: 800; color: var(--state-color); text-transform: uppercase; letter-spacing: 0.5px; }
                .task-name { font-size: 13px; font-weight: 700; color: var(--text-strong); letter-spacing: 0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
                .task-meta { font-size: 11px; font-weight: 700; color: var(--text-muted); display: flex; justify-content: space-between; }
                .task-actions { flex: 0 0 auto; display: flex; align-items: center; margin-left: 4px; }

                .claim-btn, .goto-btn { padding: 6px 10px; border: none; border-radius: var(--radius-sm); font-size: 11px; font-weight: 700; cursor: pointer; transition: 0.2s; text-transform: uppercase; letter-spacing: 0.2px; white-space: nowrap; font-family: inherit; color: #fff; }
                .claim-btn { background: var(--control-connected-background-default); }
                .claim-btn:hover:not(:disabled) { background: var(--control-connected-background-hover); }
                .claim-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .claim-btn.failed { background: var(--control-secondary-background-active); color: var(--text-default); }
                .goto-btn { background: var(--control-primary-background-default); }
                .goto-btn:hover:not(:disabled) { background: var(--control-primary-background-hover); }

                .picker-section-title { font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; }
                .reward-filters { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; flex-shrink: 0; }

                .reward-filter, .type-filter { background-color: transparent; border: 2px solid; padding: 4px 10px; border-radius: 24px; font-size: 10px; font-weight: 600; cursor: pointer; transition: 0.2s; color: var(--text-subtle); font-family: inherit; }
                .reward-filter:hover, .type-filter:hover { background-color: color-mix(in srgb, currentColor 25%, transparent); }
                .reward-filter.off, .type-filter.off { background: transparent; color: var(--text-muted); opacity: 0.4; }

                .picker-quest-list { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 50px; overflow-y: auto; padding-right: 4px; }

                .quest-pick { display: flex; gap: 12px; padding: 10px; background: var(--control-secondary-background-default); border-radius: var(--radius-sm); border: 1px solid var(--border-muted); border-left-width: 4px; cursor: pointer; transition: 0.2s; align-items: center; user-select: none; flex-shrink: 0; }
                .quest-pick:hover { filter: brightness(1.15); }
                .quest-pick.hidden { display: none !important; }

                .native-cb { appearance: none; width: 20px; height: 20px; margin: 0; flex-shrink: 0; border: 1px solid var(--checkbox-border-default); border-radius: var(--radius-xs); background: transparent; cursor: pointer; transition: 0.15s; display: grid; place-content: center; }
                .native-cb::before {
                    content: ''; width: 12px; height: 12px; opacity: 0; transition: 0.1s;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'%3E%3C/polyline%3E%3C/svg%3E");
                    background-size: contain; background-repeat: no-repeat; background-position: center;
                }
                .native-cb:checked { background: var(--checkbox-background-selected-default); border-color: var(--checkbox-border-selected-default); }
                .native-cb:checked::before { opacity: 1; }

                .picker-options { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
                .orion-option { display: flex; justify-content: space-between; align-items: center; background: var(--control-secondary-background-default); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-muted); }
                .orion-option-label { font-size: 13px; font-weight: 500; color: var(--text-default); }

                .native-toggle { appearance: none; width: 40px; height: 20px; margin: 0; flex-shrink: 0; background: var(--control-secondary-background-default); border-radius: 12px; cursor: pointer; position: relative; transition: 0.2s; border: 1px solid var(--border-muted); }
                .native-toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: white; border-radius: 50%; box-shadow: var(--shadow-low); transition: 0.2s; }
                .native-toggle:checked { background: var(--control-primary-background-default); }
                .native-toggle:checked::after { transform: translateX(20px); }

                .picker-actions { display: flex; gap: 10px; padding-top: 12px; flex-shrink: 0; }
                .quest-pick-btn { flex: 1; padding: 10px; border: 1px solid; border-radius: var(--radius-sm, 8px); font-size: 13px; font-weight: 700; cursor: pointer; transition: 0.2s; display: flex; align-items: center; justify-content: center; gap: 6px; font-family: inherit; color: #fff;}
                .quest-pick-btn.start { background-color: var(--control-connected-background-default); border-color: var(--control-connected-border-default); }
                .quest-pick-btn.start:hover:not(:disabled) { background: var(--control-connected-background-hover); border-color: var(--control-connected-border-hover); }
                .quest-pick-btn.deselect { background-color: var(--control-secondary-background-default); border-color: var(--control-secondary-border-default); color: var(--text-default); }
                .quest-pick-btn.deselect:hover:not(:disabled) { background: var(--control-secondary-background-hover); }
                .quest-pick-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            `;
            document.head.appendChild(style);

            this.root = document.createElement('div');
            this.root.id = 'orion-ui';
            this.root.innerHTML = `
                <div id="orion-head">
                    <span id="orion-title">${ICONS.BOLT} ${CONFIG.NAME}
                        <span class="dev-credit">by syntt_</span>
                        <span style="opacity:0.6; font-size:10px; margin-left:4px; padding-top: 3px; font-weight:500;">${CONFIG.VERSION}</span>
                    </span>
                    <div id="orion-controls">
                        <span class="ctrl-btn ctrl-stop" id="orion-stop" title="Stop script">${ICONS.STOP} STOP</span>
                        <span class="ctrl-btn ctrl-hide" id="orion-close" title="Shift + .">HIDE</span>
                        <span class="ctrl-btn ctrl-opts" id="orion-opts" title="Options">${ICONS.OPT}</span>
                    </div>
                </div>
                <div id="orion-body"><div style="text-align:center; padding:30px; color:var(--text-muted); font-size:12px; font-weight:500;">Initializing System...</div></div>
                <div id="orion-logs"></div>
            `;
            document.body.appendChild(this.root);

            const head = document.getElementById('orion-head');

            let collapsed = false;
            head.addEventListener('dblclick', e => {
                if (e.target.closest('.ctrl-btn')) return;
                collapsed = !collapsed;
                this.root.style.height = collapsed ? '50px' : '';
            });

            head.addEventListener('mousedown', e => {
                if (e.target.closest('.ctrl-btn')) return;

                head.classList.add('dragging');

                const startX = e.clientX, startY = e.clientY;
                const rect = this.root.getBoundingClientRect();
                const initialLeft = rect.left, initialTop = rect.top;

                this.root.style.left = `${initialLeft}px`;
                this.root.style.top = `${initialTop}px`;
                this.root.style.right = 'auto';
                e.preventDefault();

                const onMouseMove = ev => {
                    this.root.style.left = `${Math.max(0, Math.min(initialLeft + (ev.clientX - startX), window.innerWidth - this.root.offsetWidth))}px`;
                    this.root.style.top = `${Math.max(0, Math.min(initialTop + (ev.clientY - startY), window.innerHeight - 50))}px`;
                };

                const onMouseUp = () => {
                    head.classList.remove('dragging');
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });

            document.getElementById('orion-body').addEventListener('click', async (e) => {
                if (e.target.classList.contains('goto-btn')) {
                    if (Mods.Router) Mods.Router.transitionTo('/quest-home');
                    return;
                }

                if (e.target.classList.contains('claim-btn')) {
                    const btn = e.target;
                    if (btn.disabled) return;

                    const questId = btn.getAttribute('data-id');
                    const taskData = this.tasks.get(questId);
                    if (!taskData) return;

                    btn.innerText = "WAITING...";
                    btn.disabled = true;
                    btn.style.opacity = "0.5";

                    // save state so render() respects it
                    this.updateTask(questId, { ...taskData, claimState: 'WAITING' });

                    try {
                        const claimRes = await Tasks.claimReward(questId);

                        if (claimRes?.body?.claimed_at) {
                            btn.innerText = "CLAIMED!";
                            this.log(`[Claim] Reward for "${taskData.name}" claimed successfully!`, 'success');

                            this.updateTask(questId, { ...taskData, status: "CLAIMED", claimable: false, claimState: null });
                            setTimeout(() => this.removeTask(questId), 2000);
                        }
                    } catch (err) {
                        this.log(`[Claim] Action required for "${taskData.name}". Check Discord UI for captcha.`, 'warn');
                        // formally update state to FAILED so render() locks it permanently
                        this.updateTask(questId, { ...taskData, claimState: 'FAILED' });
                    }
                }
            });

            document.getElementById('orion-close').onclick = () => this.toggle();
            document.getElementById('orion-stop').onclick = () => this.shutdown();
            document.addEventListener('keydown', e => (e.key === '>' || (e.shiftKey && e.key === '.')) && this.toggle());

            try { if (Notification.permission === "default") Notification.requestPermission(); } catch (e) {
                this.log(`[Notification] Request permission failed: ${e.message}`, 'debug');
            }

            this.startTicker();
        },

        toggle() { this.root.style.display = this.root.style.display === 'none' ? 'flex' : 'none'; },

        shutdown() {
            if (!RUNTIME.running) return;
            RUNTIME.running = false;
            this.log("[System] Stopping script & cleaning up...", "warn");

            if (this.tickerId) clearInterval(this.tickerId);

            for (const cleanupFn of RUNTIME.cleanups) {
                try { cleanupFn(); } catch (e) { this.log(`[Cleanup] ${e.message}`, 'debug'); }
            }
            RUNTIME.cleanups.clear();

            Patcher.clean();
            setTimeout(() => {
                const styles = document.getElementById('orion-styles');
                if (styles) styles.remove();
                if (this.root?.parentElement) this.root.remove();
                window.orionLock = false;
            }, 1000);
        },

        _getPct(t) {
            if (t.done) return 100;
            if (t.pending || t.failed || !t.max) return 0;
            return Math.min(100, (t.cur / t.max) * 100);
        },

        startTicker() {
            if (this.tickerId) clearInterval(this.tickerId);
            this.tickerId = setInterval(() => {
                if (!RUNTIME.running) return clearInterval(this.tickerId);
                for (const [id, task] of this.tasks.entries()) {
                    if (task.status === "RUNNING" && task.type !== "ACHIEVEMENT") {
                        let cur = Math.min(task.cur + 1, task.max);
                        this.updateTask(id, { cur });
                    }
                }
            }, 1000);
        },

        updateTask(id, data) {
            const oldData = this.tasks.get(id);
            const isPending = data.status === "PENDING" || data.status === "QUEUE";
            const isDone = data.status === "COMPLETED" || data.status === "CLAIMED";
            const isFailed = data.status === "FAILED";

            const newData = { ...oldData, ...data, done: isDone, pending: isPending, failed: isFailed };
            this.tasks.set(id, newData);

            if (oldData && oldData.status === newData.status && oldData.removing === newData.removing &&
                oldData.claimable === newData.claimable && oldData.claimState === newData.claimState &&
                oldData.actionRequired === newData.actionRequired) {
                const card = document.getElementById(`orion-task-${id}`);
                if (card) {
                    const pct = this._getPct(newData);

                    const iconContainer = card.querySelector('.task-icon');
                    if (iconContainer) iconContainer.style.setProperty('--p', `${pct}%`);

                    const overlay = card.querySelector('.task-icon-overlay');
                    if (overlay) overlay.textContent = `${Math.floor(pct)}%`;

                    const progressText = card.querySelector('.progress-text');
                    if (progressText) {
                        const unit = newData.type === 'ACHIEVEMENT' ? '' : 's';
                        progressText.textContent = `${Math.min(Math.floor(newData.cur), newData.max)} / ${newData.max}${unit}`;
                    }
                    return;
                }
            }
            this.render();
        },

        removeTask(id) {
            if (this.tasks.has(id)) {
                this.tasks.get(id).removing = true;
                this.render();
                setTimeout(() => { this.tasks.delete(id); this.render(); }, 500);
            }
        },

        log(msg, type = 'info') {
            const colors = { info: "#5865F2", success: "#3BA55C", warn: "#faa61a", err: "#f04747", debug: "#999" };
            console.log(`%c[ORION] %c${msg}`, `color: ${CONFIG.THEME}; font-weight: bold;`, `color: ${colors[type] || colors.info}`);
            try {
                const box = document.getElementById('orion-logs');
                if (box && type !== 'debug') {
                    const el = document.createElement('div'); el.className = `log-item c-${type}`;
                    el.innerHTML = `<span class="log-ts">${new Date().toLocaleTimeString().split(' ')[0]}</span> <span>${msg}</span>`;
                    box.appendChild(el); box.scrollTop = box.scrollHeight;
                    while (box.children.length > CONFIG.MAX_LOG_ITEMS) box.firstChild.remove();
                }
            } catch (e) { console.debug('[Logger] DOM error:', e.message); }
        },

        render() {
            if (document.getElementById('orion-picker-form')) return;
            const body = document.getElementById('orion-body');
            if (!body) return;
            if (!this.tasks.size) return body.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:13px;">Waiting for tasks...</div>`;

            const sorted = [...this.tasks.entries()].sort((a, b) => {
                const ta = a[1], tb = b[1];
                if (ta.done !== tb.done) return ta.done ? 1 : -1;
                if (ta.failed !== tb.failed) return ta.failed ? 1 : -1;
                if (ta.pending !== tb.pending) return ta.pending ? 1 : -1;
                // among active tasks, highest progress first
                if (!ta.done && !ta.pending && !tb.done && !tb.pending) {
                    const pctA = ta.max ? ta.cur / ta.max : 0;
                    const pctB = tb.max ? tb.cur / tb.max : 0;
                    return pctB - pctA;
                }
                return 0;
            });

            body.innerHTML = sorted.map(([id, t]) => {
                const pct = t.pending || t.failed ? 0 : Math.min(100, (t.cur / t.max) * 100).toFixed(1);
                // state-based icons (done/failed/pending) win over type-based icons.
                const icon =
                    t.done ? ICONS.CHECK :
                    t.failed ? ICONS.STOP :
                    t.pending ? ICONS.CLOCK :
                    t.type === 'VIDEO' ? ICONS.VIDEO :
                    t.type === 'ACHIEVEMENT' ? ICONS.ACTIVITY :
                    t.type?.includes('GAME') ? ICONS.GAME :
                    t.type?.includes('STREAM') ? ICONS.STREAM :
                    ICONS.BOLT;

                let statusText = t.status === 'CLAIMED' ? 'CLAIMED' : t.done ? 'COMPLETED' : t.status;
                let progressLabel = t.pending ? 'In Queue' : t.failed ? 'Aborted' : 'Progress';
                const unit = t.type === 'ACHIEVEMENT' ? '' : 's';

                let actionBtn = '';

                if (t.claimable) {
                    if (t.claimState === 'WAITING') actionBtn = `<button class="claim-btn" disabled>WAITING...</button>`;
                    else if (t.claimState === 'FAILED') actionBtn = `<button class="claim-btn failed" disabled>ACTION REQUIRED</button>`;
                    else actionBtn = `<button class="claim-btn" data-id="${id}">CLAIM REWARD</button>`;
                } else if (t.actionRequired === 'ENROLL') {
                    statusText = 'ACTION REQUIRED'; progressLabel = 'Accept quest in Discord';
                    actionBtn = `<button class="goto-btn">GO TO QUESTS</button>`;
                } else if (t.type === 'ACHIEVEMENT' && t.status === 'RUNNING') {
                    statusText = 'ACTION REQUIRED'; progressLabel = 'Please, complete manually';
                    actionBtn = `<button class="goto-btn">GO TO QUESTS</button>`;
                }

                const stateClass = t.done ? 'done' : t.failed ? 'failed' : t.pending ? 'pending' : 'running';
                const removingClass = t.removing ? 'removing' : '';

                let taskMetaHtml = '';
                if (!t.done) {
                    taskMetaHtml = `
                    <div class="task-meta">
                        <span>${progressLabel}</span>
                        ${actionBtn ? '' : `<span class="progress-text">${Math.min(Math.floor(t.cur), t.max)} / ${t.max}${unit}</span>`}
                    </div>`;
                }

                return `
                <div id="orion-task-${id}" class="task-card ${stateClass} ${removingClass}">
                    <div class="task-icon" style="--p: ${pct}%">
                        <div class="task-icon-inner">${icon}</div>
                        ${stateClass === 'running' ? `<div class="task-icon-overlay">${Math.floor(pct)}%</div>` : ''}
                    </div>
                    <div class="task-info">
                        <div class="task-status">${statusText}</div>
                        <div class="task-name" title="${t.name}">${t.name}</div>
                        ${taskMetaHtml}
                    </div>
                    ${actionBtn ? `<div class="task-actions">${actionBtn}</div>` : ''}
                </div>`;
            }).join('');
        },

        showQuestPicker(quests) {
            return new Promise((resolve) => {
                const body = document.getElementById('orion-body');
                const logs = document.getElementById('orion-logs');

                const closePicker = (data) => {
                    if (logs) logs.style.display = 'block';
                    if (body) { body.classList.remove('picker-mode'); body.innerHTML = ''; }
                    resolve(data);
                };

                if (!body) return closePicker({ selectedQuests: new Set(), autoEnroll: false, autoClaim: false, playSound: false });
                if (logs) logs.style.display = 'none';

                const items = [];
                const rewardTypes = new Map();
                const questTypes = new Set();

                const REWARD_META = { 1: { label: "IN-GAME", color: "#e67e22" }, 3: { label: "AVATAR DECORATION", color: "#a358f2" }, 4: { label: "ORBS", color: "#5865F2" } };
                const REWARD_FALLBACK = { label: "OTHER", color: "#949ba4" };

                quests.forEach(q => {
                    const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                    if (!cfg?.tasks) return;

                    const typeData = Tasks.detectType(cfg, q.config?.application?.id);
                    if (!typeData) return;
                    // exclude desktop-only quests (play/stream) on any non-desktop clients
                    if (!SYS.IS_DESKTOP && (typeData.type === 'GAME' || typeData.type === 'STREAM')) return;

                    const rw = q.config?.rewardsConfig?.rewards?.[0];
                    const rewardType = rw?.type ?? 0;
                    const rewardText = rw?.messages?.name ?? "Unknown Reward";

                    const meta = REWARD_META[rewardType] ?? REWARD_FALLBACK;

                    const displayType = typeData.type === 'WATCH_VIDEO' ? 'VIDEO' : typeData.type;
                    questTypes.add(displayType);

                    if (!rewardTypes.has(rewardType)) {
                        rewardTypes.set(rewardType, { label: meta.label, count: 0, type: rewardType, color: meta.color });
                    }
                    rewardTypes.get(rewardType).count++;

                    items.push({
                        id: q.id,
                        name: q.config?.messages?.questName ?? "Unknown Quest",
                        type: displayType,
                        rewardType,
                        rewardText,
                        color: meta.color
                    });
                });

                if (!items.length) return closePicker({ selectedQuests: new Set(), autoEnroll: false, autoClaim: false, playSound: false });

                const buildCard = (q) => `
                    <label class="quest-pick" data-rt="${q.rewardType}" data-qt="${q.type}" style="border-left-color: ${q.color};">
                        <input type="checkbox" name="quests" value="${q.id}" class="native-cb" checked>
                        <div class="task-info">
                            <div class="task-name" title="${q.name}">${q.name}</div>
                            <div class="task-meta" style="justify-content: flex-start; gap: 8px;">
                                <span style="text-transform: uppercase; color: var(--text-subtle);">${q.type}</span>
                                <span style="color: ${q.color};">${q.rewardText}</span>
                            </div>
                        </div>
                    </label>`;

                const buildToggle = (name, label, isChecked) => `
                    <div class="orion-option">
                        <span class="orion-option-label">${label}</span>
                        <input type="checkbox" name="${name}" class="native-toggle" ${isChecked ? 'checked' : ''}>
                    </div>`;

                body.innerHTML = `
                    <form id="orion-picker-form">
                        <div id="orion-options-panel" style="display:none;">
                            ${rewardTypes.size > 1 ? `
                                <div class="picker-section-title">Filter By Reward</div>
                                <div class="reward-filters">
                                    ${[...rewardTypes.values()].map(rt => `<button type="button" class="reward-filter" data-rt="${rt.type}" style="color: ${rt.color}; border-color: ${rt.color};">${rt.label} (${rt.count})</button>`).join('')}
                                </div>
                            ` : ''}
                            ${questTypes.size > 1 ? `
                                <div class="picker-section-title">Filter By Type</div>
                                <div class="reward-filters">
                                    ${[...questTypes].map(t => `<button type="button" class="type-filter" data-qt="${t}">${t}</button>`).join('')}
                                </div>
                            ` : ''}
                            <div class="picker-section-title">Options</div>
                            <div class="picker-options">
                                ${buildToggle('autoEnroll', 'Auto-enroll in quests', RUNTIME.autoEnroll)}
                                ${buildToggle('autoClaim', 'Auto-claim rewards', RUNTIME.autoClaim)}
                                ${buildToggle('playSound', 'Sound on completion', RUNTIME.playSound)}
                                ${buildToggle('randomDelay', 'Random 1-30min delay between cycles', RUNTIME.randomDelay)}
                            </div>
                        </div>

                        <div id="orion-quest-list" class="picker-quest-list">${items.map(buildCard).join('')}
                            <div id="orion-no-quests" style="display: none; margin: auto; text-align: center; color: var(--text-muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
                                No quests available
                            </div>
                        </div>

                        <div class="picker-actions">
                            <button type="button" class="quest-pick-btn deselect" id="select-all-btn">DESELECT ALL</button>
                            <button type="submit" class="quest-pick-btn start" id="start-btn">${ICONS.BOLT} <span id="start-btn-text">START (${items.length})</span></button>
                        </div>
                    </form>`;

                // gear-icon click toggles the options panel. the gear lives in the
                // header (always mounted) but the panel only exists during the picker
                // phase. guard against null so post-picker clicks don't throw.
                document.getElementById('orion-opts').addEventListener('click', () => {
                    const panel = document.getElementById('orion-options-panel');
                    if (!panel) return;
                    const open = panel.style.display === 'none';
                    panel.style.display = open ? '' : 'none';
                    document.getElementById('orion-quest-list').style.display = open ? 'none' : '';
                    form.querySelector('.picker-actions').style.display = open ? 'none' : '';
                });

                const form = document.getElementById('orion-picker-form');
                const selectAllBtn = document.getElementById('select-all-btn');
                const startBtn = document.getElementById('start-btn');

                const getVisibleCheckboxes = () => Array.from(form.querySelectorAll('.quest-pick input[type="checkbox"]'))
                    .filter(cb => !cb.closest('.quest-pick').classList.contains('hidden'));

                const syncUI = () => {
                    const visibleCbs = getVisibleCheckboxes();
                    const totalChecked = visibleCbs.filter(cb => cb.checked).length;

                    const startBtnText = document.getElementById('start-btn-text');
                    if (startBtnText) startBtnText.textContent = `START (${totalChecked})`;
                    startBtn.disabled = totalChecked === 0;

                    if (visibleCbs.length === 0) {
                        selectAllBtn.disabled = true;
                        selectAllBtn.textContent = 'SELECT ALL';
                    } else {
                        selectAllBtn.disabled = false;
                        selectAllBtn.textContent = visibleCbs.every(cb => cb.checked) ? 'DESELECT ALL' : 'SELECT ALL';
                    }

                    const noQuestsMsg = document.getElementById('orion-no-quests');
                    if (noQuestsMsg) {
                        noQuestsMsg.style.display = visibleCbs.length === 0 ? 'block' : 'none';
                    }
                };

                form.addEventListener('change', (e) => { if (e.target.name === 'quests') syncUI(); });

                const activeRewards = new Set([...rewardTypes.keys()].map(String));
                const activeTypes = new Set([...questTypes]);

                const applyFilters = () => {
                    form.querySelectorAll('.quest-pick').forEach(el => {
                        const rt = el.getAttribute('data-rt');
                        const qt = el.getAttribute('data-qt');
                        el.classList.toggle('hidden', !(activeRewards.has(rt) && activeTypes.has(qt)));
                    });
                    syncUI();
                };

                const FILTER_KINDS = [
                    { cls: 'reward-filter', attr: 'data-rt', set: activeRewards },
                    { cls: 'type-filter', attr: 'data-qt', set: activeTypes }
                ];

                form.addEventListener('click', (e) => {
                    const kind = FILTER_KINDS.find(k => e.target.classList.contains(k.cls));
                    if (kind) {
                        e.preventDefault();
                        const value = e.target.getAttribute(kind.attr);
                        e.target.classList.toggle('off');
                        if (e.target.classList.contains('off')) kind.set.delete(value);
                        else kind.set.add(value);
                        applyFilters();
                        return;
                    }

                    if (e.target.id === 'select-all-btn') {
                        e.preventDefault();
                        const visibleCbs = getVisibleCheckboxes();
                        if (visibleCbs.length === 0) return;

                        const shouldCheck = !visibleCbs.every(cb => cb.checked);
                        visibleCbs.forEach(cb => { cb.checked = shouldCheck; });
                        syncUI();
                    }
                });

                form.addEventListener('submit', (e) => {
                    e.preventDefault();

                    const selected = getVisibleCheckboxes().filter(cb => cb.checked);
                    if (selected.length === 0) return;

                    const data = new FormData(form);

                    closePicker({
                        selectedQuests: new Set(selected.map(cb => cb.value)),
                        autoEnroll: data.has('autoEnroll'),
                        autoClaim: data.has('autoClaim'),
                        playSound: data.has('playSound'),
                        randomDelay: data.has('randomDelay')
                    });
                });

                // apply layout lock and sync initial button states
                body.classList.add('picker-mode');
                syncUI();
            });
        }
    };

    /* ── request queue ────────────────────────────────────────────
       FIFO queue processed one-at-a-time to respect rate limits.
       Retryable errors (429, 5xx) re-queue with exponential backoff.
       Client errors (4xx) reject immediately — caller decides what to do.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    const Traffic = {
        queue: [], processing: false,

        async enqueue(url, body) {
            if (!RUNTIME.running) return Promise.reject(new Error("Stopped"));
            return new Promise((resolve, reject) => {
                this.queue.push({ url, body, resolve, reject, attempts: 0 });
                this.process();
            });
        },

        async process() {
            if (this.processing || this.queue.length === 0) return;
            this.processing = true;

            while (this.queue.length > 0) {
                if (!RUNTIME.running) {
                    this.queue.forEach(req => req.reject(new Error("Shutdown")));
                    this.queue = [];
                    this.processing = false;
                    return;
                }

                const req = this.queue.shift();
                try {
                    const res = await Mods.API.post({ url: req.url, body: req.body });
                    req.resolve(res);
                } catch (e) {
                    const err = ErrorHandler.classify(e);

                    if (err.isRetryable && req.attempts < SYS.MAX_RETRIES) {
                        req.attempts++;
                        const delay = (e.body?.retry_after ?? Math.pow(2, req.attempts)) * 1000;
                        const isGlobal = e.body?.global === true;

                        Logger.log(`[Network] Retry ${req.attempts}/${SYS.MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s (HTTP ${err.status})`, 'warn');

                        const retryJitter = rnd(200, 800);

                        if (isGlobal) {
                            // Freeze queue on global rate limits to prevent API abuse
                            this.queue.unshift(req);
                            await sleep(delay + retryJitter);
                        } else {
                            // Non-blocking retry for endpoint-specific limits
                            setTimeout(() => {
                                if (RUNTIME.running) {
                                    this.queue.push(req);
                                    this.process();
                                }
                            }, delay + retryJitter);
                        }
                    } else if (err.isClientError) {
                        Logger.log(`[Network] HTTP ${err.status}: ${req.url}`, 'debug');
                        req.reject(e);
                    } else {
                        Logger.log(`[Network] Request to ${req.url} failed: ${err.message}`, 'err');
                        req.reject(e);
                    }
                }

                await sleep(rnd(1200, 1800)); // delay between API calls
            }
            this.processing = false;
        }
    };

    /* ── store patching ───────────────────────────────────────────
       Monkey-patches Discord's RunStore/StreamStore so the client
       believes a game process is running. Fake PIDs, exePaths, and
       RPC payloads are injected and cleaned up on task completion.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    let Mods = {};  // populated by loadModules() — holds Discord webpack internals

    const Patcher = {
        games: [], realGames: null, realPID: null, active: false,

        // stash originals so we can restore them on cleanup
        init(Store) {
            if (!Store) return;
            this.realGames = Store.getRunningGames;
            this.realPID = Store.getGameForPID;
        },

        // swap between real and patched store methods
        toggle(on) {
            if (on && !this.active) {
                Mods.RunStore.getRunningGames = () => [...this.realGames.call(Mods.RunStore), ...this.games];
                Mods.RunStore.getGameForPID = (pid) => this.games.find(g => g.pid === pid) || this.realPID.call(Mods.RunStore, pid);
                this.active = true;
            } else if (!on && this.active) {
                Mods.RunStore.getRunningGames = this.realGames;
                Mods.RunStore.getGameForPID = this.realPID;
                this.active = false;
            }
        },

        add(g) {
            if (this.games.some(x => x.pid === g.pid)) return;
            this.games.push(g);
            this.toggle(true);
            this.dispatch(g, []);
            this.rpc(g);
        },

        remove(g) {
            const before = this.games.length;
            this.games = this.games.filter(x => x.pid !== g.pid);
            if (this.games.length === before) return;

            this.dispatch([], [g]);
            if (!this.games.length) {
                this.toggle(false);
                this.rpc(null);
            } else {
                this.rpc(this.games[0]);
            }
        },

        dispatch(added, removed) {
            Mods.Dispatcher?.dispatch({
                type: CONST.EVT.GAME,
                added: added ? [added] : [],
                removed: removed ? [removed] : [],
                games: Mods.RunStore.getRunningGames()
            });
        },

        rpc(g) {
            if (CONFIG.HIDE_ACTIVITY && g) return;
            try {
                Mods.Dispatcher?.dispatch({
                    type: CONST.EVT.RPC,
                    socketId: null,
                    // use a fake PID (9999) and null activity to clear the playing status
                    pid: g ? g.pid : 9999,
                    activity: g ? {
                        application_id: g.id,
                        name: g.name,
                        type: 0,
                        details: null,
                        state: null,
                        timestamps: { start: g.start },
                        icon: g.icon,
                        assets: null
                    } : null
                });
            } catch (e) {
                Logger.log(`[RPC Cleanup] ${e.message}`, 'debug');
            }
        },

        clean() {
            this.games = [];
            this.toggle(false);
            this.rpc(null);
        }
    };

    /* ── task handlers ────────────────────────────────────────────
       Each quest type (VIDEO, GAME, STREAM, ACTIVITY) has its own
       handler. GAME/STREAM share a generic() path that patches stores
       and listens for heartbeat events. VIDEO and ACTIVITY poll in a
       loop instead. Failed quest IDs go into `skipped` so we don't
       re-attempt them on the next cycle.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    const Tasks = {
        skipped: new Set(),  // quest IDs that returned 4xx — no point retrying

        sanitize(name) { return name.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, " "); },

        // match task keys from quest config to our handler types
        // order matters — ACHIEVEMENT_IN_ACTIVITY must match before generic ACTIVITY
        detectType(cfg, applicationId) {
            const taskKeys = Object.keys(cfg.tasks);
            const typeMap = [
                { key: "PLAY", type: "GAME" },
                { key: "STREAM", type: "STREAM" },
                { key: "VIDEO", type: "WATCH_VIDEO" },
                { key: "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
                { key: "ACTIVITY", type: "ACTIVITY" }
            ];

            for (const { key, type } of typeMap) {
                const keyName = taskKeys.find(k => k.includes(key));
                if (keyName) return { type, keyName, target: cfg.tasks[keyName]?.target ?? 0 };
            }

            if (applicationId) {
                return { type: "GAME", keyName: "PLAY_ON_DESKTOP", target: cfg.tasks[taskKeys[0]]?.target ?? 0 };
            }

            return null;
        },

        // pull real exe metadata from Discord's app registry; falls back to synthetic paths
        async fetchGameData(appId, appName) {
            try {
                const res = await Mods.API.get({ url: `/applications/public?application_ids=${appId}` });
                const appData = res?.body?.[0];
                const exeEntry = appData?.executables?.find(x => x.os === "win32");
                const rawExe = exeEntry ? exeEntry.name.replace(">", "") : `${this.sanitize(appName)}.exe`;
                const cleanName = this.sanitize(appData?.name || appName);

                return {
                    name: appData?.name || appName,
                    icon: appData?.icon,
                    exeName: rawExe,
                    cmdLine: `C:\\Program Files\\${cleanName}\\${rawExe}`,
                    exePath: `c:/program files/${cleanName.toLowerCase()}/${rawExe}`,
                    id: appId
                };
            } catch (e) {
                Logger.log(`[FetchGame] Fallback for ${appName}: ${e?.message ?? e}`, 'debug');
                const cleanName = this.sanitize(appName);
                const safeExe = `${cleanName.replace(/\s+/g, "")}.exe`;
                return {
                    name: appName, exeName: safeExe,
                    cmdLine: `C:\\Program Files\\${cleanName}\\${safeExe}`,
                    exePath: `c:/program files/${cleanName.toLowerCase()}/${safeExe}`,
                    id: appId
                };
            }
        },

        async claimReward(questId) {
            return await Mods.API.post({
                url: `/quests/${questId}/claim-reward`,
                body: { platform: 0, location: 11, is_targeted: false, metadata_raw: null, metadata_sealed: null, traffic_metadata_raw: null, traffic_metadata_sealed: null }
            });
        },

        // safely aborts a broken or timed-out task, marks it as FAILED in the UI,
        // and adds it to the skip list to prevent infinite retry loops
        failTask(q, t, reason) {
            const currentProgress = Logger.tasks.get(q.id)?.cur ?? 0;
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: currentProgress, max: t.target, status: "FAILED" });
            Logger.log(`[Task] Aborted "${t.name}": ${reason}`, 'err');
            Tasks.skipped.add(q.id);
            setTimeout(() => Logger.removeTask(q.id), 2000); 
        },

        // sends fake video-progress timestamps until Discord marks the quest done
        async VIDEO(q, t, s) {
            // read progress from actual task key, fall back to type name
            let cur = s?.progress?.[t.keyName]?.value ?? s?.progress?.[t.type]?.value ?? 0;
            let failCount = 0;

            Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });

            const startTime = Date.now();
            let calls = 0;

            // Simulate initial player buffer ping
            if (cur === 0) {
                await sleep(rnd(200, 350));
                cur = 0.2 + (Math.random() * 0.05);
                try {
                    await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: Number(cur.toFixed(6)) });
                    calls++;
                } catch (e) { Logger.log(`[Video] Initial ping failed: ${e.message}`, 'debug'); }
            }

            while (cur < t.target && RUNTIME.running) {
                // 2x faster than Discord's native 7-9.5s player cadence
                const delayMs = rnd(3500, 4750);
                await sleep(delayMs);

                // calculate elapsed time with execution jitter
                const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
                cur += elapsedSec;

                // match Discord's 6-decimal float format
                const payloadTs = Number(Math.min(t.target, cur).toFixed(6));

                try {
                    const r = await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: payloadTs });
                    calls++;
                    // sync with server if it reports higher progress
                    const serverVal = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.WATCH_VIDEO?.value;
                    if (serverVal > cur) cur = Math.min(t.target, serverVal);
                    if (r?.body?.completed_at) break;
                    failCount = 0;
                } catch (e) {
                    failCount++;
                    const err = ErrorHandler.classify(e);
                    if (err.isClientError) {
                        Logger.log(`[Task] Video quest unavailable (HTTP ${err.status}). Skipping.`, 'warn');
                        return Tasks.failTask(q, t, `Client Error ${err.status}`);
                    }
                    if (failCount >= SYS.MAX_TASK_FAILURES) {
                        return Tasks.failTask(q, t, 'Too many network failures');
                    }
                    Logger.log(`[Task] VIDEO progress failed (${failCount}/${SYS.MAX_TASK_FAILURES}): ${err.message}`, 'debug');
                }

                Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });

                if (Date.now() - startTime > SYS.MAX_TIME) {
                    return Tasks.failTask(q, t, 'Timeout exceeded');
                }
            }
            if (RUNTIME.running) {
                Logger.log(`[Task] VIDEO "${t.name}" done in ${calls} API calls`, 'debug');
                Tasks.finish(q, t);
            }
        },

        GAME(q, t, s) { return Tasks.generic(q, t, "GAME", "PLAY_ON_DESKTOP", s); },
        STREAM(q, t, s) { return Tasks.generic(q, t, "STREAM", "STREAM_ON_DESKTOP", s); },

        // shared path for GAME/STREAM — injects fake process, subscribes to heartbeat events
        async generic(q, t, type, key, s) {
            if (!RUNTIME.running) return;
            const gameData = await this.fetchGameData(t.appId, t.name);

            return new Promise(resolve => {
                const pid = rnd(2500, 12500) * 4;
                const game = {
                    id: gameData.id, name: gameData.name, icon: gameData.icon,
                    pid, pidPath: [pid], processName: gameData.name, start: Date.now(),
                    exeName: gameData.exeName, exePath: gameData.exePath, cmdLine: gameData.cmdLine,
                    executables: [{ os: 'win32', name: gameData.exeName, is_launcher: false }],
                    windowHandle: 0, fullscreenType: 0, overlay: true, sandboxed: false,
                    hidden: false, isLauncher: false
                };

                let cleanupHook;
                let cleaned = false;
                let safetyTimer;

                if (type === "STREAM") {
                    const real = Mods.StreamStore?.getStreamerActiveStreamMetadata;
                    if (Mods.StreamStore) {
                        Mods.StreamStore.getStreamerActiveStreamMetadata = () => ({ id: gameData.id, pid, sourceName: gameData.name });
                    }
                    cleanupHook = () => { if (Mods.StreamStore && real) Mods.StreamStore.getStreamerActiveStreamMetadata = real; };
                } else {
                    Patcher.add(game);
                    cleanupHook = () => Patcher.remove(game);
                }

                Logger.updateTask(q.id, { name: t.name, type, cur: 0, max: t.target, status: "RUNNING" });
                Logger.log(`[Task] Started ${type}: ${gameData.name}`, 'info');

                const finish = () => {
                    if (cleaned) return;
                    cleaned = true;
                    clearTimeout(safetyTimer);
                    try { cleanupHook(); } catch (e) { Logger.log(`[Task] Cleanup: ${e.message}`, 'debug'); }
                    try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (e) {
                        Logger.log(`[Dispatcher] Unsubscribe failed: ${e.message}`, 'debug');
                    }
                    RUNTIME.cleanups.delete(finish);
                };

                safetyTimer = setTimeout(() => {
                    if (RUNTIME.running) Tasks.failTask(q, t, 'Timeout exceeded (25m)');
                    finish();
                    resolve();
                }, SYS.MAX_TIME);

                const check = (d) => {
                    if (!RUNTIME.running) { finish(); resolve(); return; }
                    if (d?.questId !== q.id) return;

                    const prog = d.userStatus?.progress?.[key]?.value ?? d.userStatus?.streamProgressSeconds ?? 0;
                    Logger.updateTask(q.id, { name: t.name, type, cur: prog, max: t.target, status: "RUNNING" });

                    if (prog >= t.target) {
                        finish();
                        Tasks.finish(q, t);
                        resolve();
                    }
                };

                Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, check);
                RUNTIME.cleanups.add(finish);
            });
        },

        // OAuth2 → discordsays.com bypass for ACHIEVEMENT_IN_ACTIVITY.
        // Discord trusts the activity backend to validate progress, so a forged
        // POST from an authorized session is accepted. Flow:
        //   1) /oauth2/authorize the quest's app (returns code in location URL)
        //   2) /applications/{appId}/proxy-tickets (returns proxy ticket)
        //   3) POST {appId}.discordsays.com/.proxy/acf/authorize {code} → DS token
        //   4) POST {appId}.discordsays.com/.proxy/acf/quest/progress {progress: target}
        //   5) /oauth2/tokens + DELETE to clean up the grant
        //
        // Steps 3-4 are blocked by Discord's renderer CSP (connect-src doesn't
        // include *.discordsays.com). _bypassPost picks the best available
        // transport that escapes CSP: VencordNative if our plugin is installed,
        // DiscordNative if it exposes anything, else direct fetch.
        // POST to a CSP-restricted URL via the best available transport.
        // Returns { ok, status, body } on success, throws { status, body } on HTTP error
        // and TypeError on CSP/network. Probes in order: localhost relay (no mod needed
        // — see tools/orion-relay/), VencordNative plugin (CSP-free via IPC to main
        // process), DiscordNative HTTP candidates (if any exist), raw fetch.
        _relayChecked: false,
        _relayUrl: 'http://127.0.0.1:43210',

        async _probeRelay() {
            if (this._relayChecked) return this._relayAvailable;
            this._relayChecked = true;
            try {
                const r = await Promise.race([
                    fetch(`${this._relayUrl}/health`, { method: 'GET' }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 800))
                ]);
                this._relayAvailable = r.ok;
                if (r.ok) Logger.log('[Bypass] Orion Relay detected on 127.0.0.1:43210.', 'info');
            } catch (_) {
                this._relayAvailable = false;
            }
            return this._relayAvailable;
        },

        async _bypassPost(url, headers, jsonBody) {
            // 1) Localhost relay (tools/orion-relay/) — CSP allows http://127.0.0.1:*,
            //    the relay forwards to discordsays.com from outside the browser sandbox.
            //    This is the no-mod path: standalone userscript + tiny helper.
            if (await this._probeRelay()) {
                const r = await fetch(`${this._relayUrl}/proxy`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, headers, body: jsonBody })
                });
                if (!r.ok) throw { status: r.status, body: await r.text() };
                const result = await r.json();
                if (!result.ok) throw { status: result.status, body: result.body };
                return result;
            }

            // 2) Vencord plugin native module — works if user has OrionQuests Vencord plugin
            //    installed (`vencord-plugin/native.ts`). Routes through Electron main process.
            try {
                const helper = window.VencordNative?.pluginHelpers?.OrionQuests;
                if (helper) {
                    const u = new URL(url);
                    const appId = u.hostname.split('.')[0];
                    const questId = headers['X-Discord-Quest-ID'];
                    const referrer = headers['Referer'];
                    if (u.pathname.endsWith('/acf/authorize')) {
                        const { code } = JSON.parse(jsonBody);
                        const r = await helper.discordsaysAuthorize({ appId, questId, authCode: code, referrer });
                        if (!r.ok) throw { status: r.status, body: r.body };
                        return { ok: true, status: r.status, body: r.body };
                    }
                    if (u.pathname.endsWith('/acf/quest/progress')) {
                        const { progress } = JSON.parse(jsonBody);
                        const token = headers['X-Auth-Token'];
                        const r = await helper.discordsaysProgress({ appId, questId, token, target: progress, referrer });
                        if (!r.ok) throw { status: r.status, body: r.body };
                        return { ok: true, status: r.status, body: r.body };
                    }
                }
            } catch (e) {
                if (e?.status) throw e;
                Logger.log(`[Bypass] VencordNative path errored: ${e?.message ?? e}`, 'debug');
            }

            // 3) DiscordNative HTTP probe. Best-effort — no documented method exists,
            //    but new Discord builds occasionally expose one. We probe several
            //    plausible paths and use the first that's a callable function.
            const dn = window.DiscordNative;
            if (dn) {
                const probes = [
                    () => dn.http?.makeRequest,
                    () => dn.fileManager?.fetchURL,
                    () => dn.processUtils?.fetch,
                    () => dn.app?.makeRequest,
                ];
                for (const probe of probes) {
                    try {
                        const fn = probe();
                        if (typeof fn === 'function') {
                            const r = await fn.call(dn, { method: 'POST', url, headers, body: jsonBody });
                            if (r && (r.status || r.statusCode)) {
                                const status = r.status ?? r.statusCode;
                                return { ok: status >= 200 && status < 300, status, body: r.body ?? r.responseText ?? '' };
                            }
                        }
                    } catch (_) { /* try next probe */ }
                }
            }

            // 4) Direct fetch — works on web Discord (no CSP) or relaxed clients.
            //    CSP-blocked on Discord Desktop: throws TypeError "Failed to fetch".
            const res = await fetch(url, { method: 'POST', headers, body: jsonBody });
            const body = await res.text();
            if (!res.ok) throw { status: res.status, body };
            return { ok: true, status: res.status, body };
        },

        async bypassAchievement(q, t) {
            const appId = q.config?.application?.id;
            if (!appId) return false;
            try {
                Logger.log(`[Bypass] Trying Discord Says auth flow for "${t.name}"...`, 'info');

                const authRes = await Mods.API.post({
                    url: '/oauth2/authorize',
                    query: {
                        response_type: 'code',
                        client_id: appId,
                        scope: 'identify applications.commands applications.entitlements'
                    },
                    body: {
                        permissions: '0',
                        authorize: true,
                        integration_type: 1,
                        location_context: { guild_id: '10000', channel_id: '10000', channel_type: 10000 }
                    }
                });
                const location = authRes?.body?.location;
                if (!location) throw new Error('no location in /oauth2/authorize response');
                const authCode = new URL(location).searchParams.get('code');
                if (!authCode) throw new Error('no code in authorize location');

                const ticketRes = await Mods.API.post({ url: `/applications/${appId}/proxy-tickets`, body: {} });
                const proxyTicket = ticketRes?.body?.ticket;
                if (!proxyTicket) throw new Error('no proxy ticket');

                const referrer = `https://${appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;

                const dsAuthRes = await Tasks._bypassPost(
                    `https://${appId}.discordsays.com/.proxy/acf/authorize`,
                    { 'Content-Type': 'application/json', 'X-Auth-Token': '', 'X-Discord-Quest-ID': q.id, 'Referer': referrer },
                    JSON.stringify({ code: authCode })
                );
                const { token: dsToken } = JSON.parse(dsAuthRes.body);
                if (!dsToken) throw new Error('no discordsays token');

                await Tasks._bypassPost(
                    `https://${appId}.discordsays.com/.proxy/acf/quest/progress`,
                    { 'Content-Type': 'application/json', 'X-Auth-Token': dsToken, 'X-Discord-Quest-ID': q.id, 'Referer': referrer },
                    JSON.stringify({ progress: t.target })
                );

                Logger.log(`[Bypass] Success — "${t.name}" completed via Discord Says.`, 'success');

                // cleanup: remove the OAuth2 grant we just created so the app isn't left authorized
                try {
                    const tokens = await Mods.API.get({ url: '/oauth2/tokens' });
                    const grant = (tokens?.body || []).find(tk => tk.application?.id === appId);
                    if (grant) await Mods.API.del({ url: `/oauth2/tokens/${grant.id}` });
                } catch (e) {
                    Logger.log(`[Bypass] Deauthorize cleanup non-fatal: ${e?.message}`, 'debug');
                }

                return true;
            } catch (e) {
                // Discord renderer CSP blocks connect-src to *.discordsays.com. fetch() throws
                // TypeError "Failed to fetch" without a status. There's no userscript workaround
                // — the bypass needs a main-process HTTP client (Vencord plugin native module).
                if (e instanceof TypeError && /failed to fetch|networkerror/i.test(e.message)) {
                    Logger.log(`[Bypass] Discord's CSP blocks the script from reaching discordsays.com. Use the Vencord plugin port for the auto-bypass — userscript can't bypass CSP. Skipping "${t.name}".`, 'warn');
                    return false;
                }
                // Discord's API client rejects with {status, body:{code,message}}, not Error — stringify properly
                const code = e?.body?.code;
                // 50165 = Cannot launch Age-Gated Activity — activity is age-gated or has been delisted
                if (code === 50165) {
                    Logger.log(`[Bypass] "${t.name}" can't be launched (age-gated or delisted). Discord blocks the proxy ticket — nothing we can do.`, 'warn');
                    return false;
                }
                const parts = [];
                if (e?.status) parts.push(`HTTP ${e.status}`);
                if (code) parts.push(`code ${code}`);
                if (e?.body?.message) parts.push(e.body.message);
                else if (e?.message) parts.push(e.message);
                else if (typeof e === 'string') parts.push(e);
                else if (e) { try { parts.push(JSON.stringify(e).slice(0, 200)); } catch { parts.push(String(e)); } }
                Logger.log(`[Bypass] Failed: ${parts.join(' — ') || 'unknown'}`, 'warn');
                return false;
            }
        },

        // ACHIEVEMENT_IN_ACTIVITY — target is usually 1 (a milestone, not seconds).
        // 1) heartbeat spoof (works for some quests)
        // 2) discordsays OAuth bypass (silver bullet)
        // 3) skip on failure — no more 25-min passive wait
        async ACHIEVEMENT(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING" });

            // attempt active heartbeat spoofing
            let chan = null;
            try {
                chan = Mods.ChanStore?.getSortedPrivateChannels()?.[0]?.id
                    ?? Object.values(Mods.GuildChanStore?.getAllGuilds() ?? {}).find(g => g?.VOCAL?.length)?.VOCAL?.[0]?.channel?.id;
            } catch (e) { Logger.log(`[Achievement] Channel lookup: ${e.message}`, 'debug'); }

            if (chan) {
                Logger.log(`[Task] Attempting heartbeat spoofing for "${t.name}"...`, 'info');
                const key = `call:${chan}:${rnd(1000, 9999)}`;
                let cur = 0;
                let failCount = 0;

                while (cur < t.target && RUNTIME.running) {
                    try {
                        const r = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: false });
                        cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? cur;
                        Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur, max: t.target, status: "RUNNING" });
                        failCount = 0;

                        if (cur >= t.target) {
                            try { await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: true }); }
                            catch (_) { }
                            break;
                        }
                    } catch (e) {
                        failCount++;
                        const err = ErrorHandler.classify(e);
                        if (err.isClientError) {
                            Logger.log(`[Achievement] Heartbeat rejected (HTTP ${err.status}). Falling back to passive mode.`, 'warn');
                            break;
                        }
                        if (failCount >= SYS.MAX_TASK_FAILURES) {
                            Logger.log(`[Achievement] Too many failures. Falling back to passive mode.`, 'warn');
                            break;
                        }
                    }
                    await sleep(rnd(19000, 22000));
                }

                if (cur >= t.target && RUNTIME.running) return Tasks.finish(q, t);
            }

            // heartbeat path failed or skipped — try the Discord Says auth bypass
            if (!RUNTIME.running) return;
            const bypassed = await Tasks.bypassAchievement(q, t);
            if (bypassed) return Tasks.finish(q, t);

            // both auto-paths failed: skip the quest. no more 25-min passive wait.
            if (!RUNTIME.running) return;
            Logger.log(`[Task] Skipping "${t.name}" — no auto-completion path worked (heartbeat rejected, bypass blocked). Likely age-gated/delisted on your account.`, 'warn');
            return Tasks.failTask(q, t, 'Cannot auto-complete');
        },

        // heartbeat loop against a voice channel to simulate activity participation
        async ACTIVITY(q, t) {
            let chan = null;
            try {
                chan = Mods.ChanStore?.getSortedPrivateChannels()?.[0]?.id
                    ?? Object.values(Mods.GuildChanStore?.getAllGuilds() ?? {}).find(g => g?.VOCAL?.length)?.VOCAL?.[0]?.channel?.id;
            } catch (e) {
                Logger.log(`[Task] ACTIVITY channel lookup error: ${e.message}`, 'debug');
            }

            if (!chan) {
                return Tasks.failTask(q, t, 'No voice channel found');
            }

            const key = `call:${chan}:${rnd(1000, 9999)}`;
            let cur = 0;
            let failCount = 0;
            Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });

            const startTime = Date.now();

            while (cur < t.target && RUNTIME.running) {
                try {
                    const r = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: false });
                    cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.PLAY_ACTIVITY?.value ?? cur + 20;
                    Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
                    failCount = 0;
                    if (cur >= t.target) {
                        try { await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: true }); }
                        catch (e) { Logger.log(`[ACTIVITY] Final heartbeat failed: ${e?.message}`, 'debug'); }
                        break;
                    }
                } catch (e) {
                    failCount++;
                    const err = ErrorHandler.classify(e);
                    if (err.isClientError) {
                        Logger.log(`[Task] Activity quest unavailable (HTTP ${err.status}). Skipping.`, 'warn');
                        return Tasks.failTask(q, t, `Client Error ${err.status}`);
                    }
                    if (failCount >= SYS.MAX_TASK_FAILURES) {
                        return Tasks.failTask(q, t, 'Too many network failures');
                    }
                    Logger.log(`[Task] ACTIVITY heartbeat failed (${failCount}/${SYS.MAX_TASK_FAILURES}): ${err.message}`, 'debug');
                }

                if (Date.now() - startTime > SYS.MAX_TIME) {
                    return Tasks.failTask(q, t, 'Timeout exceeded');
                }
                await sleep(rnd(19000, 22000));
            }
            if (RUNTIME.running && cur >= t.target) Tasks.finish(q, t);
        },

        async finish(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
            Logger.log(`[Task] Completed "${t.name}"!`, 'success');
            Sound.play('tick');

            try {
                if (typeof Notification !== 'undefined' && Notification.permission === "granted") {
                    new Notification("Orion: Quest Completed", { body: t.name, icon: "https://cdn.discordapp.com/emojis/1120042457007792168.webp", tag: `orion-${q.id}` });
                }
            } catch (e) { Logger.log(`[Notification] ${e.message}`, 'debug'); }

            if (RUNTIME.autoClaim) {
                try {
                    await sleep(rnd(2500, 6000));
                    if (!RUNTIME.running) return;
                    // optimistic claim — try without captcha, show button if challenged
                    const claimRes = await this.claimReward(q.id);

                    if (claimRes?.body?.claimed_at) {
                        Logger.log(`[Claim] Reward for "${t.name}" claimed automatically!`, 'success');
                        Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                        setTimeout(() => Logger.removeTask(q.id), 2000);  // ms before clearing finished tasks
                        return;
                    }
                } catch (e) {
                    // captcha required or other error — fall through to claim button
                    const needsCaptcha = e?.body?.captcha_key || e?.body?.captcha_sitekey;
                    if (needsCaptcha) {
                        Logger.log(`[Claim] Captcha required for "${t.name}". Use UI button.`, 'warn');
                    } else {
                        Logger.log(`[Claim] Auto-claim failed for "${t.name}": ${e?.body?.message ?? e?.message}`, 'err');
                    }
                }
            }

            // show claim button instead of auto-removing
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true, questId: q.id });
        }
    };

    /* ── webpack module extraction ───────────────────────────────
       Uses getName() as a stable discriminator for Flux stores.
       Real stores return their name (e.g. "QuestStore"), fakes
       return "[object Object]". No hardcoded property paths needed.
       Dispatcher and API use structural checks instead.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    function loadModules() {
        try {
            // === VENCORD USAGE ===
            if (typeof window.Vencord !== 'undefined' && window.Vencord.Webpack) {
                Logger.log('[System] Vencord detected. Using Vencord Webpack API...', 'info');
                const W = window.Vencord.Webpack;

                let routerModule;
                try {
                    const m = W.findByCode('transitionTo -');
                    if (m) {
                        for (const prop of [m, m.default, ...Object.values(m)]) {
                            if (typeof prop === 'function' && prop.toString().includes('transitionTo -')) {
                                routerModule = { transitionTo: prop };
                                break;
                            }
                        }
                    }
                } catch (e) { }

                Mods = {
                    QuestStore: W.findStore('QuestStore') || W.findStore('QuestsStore'),
                    RunStore: W.findStore('RunningGameStore'),
                    StreamStore: W.findStore('ApplicationStreamingStore'),
                    ChanStore: W.findStore('ChannelStore'),
                    GuildChanStore: W.findStore('GuildChannelStore'),
                    Dispatcher: W.Common?.FluxDispatcher || W.findByProps('dispatch', 'subscribe', 'flushWaitQueue'),
                    API: W.Common?.RestAPI || W.findByProps('get', 'post', 'del'),
                    Router: routerModule
                };

                const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
                const missing = required.filter(k => !Mods[k]);

                if (missing.length === 0) {
                    const optional =['StreamStore', 'ChanStore', 'GuildChanStore', 'Router'];
                    optional.forEach(k => { if (!Mods[k]) Logger.log(`[System] Optional module '${k}' not found. Features may be limited.`, 'warn'); });

                    Patcher.init(Mods.RunStore);
                    return true;
                }
                Logger.log(`[System] Vencord extraction missed: ${missing.join(', ')}. Falling back to native...`, 'warn');
            }

            // === NATIVE FALLBACK (Canary / PTB without mods) ===
            if (typeof webpackChunkdiscord_app === 'undefined') {
                throw new Error("Webpack chunk not found - is this running inside Discord?");
            }

            // The push callback fires once per registered webpack runtime. Discord ships
            // Sentry's stripped runtime alongside the real one — Sentry's `req.c` is tiny.
            // Pick the require with the largest cache so we ignore the Sentry instance.
            let req;
            webpackChunkdiscord_app.push([[Symbol()], {}, (r) => {
                const cur = Object.keys(req?.c || {}).length;
                const incoming = Object.keys(r?.c || {}).length;
                if (incoming > cur) req = r;
            }]);
            webpackChunkdiscord_app.pop();

            if (!req?.c) throw new Error("Module registry not available - Discord build incompatible (see issue #20)");

            const modules = Object.values(req.c);

            // real Flux stores have constructor.displayName set to their class name
            // fakes have displayName "Object" — this check never triggers Proxy traps
            function findStore(storeName) {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp || typeof exp !== 'object') continue;
                        for (const key of Object.keys(exp)) {
                            const prop = exp[key];
                            if (prop && typeof prop === 'object'
                                && prop.__proto__?.constructor?.displayName === storeName) {
                                return prop;
                            }
                        }
                    } catch { }
                }
                return undefined;
            }

            // Dispatcher has _subscriptions + subscribe on proto, no valid getName
            function findDispatcher() {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp || typeof exp !== 'object') continue;
                        for (const key of Object.keys(exp)) {
                            const prop = exp[key];
                            if (prop && prop._subscriptions
                                && typeof prop.subscribe === 'function'
                                && typeof prop.dispatch === 'function'
                                && typeof prop.__proto__?.flushWaitQueue === 'function') {
                                return prop;
                            }
                        }
                    } catch { }
                }
                return undefined;
            }

            // Discord's API client has .del (not .delete) — this distinguishes it
            // from generic HTTP wrappers. Also has get/post/put/patch as own props.
            function findAPI() {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp || typeof exp !== 'object') continue;
                        for (const key of Object.keys(exp)) {
                            const prop = exp[key];
                            if (prop && typeof prop.get === 'function'
                                && typeof prop.post === 'function'
                                && typeof prop.del === 'function'
                                && !prop._dispatcher) {
                                return prop;
                            }
                        }
                    } catch { }
                }
                return undefined;
            }

            // Navigation functions are exported standalone and minified.
            // transitionTo is identified by searching its source code for the "transitionTo -" signature.
            function findRouter() {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp) continue;

                        for (const prop of [exp, exp.default, ...Object.values(exp)]) {
                            if (typeof prop === 'function' && prop.toString().includes('transitionTo -')) {
                                return { transitionTo: prop };
                            }
                        }
                    } catch { }
                }
                return undefined;
            }

            Mods = {
                QuestStore: findStore('QuestStore'),
                RunStore: findStore('RunningGameStore'),
                StreamStore: findStore('ApplicationStreamingStore'),
                ChanStore: findStore('ChannelStore'),
                GuildChanStore: findStore('GuildChannelStore'),
                Dispatcher: findDispatcher(),
                API: findAPI(),
                Router: findRouter()
            };

            const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
            const missing = required.filter(k => !Mods[k]);
            if (missing.length > 0) throw new Error(`Core modules not found: ${missing.join(', ')}`);

            const optional = ['StreamStore', 'ChanStore', 'GuildChanStore', 'Router'];
            optional.forEach(k => { if (!Mods[k]) Logger.log(`[System] Optional module '${k}' not found. Features may be limited.`, 'warn'); });
            Patcher.init(Mods.RunStore);
            return true;
        } catch (e) {
            Logger.log(`[System] Module loading error: ${e.message ?? e}`, 'err');
            console.error(e);
            return false;
        }
    }

    /* ── main loop ─────────────────────────────────────────────── */

    // run async tasks concurrently up to a specified limit
    async function runConcurrent(tasks, limit) {
        const executing = new Set();

        for (const task of tasks) {
            if (!RUNTIME.running) break;

            const p = task().finally(() => executing.delete(p));
            executing.add(p);

            await sleep(rnd(1500, 4000)); // stagger initialization to avoid API bursts

            if (executing.size >= limit) {
                await Promise.race(executing);
            }
        }

        // use allSettled to prevent a single rejection from crashing the batch
        return Promise.allSettled(executing);
    }

    async function main() {
        Logger.init();
        if (!loadModules()) return Logger.log('[System] Failed to load Discord modules. Aborting.', 'err');

        // show quest picker and wait for user selection
        const getQuests = () => {
            const q = Mods.QuestStore.quests;
            return q instanceof Map ? [...q.values()] : Object.values(q);
        };

        let quests = getQuests().filter(q =>
            !q.userStatus?.completedAt
            && new Date(q.config?.expiresAt).getTime() > Date.now()
            && q.id !== CONST.ID
            && !Tasks.skipped.has(q.id)
        );

        if (!quests.length) {
            Logger.log('[System] All available quests are completed!', 'success');
            return Logger.shutdown();
        }

        const pickerResult = await Logger.showQuestPicker(quests);
        if (!RUNTIME.running) return;

        // Propagate UI options to global runtime state
        RUNTIME.autoEnroll = pickerResult.autoEnroll;
        RUNTIME.autoClaim = pickerResult.autoClaim;
        RUNTIME.playSound = pickerResult.playSound;
        RUNTIME.randomDelay = pickerResult.randomDelay;

        if (pickerResult.selectedQuests.size === 0) {
            Logger.log('[System] No quests selected. Shutting down.', 'info');
            return Logger.shutdown();
        }

        let loopCount = 1;

        while (RUNTIME.running) {
            try {
                Logger.log(`[Cycle] Starting loop #${loopCount}...`, 'info');
                quests = getQuests();

                // Filter out completed, expired, blacklisted, skipped, AND unselected quests
                const active = quests.filter(q =>
                    pickerResult.selectedQuests.has(q.id)
                    && !q.userStatus?.completedAt
                    && new Date(q.config?.expiresAt).getTime() > Date.now()
                    && q.id !== CONST.ID
                    && !Tasks.skipped.has(q.id)
                );

                if (!active.length) { Logger.log('[System] All available quests are completed!', 'success'); Sound.play('done'); break; }

                const queues = { video: [], game: [] };

                active.forEach(q => {
                    try {
                        const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                        if (!cfg?.tasks || typeof cfg.tasks !== 'object') {
                            Logger.log(`[Quest] ${q.id} has invalid task config. Skipping.`, 'warn');
                            return;
                        }

                        const typeData = Tasks.detectType(cfg, q.config?.application?.id);
                        if (!typeData) {
                            Logger.log(`[Quest] Unknown task type: ${q.config?.messages?.questName ?? q.id}`, 'warn');
                            return;
                        }

                        if (!SYS.IS_DESKTOP && (typeData.type === 'GAME' || typeData.type === 'STREAM')) {
                            Logger.log(`[Quest] "${q.config?.messages?.questName}" requires desktop app. Skipping.`, 'warn');
                            return;
                        }

                        const { type, keyName, target } = typeData;
                        if (target <= 0) {
                            Logger.log(`[Quest] Invalid target (${target}) for ${q.id}. Skipping.`, 'warn');
                            return;
                        }

                        const tInfo = {
                            id: q.id,
                            appId: q.config?.application?.id ?? 0,
                            name: q.config?.messages?.questName ?? "Unknown Quest",
                            target,
                            type,
                            keyName  // actual task key from config (e.g. WATCH_VIDEO_ON_MOBILE)
                        };

                        // handle disabled auto-enroll (wait for user)
                        if (!q.userStatus?.enrolledAt && !RUNTIME.autoEnroll) {
                            Logger.updateTask(tInfo.id, {
                                name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target,
                                status: "PENDING", actionRequired: 'ENROLL'
                            });
                            return; // skip execution queue, wait for next cycle
                        }

                        if (Logger.tasks.has(q.id) && Logger.tasks.get(q.id).status === "RUNNING") return;

                        // clear the action button if user enrolled manually
                        Logger.updateTask(tInfo.id, {
                            name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target,
                            status: "QUEUE", actionRequired: null
                        });

                        const taskFunc = async () => {
                            // JIT enrollment (only if autoEnroll is true or user already enrolled)
                            if (!q.userStatus?.enrolledAt) {
                                Logger.log(`[Enroll] Accepting quest: ${tInfo.name}`, 'info');
                                try {
                                    await Traffic.enqueue(`/quests/${q.id}/enroll`, { location: 11, is_targeted: false });
                                    await sleep(rnd(800, 1500));
                                } catch (e) {
                                    const err = ErrorHandler.classify(e);
                                    if (ErrorHandler.isSkippableQuest(e)) {
                                        Tasks.skipped.add(q.id);
                                        Logger.log(`[Enroll] ${tInfo.name} unavailable (${err.status}). Skipping.`, 'warn');
                                    } else {
                                        Logger.log(`[Enroll] Failed for ${tInfo.name}: ${err.message}`, 'err');
                                    }
                                    return Tasks.failTask(q, tInfo, `Enrollment failed`);
                                }
                            }

                            if (type === "WATCH_VIDEO") return Tasks.VIDEO(q, tInfo, q.userStatus);
                            if (type === "ACHIEVEMENT") return Tasks.ACHIEVEMENT(q, tInfo);
                            const runner = type === "STREAM" ? Tasks.STREAM : (type === "ACTIVITY" ? Tasks.ACTIVITY : Tasks.GAME);
                            return runner(q, tInfo, q.userStatus);
                        };

                        if (type === "WATCH_VIDEO") queues.video.push(taskFunc);
                        else queues.game.push(taskFunc);
                    } catch (e) {
                        Logger.log(`[Quest] Error processing ${q.id}: ${e.message}`, 'err');
                    }
                });

                const totalTasks = queues.video.length + queues.game.length;

                if (totalTasks > 0) {
                    Logger.log(`[Cycle] Processing: ${queues.video.length} videos, ${queues.game.length} games.`, 'info');
                    const pGames = runConcurrent(queues.game, 1);
                    const pVideos = runConcurrent(queues.video, 2);
                    await Promise.all([pGames, pVideos]);
                } else {
                    if (active.length === 0) { Logger.log('[System] All available quests are completed!', 'success'); break; }
                    else await sleep(rnd(4000, 6000));  // idle loop wait
                }

                if (!RUNTIME.running) break;

                // anti-detection: opt-in randomized idle gap between cycles. each cycle
                // typically completes 1+ quests, so this throttles overall quest velocity.
                if (RUNTIME.randomDelay) {
                    const delayMs = rnd(60000, 1800000); // 1-30 minutes
                    Logger.log(`[Cycle] Loop #${loopCount} complete. Random delay: ${Math.round(delayMs / 60000)}m before rescan.`, 'info');
                    await sleep(delayMs);
                } else {
                    Logger.log(`[Cycle] Loop #${loopCount} complete. Waiting before rescan...`, 'info');
                    await sleep(rnd(2500, 4500));
                }
                loopCount++;

            } catch (cycleError) {
                Logger.log(`[Cycle] Error in loop #${loopCount}: ${cycleError?.message ?? cycleError}`, 'err');
                console.error(cycleError);
                await sleep(3000);
                loopCount++;
            }
        }

        // Keep the UI alive if there are unclaimed rewards waiting — losing the
        // dashboard the moment the queue finishes means users miss the CLAIM
        // buttons (especially when auto-claim is off). User can click STOP manually.
        const hasUnclaimed = [...Logger.tasks.values()].some(t => t.claimable && !t.removing);
        if (hasUnclaimed) {
            Logger.log('[System] Quest cycle finished. Claim your rewards above, then click STOP.', 'info');
            return; // skip shutdown; the STOP button still works
        }

        Logger.shutdown();
    }

    main().catch(e => {
        const msg = e?.message ?? e?.toString?.() ?? "Unknown fatal error";
        console.error('[Orion Fatal]', e);
        try { Logger.log(`[System] FATAL: ${msg}`, 'err'); } catch (_) { }
        Logger.shutdown();

        // Failsafe: release lock unconditionally so user can retry without reloading tab
        setTimeout(() => { window.orionLock = false; }, 1500);
    });
})();
