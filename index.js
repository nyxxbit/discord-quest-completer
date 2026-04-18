(async () => {
    "use strict";

    /* ── config (Safe for users to edit) ────────────────────────── */

    const CONFIG = {
        NAME: "Orion",
        VERSION: "v4.5.3 (Enterprise)",
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
        MAX_RETRIES: 3                  // 429/5xx transient error retries
    });

    // mutable runtime state lives here, CONFIG stays read-only
    const RUNTIME = {
        running: true,
        cleanups: new Set(),            // tracks active event listeners for safe shutdown
        autoEnroll: true,               // whether to auto-enroll in quests before execution
        autoClaim: false                // whether to try auto-claiming quest rewards
    };

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
            const oldUI = document.getElementById('orion-ui'); if (oldUI) oldUI.remove();
            const oldStyle = document.getElementById('orion-styles'); if (oldStyle) oldStyle.remove();

            const savedPos = Storage.load('pos') ?? { top: '32px', left: 'auto', right: '20px' };

            const style = document.createElement('style');
            style.id = 'orion-styles';
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
                .ctrl-stop { color: #f04747; font-weight: bold; font-size: 10px; gap: 4px; border: 1px solid #f04747; padding: 2px 6px 2px 2px; border-radius: 4px; }
                .ctrl-stop:hover { background: rgba(240, 71, 71, 0.1); }
                #orion-body { padding: 12px 8px 12px 12px; max-height: 450px; overflow-y: auto; flex-grow: 1; scrollbar-gutter: stable; }
                #orion-ui ::-webkit-scrollbar { width: 4px; height: 4px; }
                #orion-ui ::-webkit-scrollbar-track { background: none; }
                #orion-ui ::-webkit-scrollbar-thumb { background: #5e5f69; border-radius: 4px; }
                #orion-ui ::-webkit-scrollbar-thumb:hover { background: #2b2d31; }
                .task-card { display: flex; gap: 12px; padding: 10px; background: #1e1f22; border-radius: 6px; margin-bottom: 8px; border-left: 4px solid ${CONFIG.THEME}; transition: 0.3s; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
                .task-card.done { border-left-color: ${CONFIG.SUCCESS}; background: rgba(59, 165, 92, 0.05); }
                .task-card.failed { border-left-color: ${CONFIG.ERR}; opacity: 0.8; }
                .task-card.pending { border-left-color: ${CONFIG.WARN}; opacity: 0.6; }
                .task-card.removing { animation: fadeOut 0.5s forwards; }
                .task-icon { min-width: 36px; height: 36px; background: rgba(88,101,242,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: ${CONFIG.THEME}; }
                .task-card.done .task-icon { background: rgba(59,165,92,0.2); color: ${CONFIG.SUCCESS}; }
                .task-card.failed .task-icon { background: rgba(240,71,71,0.1); color: ${CONFIG.ERR}; }
                .task-card.pending .task-icon { background: rgba(250, 166, 26, 0.1); color: ${CONFIG.WARN}; }
                .task-info { flex: 1; overflow: hidden; }
                .task-top { display: flex; justify-content: space-between; margin-bottom: 4px; }
                .task-name { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 190px; color: #fff; }
                .task-status { font-size: 10px; font-weight: 700; color: #949ba4; text-transform: uppercase; }
                .task-meta { display: flex; justify-content: space-between; font-size: 10px; font-weight: 700; color: #b9bbbe; margin-bottom: 6px; }
                .progress-track { height: 6px; background: #2b2d31; border-radius: 3px; overflow: hidden; }
                .progress-fill { height: 100%; background: linear-gradient(90deg, ${CONFIG.THEME}, #a358f2); width: 0%; transition: width 0.3s; background-image: linear-gradient(45deg,rgba(255,255,255,.1) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.1) 50%,rgba(255,255,255,.1) 75%,transparent 75%,transparent); background-size: 20px 20px; animation: stripe 1s linear infinite; }
                .task-card.done .progress-fill { background: ${CONFIG.SUCCESS}; animation: none; }
                .task-card.failed .progress-fill { background: ${CONFIG.ERR}; width: 100% !important; animation: none; opacity: 0.3; }
                .task-card.pending .progress-fill { width: 0% !important; animation: none; }
                .claim-btn, .goto-btn { padding: 4px 10px; border: none; border-radius: 4px; color: #fff; font-size: 10px; font-weight: 700; cursor: pointer; margin-top: 6px; transition: filter 0.2s ease; text-transform: uppercase; letter-spacing: 0.5px; }
                .claim-btn { background: ${CONFIG.SUCCESS}; }
                .goto-btn { background: ${CONFIG.THEME}; }
                .claim-btn:hover, .goto-btn:hover { filter: brightness(1.15); }
                .claim-btn:active, .goto-btn:active { filter: brightness(0.8); }
                #orion-logs { padding: 10px 12px; background: #0e0f10; font-family: 'Consolas', 'Monaco', monospace; font-size: 11px; color: #949ba4; height: 140px; overflow-y: auto; border-top: 1px solid #2b2d31; scroll-behavior: smooth; }
                .log-item { margin-bottom: 4px; display: flex; gap: 8px; line-height: 1.4; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 2px; }
                .log-item:last-of-type { border: none; }
                .log-ts { opacity: 0.4; min-width: 50px; font-size: 10px; }
                .c-info { color: ${CONFIG.THEME}; } .c-success { color: ${CONFIG.SUCCESS}; } .c-err { color: #f23f43; } .c-warn { color: #faa61a; } .c-debug { color: #555; }
                #orion-footer { padding: 8px; text-align: center; background: #191b1e; border-top: 1px solid #2b2d31; font-size: 10px; color: #72767d; }
                .dev-btn { color: ${CONFIG.THEME}; text-decoration: none; font-weight: 700; transition: color 0.2s; }
                .dev-btn:hover { color: #fff; }
                .picker-section-title { font-size: 11px; font-weight: 800; color: #949ba4; margin: 12px 0 8px; letter-spacing: 0.5px; }
                .reward-filters { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
                .reward-filter, .type-filter { background: rgba(255,255,255,0.05); border: 2px solid; padding: 4px 10px; border-radius: 12px; font-size: 10px; font-weight: 700; letter-spacing: 0.3px; cursor: pointer; transition: 0.2s; }
                .reward-filter:hover, .type-filter:hover { background: rgba(255,255,255,0.1); filter: brightness(1.2); }
                .reward-filter.off, .type-filter.off { background: transparent; opacity: 0.4; border-color: #3f4147 !important; color: #80848e !important; }
                .picker-quest-list { display: flex; flex-direction: column; gap: 8px; max-height: 180px; overflow-y: auto; padding-right: 4px; }
                .quest-pick { display: flex; gap: 12px; padding: 10px; background: #1e1f22; border-radius: 6px; border: 1px solid #2b2d31; border-left: 4px solid #2b2d31; cursor: pointer; transition: 0.2s; align-items: center; user-select: none; }
                .quest-pick:hover { border-color: #3f4147; }
                .quest-checkbox { position: relative; width: 18px; height: 18px; flex-shrink: 0; }
                .quest-checkbox input { opacity: 0; width: 0; height: 0; position: absolute; }
                .checkbox-box { position: absolute; top: 0; left: 0; width: 18px; height: 18px; background: #2b2d31; border-radius: 4px; transition: 0.2s; border: 1px solid #3f4147; box-sizing: border-box; }
                .quest-checkbox input:checked ~ .checkbox-box { background: ${CONFIG.THEME}; border-color: ${CONFIG.THEME}; }
                .quest-checkbox input:checked ~ .checkbox-box::after { content: ''; position: absolute; left: 5px; top: 2px; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
                .picker-options { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
                .orion-option { display: flex; justify-content: space-between; align-items: center; background: #1e1f22; padding: 10px 12px; border-radius: 6px; border: 1px solid #2b2d31; }
                .orion-option-label { font-size: 12px; font-weight: 600; color: #dbdee1; }
                .orion-toggle { position: relative; width: 32px; height: 18px; flex-shrink: 0; }
                .orion-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
                .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #80848e; transition: .3s; border-radius: 18px; }
                .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: white; transition: .3s; border-radius: 50%; }
                .orion-toggle input:checked + .slider { background-color: ${CONFIG.SUCCESS}; }
                .orion-toggle input:checked + .slider:before { transform: translateX(14px); }
                .picker-actions { display: flex; gap: 8px; border-top: 1px solid #2b2d31; margin-top: 8px; padding-top: 12px; }
                .quest-pick-btn { flex: 1; padding: 10px; border: none; border-radius: 4px; font-size: 12px; font-weight: 800; cursor: pointer; transition: 0.2s; color: #fff; }
                .quest-pick-btn.start { background: ${CONFIG.SUCCESS}; display: flex; align-items: center; justify-content: center; gap: 6px; }
                .quest-pick-btn.start:hover { filter: brightness(1.15); }
                .quest-pick-btn.deselect { background: #4e5058; }
                .quest-pick-btn.deselect:hover { background: #6d6f78; }
                .quest-pick-btn.deselect:disabled { background: #3f4147; color: #949ba4; cursor: not-allowed; }
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
                this.root.style.left = `${initialLeft}px`;
                this.root.style.top = `${initialTop}px`;
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

            document.getElementById('orion-body').addEventListener('click', async (e) => {
                if (e.target.classList.contains('goto-btn')) {
                    if (Mods.Router) Mods.Router.transitionTo('/quest-home');
                    return;
                }

                if (e.target.classList.contains('claim-btn')) {
                    const btn = e.target;
                    if (btn.disabled) return; // prevent double-clicks

                    const questId = btn.getAttribute('data-id');
                    const taskData = this.tasks.get(questId);
                    if (!taskData) return;

                    btn.innerText = "WAITING...";
                    btn.disabled = true;
                    btn.style.opacity = "0.5";
                    btn.style.cursor = "not-allowed";

                    // save state so render() respects it
                    this.updateTask(questId, { ...taskData, claimState: 'WAITING' });

                    try {
                        const claimRes = await Tasks.claimReward(questId);

                        if (claimRes?.body?.claimed_at) {
                            btn.innerText = "CLAIMED!";
                            btn.style.background = CONFIG.SUCCESS;
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
        },

        toggle() { this.root.style.display = this.root.style.display === 'none' ? 'flex' : 'none'; },

        shutdown() {
            if (!RUNTIME.running) return;
            RUNTIME.running = false;
            this.log("[System] Stopping script & cleaning up...", "warn");

            // safely force-execute all registered task cleanups (unsubscribes/unpatches)
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

        updateTask(id, data) {
            const oldData = this.tasks.get(id);
            const isPending = data.status === "PENDING" || data.status === "QUEUE";
            const isDone = data.status === "COMPLETED" || data.status === "CLAIMED";
            const isFailed = data.status === "FAILED";

            const newData = { ...oldData, ...data, done: isDone, pending: isPending, failed: isFailed };
            this.tasks.set(id, newData);

            // Smart DOM update
            if (oldData && oldData.status === newData.status && oldData.removing === newData.removing &&
                oldData.claimable === newData.claimable && oldData.claimState === newData.claimState &&
                oldData.actionRequired === newData.actionRequired) {
                const card = document.getElementById(`orion-task-${id}`);
                if (card) {
                    const pct = newData.pending || newData.failed ? 0 : Math.min(100, (newData.cur / newData.max) * 100).toFixed(1);

                    const fill = card.querySelector('.progress-fill');
                    if (fill) fill.style.width = `${pct}%`;

                    const unit = newData.type === 'ACHIEVEMENT' ? '' : 's';
                    const progressText = card.querySelector('.progress-text') || card.querySelectorAll('.task-meta span')[1];
                    if (progressText) progressText.textContent = `${Math.floor(newData.cur)} / ${newData.max}${unit}`;

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
            if (!this.tasks.size) return body.innerHTML = `<div style="text-align:center; padding:30px; color:#949ba4; font-size:12px">Waiting for tasks...</div>`;

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

            // Rebuild HTML in a single pass to prevent DOM flickering
            body.innerHTML = sorted.map(([id, t]) => {
                const pct = t.pending || t.failed ? 0 : Math.min(100, (t.cur / t.max) * 100).toFixed(1);
                let icon = ICONS.BOLT;
                if (t.done) icon = ICONS.CHECK;
                else if (t.failed) icon = ICONS.STOP;
                else if (t.pending) icon = ICONS.CLOCK;
                else if (t.type === 'VIDEO') icon = ICONS.VIDEO;
                else if (t.type === 'ACHIEVEMENT') icon = ICONS.ACTIVITY;
                else if (t.type?.includes('GAME')) icon = ICONS.GAME;
                else if (t.type?.includes('STREAM')) icon = ICONS.STREAM;

                let statusText = t.status === 'CLAIMED' ? 'CLAIMED' : t.done ? 'DONE' : t.status;
                let progressLabel = t.pending ? 'In Queue' : t.failed ? 'Aborted' : 'Progress';
                const unit = t.type === 'ACHIEVEMENT' ? '' : 's';

                let actionBtn = '';

                if (t.claimable) {
                    if (t.claimState === 'WAITING') {
                        actionBtn = `<button class="claim-btn" disabled style="opacity: 0.5; cursor: not-allowed;">WAITING...</button>`;
                    } else if (t.claimState === 'FAILED') {
                        actionBtn = `<button class="claim-btn" disabled style="background: #4f545c; opacity: 0.8; cursor: not-allowed;">ACTION REQUIRED</button>`;
                    } else {
                        actionBtn = `<button class="claim-btn" data-id="${id}">CLAIM REWARD</button>`;
                    }
                } else if (t.actionRequired === 'ENROLL') {
                    statusText = 'ACTION REQUIRED';
                    progressLabel = 'Accept quest in Discord';
                    actionBtn = `<button class="goto-btn">GO TO QUESTS</button>`;
                } else if (t.type === 'ACHIEVEMENT' && t.status === 'RUNNING') {
                    statusText = 'ACTION REQUIRED';
                    progressLabel = 'Please, complete manually';
                    actionBtn = `<button class="goto-btn">GO TO QUESTS</button>`;
                }

                const stateClass = t.done ? 'done' : t.failed ? 'failed' : t.pending ? 'pending' : '';
                const removingClass = t.removing ? 'removing' : '';

                return `<div id="orion-task-${id}" class="task-card ${stateClass} ${removingClass}"><div class="task-icon">${icon}</div><div class="task-info"><div class="task-top"><div class="task-name" title="${t.name}">${t.name}</div><div class="task-status">${statusText}</div></div><div class="task-meta"><span>${progressLabel}</span><span class="progress-text">${Math.floor(t.cur)} / ${t.max}${unit}</span></div><div class="progress-track"><div class="progress-fill" style="width: ${pct}%"></div></div>${actionBtn}</div></div>`;
            }).join('');
        },

        showQuestPicker(quests) {
            return new Promise((resolve) => {
                const body = document.getElementById('orion-body');
                const logs = document.getElementById('orion-logs');

                const closePicker = (data) => {
                    if (logs) logs.style.display = 'block';
                    resolve(data);
                };

                if (!body) return closePicker({ selectedQuests: new Set(), autoEnroll: false, autoClaim: false });

                if (logs) logs.style.display = 'none';

                const items = [];
                const rewardTypes = new Map();
                const questTypes = new Set();

                const REWARD_META = { 1: { label: "IN-GAME", color: "#e67e22" }, 3: { label: "AVATAR DECORATION", color: "#a358f2" }, 4: { label: "ORBS", color: CONFIG.THEME } };
                const REWARD_FALLBACK = { label: "OTHER", color: "#4f545c" };

                quests.forEach(q => {
                    const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                    if (!cfg?.tasks) return;

                    const typeData = Tasks.detectType(cfg, q.config?.application?.id);
                    if (!typeData) return;

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

                if (!items.length) return closePicker({ selectedQuests: new Set(), autoEnroll: false, autoClaim: false });

                const buildCard = (q) => `
                    <label class="quest-pick" data-rt="${q.rewardType}" data-qt="${q.type}" style="border-left-color: ${q.color};">
                        <div class="quest-checkbox">
                            <input type="checkbox" name="quests" value="${q.id}" checked>
                            <div class="checkbox-box"></div>
                        </div>
                        <div class="task-info">
                            <div class="task-name" title="${q.name}">${q.name}</div>
                            <div class="task-meta" style="justify-content: flex-start; gap: 8px; margin-top: 2px; margin-bottom: 0;">
                                <span style="text-transform: uppercase;">${q.type}</span>
                                <span style="color: ${q.color};">${q.rewardText}</span>
                            </div>
                        </div>
                    </label>`;

                const buildToggle = (name, label, isChecked) => `
                    <div class="orion-option">
                        <span class="orion-option-label">${label}</span>
                        <label class="orion-toggle">
                            <input type="checkbox" name="${name}" ${isChecked ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>`;

                body.innerHTML = `
                    <form id="orion-picker-form">
                        ${rewardTypes.size > 1 ? `
                            <div class="picker-section-title">FILTER BY REWARD</div>
                            <div class="reward-filters">
                                ${[...rewardTypes.values()].map(rt => `<button type="button" class="reward-filter" data-rt="${rt.type}" style="border-color: ${rt.color}; color: ${rt.color};">${rt.label} (${rt.count})</button>`).join('')}
                            </div>
                        ` : ''}
                        ${questTypes.size > 1 ? `
                            <div class="picker-section-title">FILTER BY TYPE</div>
                            <div class="reward-filters">
                                ${[...questTypes].map(t => `<button type="button" class="type-filter" data-qt="${t}" style="border-color: #949ba4; color: #949ba4;">${t}</button>`).join('')}
                            </div>
                        ` : ''}
                        
                        <div id="orion-quest-list" class="picker-quest-list">
                            ${items.map(buildCard).join('')}
                        </div>
                        
                        <div class="picker-section-title">OPTIONS</div>
                        <div class="picker-options">
                            ${buildToggle('autoEnroll', 'Auto-enroll in quests', RUNTIME.autoEnroll)}
                            ${buildToggle('autoClaim', 'Auto-claim rewards', RUNTIME.autoClaim)}
                        </div>
                        
                        <div class="picker-actions">
                            <button type="button" class="quest-pick-btn deselect" id="select-all-btn">DESELECT ALL</button>
                            <button type="submit" class="quest-pick-btn start" id="start-btn">${ICONS.BOLT} START (${items.length})</button>
                        </div>
                    </form>`;

                const form = document.getElementById('orion-picker-form');
                const selectAllBtn = document.getElementById('select-all-btn');
                const startBtn = document.getElementById('start-btn');

                const getVisibleCheckboxes = () => Array.from(form.querySelectorAll('.quest-pick input[type="checkbox"]'))
                    .filter(cb => cb.closest('.quest-pick').style.display !== 'none');

                const syncUI = () => {
                    const visibleCbs = getVisibleCheckboxes();
                    const totalChecked = visibleCbs.filter(cb => cb.checked).length;

                    startBtn.innerHTML = `${ICONS.BOLT} START (${totalChecked})`;

                    if (visibleCbs.length === 0) {
                        selectAllBtn.disabled = true;
                        selectAllBtn.style.opacity = "0.5";
                        selectAllBtn.textContent = 'SELECT ALL';
                    } else {
                        selectAllBtn.disabled = false;
                        selectAllBtn.style.opacity = "1";
                        const allChecked = visibleCbs.every(cb => cb.checked);
                        selectAllBtn.textContent = allChecked ? 'DESELECT ALL' : 'SELECT ALL';
                    }
                };

                form.addEventListener('change', (e) => {
                    if (e.target.name === 'quests') syncUI();
                });

                const activeRewards = new Set([...rewardTypes.keys()].map(String));
                const activeTypes = new Set([...questTypes]);

                const applyFilters = () => {
                    form.querySelectorAll('.quest-pick').forEach(el => {
                        const rt = el.getAttribute('data-rt');
                        const qt = el.getAttribute('data-qt');

                        const isVisible = activeRewards.has(rt) && activeTypes.has(qt);
                        el.style.display = isVisible ? '' : 'none';
                    });
                    syncUI();
                };

                form.addEventListener('click', (e) => {
                    if (e.target.classList.contains('reward-filter')) {
                        e.preventDefault();
                        const rt = e.target.getAttribute('data-rt');
                        e.target.classList.toggle('off');

                        if (e.target.classList.contains('off')) activeRewards.delete(rt);
                        else activeRewards.add(rt);

                        applyFilters();
                    }

                    if (e.target.classList.contains('type-filter')) {
                        e.preventDefault();
                        const qt = e.target.getAttribute('data-qt');
                        e.target.classList.toggle('off');

                        if (e.target.classList.contains('off')) activeTypes.delete(qt);
                        else activeTypes.add(qt);

                        applyFilters();
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
                    const data = new FormData(form);

                    closePicker({
                        // only quests currently visible in the UI will be executed,
                        // preventing accidental execution of filtered-out quests
                        selectedQuests: new Set(getVisibleCheckboxes().filter(cb => cb.checked).map(cb => cb.value)),
                        autoEnroll: data.has('autoEnroll'),
                        autoClaim: data.has('autoClaim')
                    });
                });
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
            setTimeout(() => Logger.removeTask(q.id), 2000);  // ms before clearing finished tasks
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
                // simulate real client polling interval (7-9.5s)
                const delayMs = rnd(7000, 9500);
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

        // ACHIEVEMENT_IN_ACTIVITY — target is usually 1 (a milestone, not seconds).
        // First tries active heartbeat spoofing (same as ACTIVITY handler).
        // If Discord rejects with 4xx, falls back to passive event monitoring.
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

            // fallback: passive mode — wait for user to complete the activity manually
            if (!RUNTIME.running) return;
            Logger.log(`[Task] Action required: Join Activity to earn "${t.name}"`, 'warn');
            Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING", actionRequired: true });

            return new Promise(resolve => {
                let cleaned = false;
                let safetyTimer;

                const finish = () => {
                    if (cleaned) return;
                    cleaned = true;
                    clearTimeout(safetyTimer);
                    try { Mods.Dispatcher?.unsubscribe(CONST.EVT.HEARTBEAT, check); } catch (e) { }
                    RUNTIME.cleanups.delete(finish);
                };

                safetyTimer = setTimeout(() => {
                    if (RUNTIME.running) Tasks.failTask(q, t, 'Timeout - achievement not earned');
                    finish();
                    resolve();
                }, SYS.MAX_TIME);

                const check = (d) => {
                    if (!RUNTIME.running) { finish(); resolve(); return; }
                    if (d?.questId !== q.id) return;

                    const prog = d.userStatus?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? 0;
                    Logger.updateTask(q.id, { name: t.name, type: "ACHIEVEMENT", cur: prog, max: t.target, status: "RUNNING" });

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

            // Navigation functions are exported standalone and minified.
            // transitionTo is identified by searching its source code for the "transitionTo -" signature.
            function findRouter() {
                for (const m of modules) {
                    try {
                        const exp = m?.exports;
                        if (!exp) continue;

                        for (const prop of Object.values(exp)) {
                            if (typeof prop === 'function' && prop.toString().includes('transitionTo -')) {
                                return { transitionTo: prop };
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
                API:            findAPI(),
                Router:         findRouter()
            };

            const required = ['QuestStore', 'API', 'Dispatcher', 'RunStore'];
            const missing = required.filter(k => !found[k]);
            if (missing.length > 0) throw new Error(`Core modules not found: ${missing.join(', ')}`);

            const optional = ['StreamStore', 'ChanStore', 'GuildChanStore', 'Router'];
            optional.forEach(k => { if (!found[k]) Logger.log(`[System] Optional module '${k}' not found. Features may be limited.`, 'warn'); });

            Mods = found;
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

                if (!active.length) { Logger.log('[System] All available quests are completed!', 'success'); break; }

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
                    const pVideos = runConcurrent(queues.video, 1);
                    await Promise.all([pGames, pVideos]);
                } else {
                    if (active.length === 0) { Logger.log('[System] All available quests are completed!', 'success'); break; }
                    else await sleep(rnd(4000, 6000));  // idle loop wait
                }

                if (!RUNTIME.running) break;
                Logger.log(`[Cycle] Loop #${loopCount} complete. Waiting before rescan...`, 'info');
                await sleep(rnd(2500, 4500));
                loopCount++;

            } catch (cycleError) {
                Logger.log(`[Cycle] Error in loop #${loopCount}: ${cycleError?.message ?? cycleError}`, 'err');
                console.error(cycleError);
                await sleep(3000);
                loopCount++;
            }
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
