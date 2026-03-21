(async () => {
    "use strict";

    /* ── config ─────────────────────────────────────────────────── */

    const CONFIG = {
        NAME: "Orion",
        VERSION: "v4.0 (Enterprise)",
        THEME: "#5865F2",               // discord blurple
        SUCCESS: "#3BA55C",
        WARN: "#faa61a",
        ERR: "#f04747",
        VIDEO_SPEED: 5,                 // seconds of fake progress per tick
        HIDE_ACTIVITY: false,           // suppress RPC status from friends list
        GAME_CONCURRENCY: 1,            // >1 risks detection, keep at 1
        REQUEST_DELAY: 1500,            // ms between queued API calls
        REMOVE_DELAY: 2000,             // ms before clearing finished task from UI
        MAX_TASK_TIME: 25 * 60 * 1000,  // hard abort per task (25 min)
        VIDEO_CONCURRENCY: 2,
        ACTIVITY_HEARTBEAT_INTERVAL: 20000,
        VIDEO_CHECK_INTERVAL: 1000,
        ENROLL_REFETCH_DELAY: 1500,
        CYCLE_IDLE_WAIT: 5000,
        CYCLE_RESCAN_DELAY: 3000,
        TASK_STAGGER_DELAY: 500,
        PID_MIN: 10000,                 // fake PID range — must look realistic to Discord
        PID_MAX: 50000,
        MAX_LOG_ITEMS: 60,
        MAX_TASK_FAILURES: 5,           // consecutive failures before abandoning a task
        MAX_RETRIES: 3                  // retries for transient (5xx) errors
    };

    // mutable runtime state lives here, CONFIG stays read-only
    const RUNTIME = { running: true };

    const ICONS = Object.freeze({
        BOLT: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.29-.62L14.5 3h1l-1 7h3.5c.58 0 .57.32.29.62L11 21z"/></svg>`,
        VIDEO: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`,
        GAME: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
        STREAM: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
        ACTIVITY: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>`,
        CHECK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
        CLOCK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        STOP: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>`
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

    const Storage = {
        save(key, value) {
            try { window.localStorage.setItem(`orion_${key}`, JSON.stringify(value)); }
            catch (e) { console.debug('[Storage] Write failed:', e.message); }
        },
        load(key) {
            try { const v = window.localStorage.getItem(`orion_${key}`); return v ? JSON.parse(v) : null; }
            catch (e) { return null; }
        }
    };

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
       Position persists across sessions via localStorage.
       Doubles as task-state store — render() rebuilds on every update.
    ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── */

    const Logger = {
        root: null, tasks: new Map(),

        init() {
            const old = document.getElementById('orion-ui'); if (old) old.remove();
            const savedPos = Storage.load('pos') ?? { top: '20px', left: 'auto', right: '20px' };

            const style = document.createElement('style');
            style.innerHTML = `
                @keyframes slideIn { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                @keyframes fadeOut { from { opacity: 1; height: 70px; } to { opacity: 0; height: 0; margin: 0; padding: 0; } }
                @keyframes stripe { 0% { background-position: 40px 0; } 100% { background-position: 0 0; } }
                #orion-ui {
                    position: fixed; top: ${savedPos.top}; left: ${savedPos.left}; right: ${savedPos.right}; width: 380px;
                    background: #111214; color: #dbdee1; border-radius: 8px; font-family: 'gg sans', 'Roboto', sans-serif;
                    z-index: 99999; box-shadow: 0 8px 32px rgba(0,0,0,0.6); border: 1px solid #2b2d31;
                    overflow: hidden; animation: slideIn 0.3s ease; display: flex; flex-direction: column;
                }
                #orion-head { padding: 14px 16px; background: #1e1f22; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2b2d31; cursor: grab; user-select: none; }
                #orion-head:active { cursor: grabbing; background: #232428; }
                #orion-title { font-weight: 800; font-size: 14px; color: #fff; display: flex; align-items: center; gap: 8px; letter-spacing: 0.5px; }
                #orion-title svg { color: ${CONFIG.THEME}; }
                #orion-controls { display: flex; gap: 10px; align-items: center; }
                .ctrl-btn { cursor: pointer; opacity: 0.7; transition: 0.2s; display: flex; align-items: center; }
                .ctrl-btn:hover { opacity: 1; }
                .ctrl-stop { color: #f04747; font-weight: bold; font-size: 10px; gap: 4px; border: 1px solid #f04747; padding: 2px 6px; border-radius: 4px; }
                .ctrl-stop:hover { background: rgba(240, 71, 71, 0.1); }
                #orion-body { padding: 12px; max-height: 400px; overflow-y: auto; flex-grow: 1; }
                ::-webkit-scrollbar { width: 8px; height: 8px; }
                ::-webkit-scrollbar-track { background: #2b2d31; }
                ::-webkit-scrollbar-thumb { background: #1e1f22; border-radius: 4px; }
                ::-webkit-scrollbar-thumb:hover { background: #5865F2; }
                .task-card { display: flex; gap: 12px; padding: 10px; background: #1e1f22; border-radius: 6px; margin-bottom: 8px; border-left: 4px solid ${CONFIG.THEME}; transition: 0.3s; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
                .task-card.done { border-left-color: ${CONFIG.SUCCESS}; background: rgba(59, 165, 92, 0.05); }
                .task-card.pending { border-left-color: ${CONFIG.WARN}; opacity: 0.6; }
                .task-card.removing { animation: fadeOut 0.5s forwards; }
                .task-icon { min-width: 36px; height: 36px; background: rgba(88,101,242,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: ${CONFIG.THEME}; }
                .task-card.done .task-icon { background: rgba(59,165,92,0.2); color: ${CONFIG.SUCCESS}; }
                .task-card.pending .task-icon { background: rgba(250, 166, 26, 0.1); color: ${CONFIG.WARN}; }
                .task-info { flex: 1; overflow: hidden; }
                .task-top { display: flex; justify-content: space-between; margin-bottom: 4px; }
                .task-name { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 190px; color: #fff; }
                .task-status { font-size: 10px; font-weight: 700; color: #949ba4; text-transform: uppercase; }
                .task-meta { display: flex; justify-content: space-between; font-size: 11px; color: #b9bbbe; margin-bottom: 6px; }
                .progress-track { height: 6px; background: #2b2d31; border-radius: 3px; overflow: hidden; }
                .progress-fill { height: 100%; background: linear-gradient(90deg, ${CONFIG.THEME}, #a358f2); width: 0%; transition: width 0.3s; background-image: linear-gradient(45deg,rgba(255,255,255,.1) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.1) 50%,rgba(255,255,255,.1) 75%,transparent 75%,transparent); background-size: 20px 20px; animation: stripe 1s linear infinite; }
                .task-card.done .progress-fill { background: ${CONFIG.SUCCESS}; animation: none; }
                .task-card.pending .progress-fill { width: 0% !important; animation: none; }
                #orion-logs { padding: 10px 12px; background: #0e0f10; font-family: 'Consolas', 'Monaco', monospace; font-size: 11px; color: #949ba4; height: 140px; overflow-y: auto; border-top: 1px solid #2b2d31; scroll-behavior: smooth; }
                .log-item { margin-bottom: 4px; display: flex; gap: 8px; line-height: 1.4; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 2px; }
                .log-ts { opacity: 0.4; min-width: 50px; font-size: 10px; }
                .c-info { color: ${CONFIG.THEME}; } .c-success { color: ${CONFIG.SUCCESS}; } .c-err { color: #f23f43; } .c-warn { color: #faa61a; } .c-debug { color: #555; }
                #orion-footer { padding: 8px; text-align: center; background: #191b1e; border-top: 1px solid #2b2d31; font-size: 10px; color: #72767d; }
                .dev-btn { color: ${CONFIG.THEME}; text-decoration: none; font-weight: 700; transition: color 0.2s; }
                .dev-btn:hover { color: #fff; }
                .claim-btn { padding: 4px 10px; background: ${CONFIG.SUCCESS}; border: none; border-radius: 4px; color: #fff; font-size: 10px; font-weight: 700; cursor: pointer; margin-top: 6px; transition: 0.2s; text-transform: uppercase; letter-spacing: 0.5px; }
                .claim-btn:hover { background: #43c66f; transform: scale(1.03); }
            `;
            document.head.appendChild(style);

            this.root = document.createElement('div');
            this.root.id = 'orion-ui';
            this.root.innerHTML = `
                <div id="orion-head">
                    <span id="orion-title">${ICONS.BOLT} ${CONFIG.NAME} <span style="opacity:0.5; font-size:10px; margin:2px 0 0 5px;">${CONFIG.VERSION}</span></span>
                    <div id="orion-controls">
                        <span class="ctrl-btn ctrl-stop" id="orion-stop" title="Stop script & cleanup">${ICONS.STOP} STOP</span>
                        <span class="ctrl-btn" style="font-size:10px; color:#949ba4;" id="orion-close" title="Shift + .">HIDE</span>
                    </div>
                </div>
                <div id="orion-body"><div style="text-align:center; padding:30px; color:#949ba4; font-size:12px">Initializing System...</div></div>
                <div id="orion-logs"></div>
                <div id="orion-footer">Developed by: <a href="https://discord.com/users/1419678867005767783" target="_blank" class="dev-btn">syntt_</a></div>
            `;
            document.body.appendChild(this.root);

            const head = document.getElementById('orion-head');
            let isDragging = false, startX, startY, initialLeft, initialTop;

            head.onmousedown = e => {
                if (e.target.closest('.ctrl-btn')) return;
                isDragging = true;
                startX = e.clientX; startY = e.clientY;
                const rect = this.root.getBoundingClientRect();
                initialLeft = rect.left; initialTop = rect.top;
                this.root.style.right = 'auto';
                e.preventDefault();
            };

            document.onmousemove = e => {
                if (!isDragging) return;
                this.root.style.left = `${initialLeft + (e.clientX - startX)}px`;
                this.root.style.top = `${initialTop + (e.clientY - startY)}px`;
            };

            document.onmouseup = () => {
                if (isDragging) {
                    isDragging = false;
                    Storage.save('pos', { top: this.root.style.top, left: this.root.style.left, right: 'auto' });
                }
            };

            document.getElementById('orion-close').onclick = () => this.toggle();
            document.getElementById('orion-stop').onclick = () => this.shutdown();
            document.addEventListener('keydown', e => (e.key === '>' || (e.shiftKey && e.key === '.')) && this.toggle());

            try { if (Notification.permission === "default") Notification.requestPermission(); } catch (e) { }
        },

        toggle() { this.root.style.display = this.root.style.display === 'none' ? 'flex' : 'none'; },

        shutdown() {
            if (!RUNTIME.running) return;
            RUNTIME.running = false;
            this.log("Stopping script...", "warn");
            Patcher.clean();
            setTimeout(() => {
                if (this.root?.parentElement) this.root.remove();
                window.orionLock = false;
            }, 1000);
        },

        updateTask(id, data) {
            const isPending = data.status === "PENDING" || data.status === "QUEUE";
            const isDone = data.status === "COMPLETED" || data.status === "CLAIMED";
            this.tasks.set(id, { ...data, done: isDone, pending: isPending });
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
                if (box) {
                    const el = document.createElement('div'); el.className = `log-item c-${type}`;
                    el.innerHTML = `<span class="log-ts">${new Date().toLocaleTimeString().split(' ')[0]}</span> <span>${msg}</span>`;
                    box.appendChild(el); box.scrollTop = box.scrollHeight;
                    while (box.children.length > CONFIG.MAX_LOG_ITEMS) box.firstChild.remove();
                }
            } catch (e) { console.debug('[Logger] DOM error:', e.message); }
        },

        render() {
            const body = document.getElementById('orion-body');
            if (!body) return;
            if (!this.tasks.size) return body.innerHTML = `<div style="text-align:center; padding:30px; color:#949ba4; font-size:12px">Waiting for tasks...</div>`;
            body.innerHTML = '';
            // sort: running (by progress %) → queued → completed
            const sorted = [...this.tasks.entries()].sort((a, b) => {
                const ta = a[1], tb = b[1];
                if (ta.done !== tb.done) return ta.done ? 1 : -1;
                if (ta.pending !== tb.pending) return ta.pending ? 1 : -1;
                // among active tasks, highest progress first
                if (!ta.done && !ta.pending && !tb.done && !tb.pending) {
                    const pctA = ta.max ? ta.cur / ta.max : 0;
                    const pctB = tb.max ? tb.cur / tb.max : 0;
                    return pctB - pctA;
                }
                return 0;
            });
            sorted.forEach(([id, t]) => {
                const pct = t.pending ? 0 : Math.min(100, (t.cur / t.max) * 100).toFixed(1);
                let icon = ICONS.BOLT;
                if (t.done) icon = ICONS.CHECK;
                else if (t.pending) icon = ICONS.CLOCK;
                else if (t.type === 'VIDEO') icon = ICONS.VIDEO;
                else if (t.type === 'ACHIEVEMENT') icon = ICONS.ACTIVITY;
                else if (t.type?.includes('GAME')) icon = ICONS.GAME;
                else if (t.type?.includes('STREAM')) icon = ICONS.STREAM;
                const claimBtn = t.claimable ? `<button class="claim-btn" onclick="window.open('https://discord.com/quests','_blank')">CLAIM REWARD</button>` : '';
                const statusText = t.status === 'CLAIMED' ? 'CLAIMED' : t.done ? 'DONE' : t.status;
                body.innerHTML += `<div class="task-card ${t.done ? 'done' : ''} ${t.pending ? 'pending' : ''} ${t.removing ? 'removing' : ''}"><div class="task-icon">${icon}</div><div class="task-info"><div class="task-top"><div class="task-name" title="${t.name}">${t.name}</div><div class="task-status">${statusText}</div></div><div class="task-meta"><span>${t.pending ? 'In Queue' : 'Progress'}</span><span>${Math.floor(t.cur)} / ${t.max}s</span></div><div class="progress-track"><div class="progress-fill" style="width: ${pct}%"></div></div>${claimBtn}</div></div>`;
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

                    if (err.isRetryable && req.attempts < CONFIG.MAX_RETRIES) {
                        req.attempts++;
                        const delay = (e.body?.retry_after ?? Math.pow(2, req.attempts)) * 1000;
                        Logger.log(`[${err.status}] Retry ${req.attempts}/${CONFIG.MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s`, 'warn');
                        this.queue.unshift(req);
                        await sleep(delay + 500);
                    } else if (err.isClientError) {
                        Logger.log(`[${err.status}] ${err.message}: ${req.url}`, 'debug');
                        req.reject(e);
                    } else {
                        Logger.log(`[Error] ${err.message}: ${req.url}`, 'err');
                        req.reject(e);
                    }
                }
                await sleep(CONFIG.REQUEST_DELAY);
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
            if (!g) return;  // clearing RPC with null causes locale dispatch errors
            try {
                Mods.Dispatcher?.dispatch({
                    type: CONST.EVT.RPC,
                    socketId: null,
                    pid: g.pid,
                    activity: {
                        application_id: g.id,
                        name: g.name,
                        type: 0,
                        details: null,
                        state: null,
                        timestamps: { start: g.start },
                        icon: g.icon,
                        assets: null
                    }
                });
            } catch (e) { }
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

        // adaptive speed: fewer API calls for longer videos, conservative for short ones
        _videoSpeed(target) {
            if (target <= 100) return 5;
            if (target <= 300) return 15;
            if (target <= 600) return 25;
            return 40;
        },

        // sends fake video-progress timestamps until Discord marks the quest done
        async VIDEO(q, t, s) {
            // read progress from actual task key, fall back to type name
            let cur = s.progress?.[t.keyName]?.value ?? s.progress?.[t.type]?.value ?? 0;
            let failCount = 0;
            const speed = this._videoSpeed(t.target);
            Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });

            const startTime = Date.now();
            let calls = 0;

            while (cur < t.target && RUNTIME.running) {
                cur = Math.min(t.target, cur + speed);

                try {
                    const r = await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: cur });
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
                        Logger.log(`[VIDEO] Quest ${t.name} unavailable (${err.status}). Skipping.`, 'warn');
                        return;
                    }
                    if (failCount >= CONFIG.MAX_TASK_FAILURES) {
                        Logger.log(`[VIDEO] Too many failures on ${t.name}. Giving up.`, 'err');
                        return;
                    }
                    Logger.log(`[VIDEO] Progress failed (${failCount}/${CONFIG.MAX_TASK_FAILURES}): ${err.message}`, 'debug');
                }

                Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });

                if (Date.now() - startTime > CONFIG.MAX_TASK_TIME) {
                    Logger.log(`[Timeout] Video ${t.name} stuck after ${((Date.now() - startTime) / 1000).toFixed(0)}s.`, 'err');
                    break;
                }

                await sleep(CONFIG.VIDEO_CHECK_INTERVAL);
            }
            if (RUNTIME.running) {
                Logger.log(`[VIDEO] ${t.name} done in ${calls} API calls`, 'debug');
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
                const pid = rnd(CONFIG.PID_MIN, CONFIG.PID_MAX);
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
                Logger.log(`[${type}] Started: ${gameData.name}`, 'debug');

                const safetyTimer = setTimeout(() => {
                    if (RUNTIME.running) Logger.log(`[Timeout] Task ${t.name} exceeded 25m. Skipping.`, 'err');
                    finish();
                    resolve();
                }, CONFIG.MAX_TASK_TIME);

                const check = (d) => {
                    if (!RUNTIME.running) { clearTimeout(safetyTimer); finish(); resolve(); return; }
                    if (d?.questId !== q.id) return;

                    const prog = d.userStatus?.progress?.[key]?.value ?? d.userStatus?.streamProgressSeconds ?? 0;
                    Logger.updateTask(q.id, { name: t.name, type, cur: prog, max: t.target, status: "RUNNING" });

                    if (prog >= t.target) {
                        clearTimeout(safetyTimer);
                        finish();
                        Tasks.finish(q, t);
                        resolve();
                    }
                };

                // idempotent — safe to call from timeout, heartbeat, or shutdown
                const finish = () => {
                    if (cleaned) return;
                    cleaned = true;
                    try { cleanupHook(); } catch (e) { Logger.log(`[Cleanup] ${e.message}`, 'debug'); }
                    try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (e) { }
                };

                Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, check);
            });
        },

        // ACHIEVEMENT_IN_ACTIVITY — target is usually 1 (a milestone, not seconds).
        // These require actually joining the Discord Activity and earning the achievement.
        // We subscribe to heartbeat events and wait for Discord to report progress,
        // since faking the achievement server-side isn't possible via API alone.
        async ACHIEVEMENT(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING" });
            Logger.log(`[ACHIEVEMENT] Waiting for: ${t.name} (join the Activity to earn it)`, 'info');

            return new Promise(resolve => {
                let cleaned = false;

                const safetyTimer = setTimeout(() => {
                    if (RUNTIME.running) Logger.log(`[Timeout] Achievement ${t.name} — join the Activity manually to complete it.`, 'warn');
                    finish();
                    resolve();
                }, CONFIG.MAX_TASK_TIME);

                const check = (d) => {
                    if (!RUNTIME.running) { clearTimeout(safetyTimer); finish(); resolve(); return; }
                    if (d?.questId !== q.id) return;

                    const prog = d.userStatus?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? 0;
                    Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: prog, max: t.target, status: "RUNNING" });

                    if (prog >= t.target) {
                        clearTimeout(safetyTimer);
                        finish();
                        Tasks.finish(q, t);
                        resolve();
                    }
                };

                const finish = () => {
                    if (cleaned) return;
                    cleaned = true;
                    try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (e) { }
                };

                Mods.Dispatcher?.subscribe(CONST.EVT.HEARTBEAT, check);
            });
        },

        // heartbeat loop against a voice channel to simulate activity participation
        async ACTIVITY(q, t) {
            let chan = null;
            try {
                chan = Mods.ChanStore?.getSortedPrivateChannels()?.[0]?.id
                    ?? Object.values(Mods.GuildChanStore?.getAllGuilds() ?? {}).find(g => g?.VOCAL?.length)?.VOCAL?.[0]?.channel?.id;
            } catch (e) {
                Logger.log(`[ACTIVITY] Channel lookup error: ${e.message}`, 'debug');
            }

            if (!chan) return Logger.log(`[ACTIVITY] No voice channel found for ${t.name}`, 'err');

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
                        Logger.log(`[ACTIVITY] Quest unavailable (${err.status}). Skipping.`, 'warn');
                        return;
                    }
                    if (failCount >= CONFIG.MAX_TASK_FAILURES) {
                        Logger.log(`[ACTIVITY] Too many failures on ${t.name}. Giving up.`, 'err');
                        return;
                    }
                    Logger.log(`[ACTIVITY] Heartbeat failed (${failCount}/${CONFIG.MAX_TASK_FAILURES}): ${err.message}`, 'debug');
                }

                if (Date.now() - startTime > CONFIG.MAX_TASK_TIME) {
                    Logger.log(`[Timeout] Activity ${t.name} stuck after ${((Date.now() - startTime) / 1000).toFixed(0)}s.`, 'err');
                    break;
                }
                await sleep(CONFIG.ACTIVITY_HEARTBEAT_INTERVAL);
            }
            if (RUNTIME.running && cur >= t.target) Tasks.finish(q, t);
        },

        async finish(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
            Logger.log(`Completed: ${t.name}`, 'success');

            try {
                if (typeof Notification !== 'undefined' && Notification.permission === "granted") {
                    new Notification("Orion: Quest Completed", {
                        body: t.name,
                        icon: "https://cdn.discordapp.com/emojis/1120042457007792168.webp",
                        tag: `orion-${q.id}`
                    });
                }
            } catch (e) { Logger.log(`[Notification] ${e.message}`, 'debug'); }

            // optimistic claim — try without captcha, show button if challenged
            try {
                const claimRes = await Mods.API.post({
                    url: `/quests/${q.id}/claim-reward`,
                    body: { platform: 0, location: 11, is_targeted: false, metadata_raw: null, metadata_sealed: null, traffic_metadata_raw: null, traffic_metadata_sealed: null }
                });
                if (claimRes?.body?.claimed_at) {
                    Logger.log(`[Claim] ${t.name} reward claimed automatically!`, 'success');
                    Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                    setTimeout(() => Logger.removeTask(q.id), CONFIG.REMOVE_DELAY);
                    return;
                }
            } catch (e) {
                // captcha required or other error — fall through to claim button
                const needsCaptcha = e?.body?.captcha_key || e?.body?.captcha_sitekey;
                if (needsCaptcha) {
                    Logger.log(`[Claim] ${t.name} needs captcha — use the CLAIM button`, 'warn');
                } else {
                    Logger.log(`[Claim] Auto-claim failed (${e?.status}): ${e?.body?.message ?? e?.message}`, 'debug');
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
            if (typeof webpackChunkdiscord_app === 'undefined') {
                throw new Error("Webpack chunk not found - is this running inside Discord?");
            }

            const req = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]); webpackChunkdiscord_app.pop();
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

            const found = {
                QuestStore:     findStore('QuestStore'),
                RunStore:       findStore('RunningGameStore'),
                StreamStore:    findStore('ApplicationStreamingStore'),
                ChanStore:      findStore('ChannelStore'),
                GuildChanStore: findStore('GuildChannelStore'),
                Dispatcher:     findDispatcher(),
                API:            findAPI()
            };

            const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
            const missing = required.filter(k => !found[k]);
            if (missing.length > 0) throw new Error(`Core modules not found: ${missing.join(', ')}`);

            const optional = ['StreamStore', 'ChanStore', 'GuildChanStore'];
            optional.forEach(k => { if (!found[k]) Logger.log(`[Modules] ${k} not found - some features may be limited`, 'warn'); });

            Mods = found;
            Patcher.init(Mods.RunStore);
            return true;
        } catch (e) {
            Logger.log(`[Modules] ${e.message ?? e}`, 'err');
            console.error(e);
            return false;
        }
    }

    /* ── main loop ─────────────────────────────────────────────── */

    // run N task functions concurrently, staggered to avoid burst traffic
    async function runConcurrent(tasks, limit) {
        const executing = [];
        for (const task of tasks) {
            if (!RUNTIME.running) break;
            const p = task().then(() => executing.splice(executing.indexOf(p), 1));
            executing.push(p);
            await sleep(CONFIG.TASK_STAGGER_DELAY);
            if (executing.length >= limit) await Promise.race(executing);
        }
        return Promise.all(executing);
    }

    async function main() {
        Logger.init();
        if (!loadModules()) return Logger.log('[System] Failed to load Discord modules. Aborting.', 'err');

        let loopCount = 1;

        while (RUNTIME.running) {
            try {
                Logger.log(`Starting Cycle #${loopCount}...`, 'info');

                const getQuests = () => {
                    const q = Mods.QuestStore.quests;
                    return q instanceof Map ? [...q.values()] : Object.values(q);
                };

                let quests = getQuests();

                const incomplete = quests.filter(q =>
                    !q.userStatus?.completedAt
                    && new Date(q.config?.expiresAt).getTime() > Date.now()
                    && q.id !== CONST.ID
                    && !Tasks.skipped.has(q.id)
                );

                const toEnroll = incomplete.filter(q => !q.userStatus?.enrolledAt);

                if (toEnroll.length > 0) {
                    Logger.log(`Enrolling in ${toEnroll.length} new quests...`, 'warn');
                    for (const q of toEnroll) {
                        if (!RUNTIME.running) break;
                        try {
                            await Traffic.enqueue(`/quests/${q.id}/enroll`, { location: 1 });
                        } catch (e) {
                            const questName = q.config?.messages?.questName ?? q.id;
                            if (ErrorHandler.isSkippableQuest(e)) {
                                Tasks.skipped.add(q.id);
                                Logger.log(`[Enroll] ${questName} unavailable (${e.status}). Added to skip list.`, 'warn');
                            } else {
                                Logger.log(`[Enroll] Failed for ${questName}: ${e?.message ?? e}`, 'err');
                            }
                        }
                    }
                    await sleep(CONFIG.ENROLL_REFETCH_DELAY);
                    quests = getQuests();
                }

                const active = quests.filter(q =>
                    !q.userStatus?.completedAt
                    && new Date(q.config?.expiresAt).getTime() > Date.now()
                    && q.id !== CONST.ID
                    && !Tasks.skipped.has(q.id)
                );

                if (!active.length) { Logger.log('All quests finished.', 'success'); break; }

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

                        if (Logger.tasks.has(q.id) && Logger.tasks.get(q.id).status === "RUNNING") return;

                        Logger.updateTask(tInfo.id, { name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target, status: "QUEUE" });

                        const taskFunc = () => {
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
                    Logger.log(`Processing: ${queues.video.length} videos, ${queues.game.length} games.`, 'info');
                    const pGames = runConcurrent(queues.game, CONFIG.GAME_CONCURRENCY);
                    const pVideos = runConcurrent(queues.video, CONFIG.VIDEO_CONCURRENCY);
                    await Promise.all([pGames, pVideos]);
                } else {
                    if (active.length === 0) { Logger.log('All quests finished.', 'success'); break; }
                    else await sleep(CONFIG.CYCLE_IDLE_WAIT);
                }

                if (!RUNTIME.running) break;
                Logger.log(`Cycle #${loopCount} complete. Rescanning...`, 'success');
                await sleep(CONFIG.CYCLE_RESCAN_DELAY);
                loopCount++;

            } catch (cycleError) {
                Logger.log(`[Cycle] Error in cycle #${loopCount}: ${cycleError?.message ?? cycleError}`, 'err');
                console.error(cycleError);
                await sleep(CONFIG.CYCLE_RESCAN_DELAY);
                loopCount++;
            }
        }

        Logger.shutdown();
    }

    // kick it off — top-level catch is the last resort before the script dies
    main().catch(e => {
        const msg = e?.message ?? e?.toString?.() ?? "Unknown fatal error";
        console.error('[Orion Fatal]', e);
        try { Logger.log(`[FATAL] ${msg}`, 'err'); } catch (_) { }
        Logger.shutdown();
    });
})();
