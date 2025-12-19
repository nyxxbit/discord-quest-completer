(async () => {
    "use strict";

    const CONFIG = {
        NAME: "Orion",
        VERSION: "v3.5",
        THEME: "#5865F2",
        SUCCESS: "#3BA55C",
        WARN: "#faa61a",
        ERR: "#f04747",
        VIDEO_SPEED: 5,
        FAKE_ACTIVITY: true,
        GAME_CONCURRENCY: 4,
        REQUEST_DELAY: 1500,
        REMOVE_DELAY: 2000
    };

    if (window.orionLock) return console.warn(`[${CONFIG.NAME}] Already running.`);
    window.orionLock = true;

    const ICONS = {
        BOLT: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.29-.62L14.5 3h1l-1 7h3.5c.58 0 .57.32.29.62L11 21z"/></svg>`,
        VIDEO: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`,
        GAME: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
        STREAM: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
        ACTIVITY: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>`,
        CHECK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
        CLOCK: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`
    };

    const Logger = {
        root: null, tasks: new Map(),
        init() {
            const old = document.getElementById('orion-ui'); if (old) old.remove();
            const style = document.createElement('style');
            style.innerHTML = `
                @keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
                @keyframes fadeOut { from { opacity: 1; height: 70px; } to { opacity: 0; height: 0; margin: 0; padding: 0; } }
                @keyframes stripe { 0% { background-position: 40px 0; } 100% { background-position: 0 0; } }
                #orion-ui { position: fixed; top: 20px; right: 20px; width: 380px; background: #111214; color: #dbdee1; border-radius: 8px; font-family: 'gg sans', 'Roboto', sans-serif; z-index: 99999; box-shadow: 0 8px 32px rgba(0,0,0,0.6); border: 1px solid #2b2d31; overflow: hidden; animation: slideIn 0.3s ease; display: flex; flex-direction: column; }
                #orion-head { padding: 14px 16px; background: #1e1f22; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2b2d31; }
                #orion-title { font-weight: 800; font-size: 14px; color: #fff; display: flex; align-items: center; gap: 8px; letter-spacing: 0.5px; }
                #orion-title svg { color: ${CONFIG.THEME}; }
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
            `;
            document.head.appendChild(style);

            this.root = document.createElement('div');
            this.root.id = 'orion-ui';
            this.root.innerHTML = `
                <div id="orion-head">
                    <span id="orion-title">${ICONS.BOLT} ${CONFIG.NAME} <span style="opacity:0.5; font-size:10px; margin-left:5px">${CONFIG.VERSION}</span></span>
                    <span style="font-size:10px; color:#949ba4; cursor:pointer" id="orion-close">SHIFT + .</span>
                </div>
                <div id="orion-body"><div style="text-align:center; padding:30px; color:#949ba4; font-size:12px">Initializing System...</div></div>
                <div id="orion-logs"></div>
                <div id="orion-footer">Developed by: <a href="https://discord.com/users/1419678867005767783" target="_blank" class="dev-btn">syntt_</a></div>
            `;
            document.body.appendChild(this.root);
            document.getElementById('orion-close').onclick = () => this.toggle();
            document.addEventListener('keydown', e => (e.key === '>' || (e.shiftKey && e.key === '.')) && this.toggle());
        },
        toggle() { this.root.style.display = this.root.style.display === 'none' ? 'flex' : 'none'; },
        updateTask(id, data) {
            const isPending = data.status === "PENDING" || data.status === "QUEUE";
            this.tasks.set(id, { ...data, done: data.status === "COMPLETED", pending: isPending });
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
            const box = document.getElementById('orion-logs'); 
            if (box) {
                const el = document.createElement('div'); el.className = `log-item c-${type}`;
                el.innerHTML = `<span class="log-ts">${new Date().toLocaleTimeString().split(' ')[0]}</span> <span>${msg}</span>`;
                box.appendChild(el); box.scrollTop = box.scrollHeight; 
                if (box.children.length > 60) box.firstChild.remove();
            }
        },
        render() {
            const body = document.getElementById('orion-body');
            if (!this.tasks.size) return body.innerHTML = `<div style="text-align:center; padding:30px; color:#949ba4; font-size:12px">Waiting for tasks...</div>`;
            body.innerHTML = '';
            const sorted = [...this.tasks.entries()].sort((a, b) => {
                if (a[1].done) return 1; if (b[1].done) return -1;
                if (a[1].pending && !b[1].pending) return 1; if (!a[1].pending && b[1].pending) return -1;
                return 0;
            });
            sorted.forEach(([id, t]) => {
                const pct = t.pending ? 0 : Math.min(100, (t.cur / t.max) * 100).toFixed(1);
                let icon = ICONS.BOLT;
                if (t.done) icon = ICONS.CHECK;
                else if (t.pending) icon = ICONS.CLOCK;
                else if (t.type === 'VIDEO') icon = ICONS.VIDEO;
                else if (t.type.includes('GAME')) icon = ICONS.GAME;
                else if (t.type.includes('STREAM')) icon = ICONS.STREAM;
                body.innerHTML += `<div class="task-card ${t.done ? 'done' : ''} ${t.pending ? 'pending' : ''} ${t.removing ? 'removing' : ''}"><div class="task-icon">${icon}</div><div class="task-info"><div class="task-top"><div class="task-name" title="${t.name}">${t.name}</div><div class="task-status">${t.done ? 'DONE' : t.status}</div></div><div class="task-meta"><span>${t.pending ? 'In Queue' : 'Progress'}</span><span>${Math.floor(t.cur)} / ${t.max}s</span></div><div class="progress-track"><div class="progress-fill" style="width: ${pct}%"></div></div></div></div>`;
            });
        }
    };

    const Traffic = {
        queue: [], processing: false,
        async enqueue(url, body) {
            return new Promise((resolve, reject) => {
                this.queue.push({ url, body, resolve, reject });
                this.process();
            });
        },
        async process() {
            if (this.processing || this.queue.length === 0) return;
            this.processing = true;
            while (this.queue.length > 0) {
                const req = this.queue.shift();
                try {
                    const res = await Mods.API.post({ url: req.url, body: req.body });
                    req.resolve(res);
                } catch (e) {
                    if (e.status === 429) {
                        const delay = (e.body?.retry_after || 5) * 1000;
                        Logger.log(`Rate Limit! Pausing for ${(delay/1000).toFixed(1)}s`, 'warn');
                        this.queue.unshift(req);
                        await sleep(delay + 1000);
                    } else { req.reject(e); }
                }
                await sleep(CONFIG.REQUEST_DELAY);
            }
            this.processing = false;
        }
    };

    const CONST = { ID: "1412491570820812933", EVT: { HEARTBEAT: "QUESTS_SEND_HEARTBEAT_SUCCESS", GAME: "RUNNING_GAMES_CHANGE", RPC: "LOCAL_ACTIVITY_UPDATE" } };
    let Mods = {};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    const Patcher = {
        games: [], realGames: null, realPID: null, active: false,
        init(Store) { this.realGames = Store.getRunningGames; this.realPID = Store.getGameForPID; },
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
        add(g) { this.games.push(g); this.toggle(true); this.dispatch(g, []); if (CONFIG.FAKE_ACTIVITY) this.rpc(g); },
        remove(g) { 
            this.games = this.games.filter(x => x.pid !== g.pid); 
            this.dispatch([], [g]); 
            if (!this.games.length) { this.toggle(false); if (CONFIG.FAKE_ACTIVITY) this.rpc(null); }
            else if (CONFIG.FAKE_ACTIVITY) this.rpc(this.games[0]);
        },
        dispatch(added, removed) { Mods.Dispatcher.dispatch({ type: CONST.EVT.GAME, added: added ? [added] : [], removed: removed ? [removed] : [], games: Mods.RunStore.getRunningGames() }); },
        rpc(g) { 
            Mods.Dispatcher.dispatch({ type: CONST.EVT.RPC, socketId: null, pid: 9999, activity: g ? { application_id: g.id, name: g.name, type: 0, details: "Orion Helper", state: "Completing Quests", timestamps: { start: g.start }, assets: { large_image: g.id } } : null });
        },
        clean() { this.games = []; this.toggle(false); this.rpc(null); }
    };

    const Tasks = {
        async VIDEO(q, t, s) {
            let cur = s.progress?.[t.type]?.value ?? 0;
            Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });
            
            while (cur < t.target) {
                cur = Math.min(t.target, cur + CONFIG.VIDEO_SPEED);
                try { 
                    const r = await Traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: cur }); 
                    if (r.body.completed_at) break; 
                } catch(e) {}
                Logger.updateTask(q.id, { name: t.name, type: "VIDEO", cur, max: t.target, status: "RUNNING" });
            }
            Tasks.finish(q, t);
        },
        GAME(q, t, s) { return Tasks.generic(q, t, "GAME", "PLAY_ON_DESKTOP", s); },
        STREAM(q, t, s) { return Tasks.generic(q, t, "STREAM", "STREAM_ON_DESKTOP", s); },
        
        generic(q, t, type, key, s) {
            return new Promise(resolve => {
                const pid = rnd(10000, 50000);
                const game = { 
                    id: t.id, name: t.name, pid: pid, pidPath: [pid],
                    start: Date.now(), processName: "game",
                    exeName: "game.exe", exePath: "c:/program files/game/game.exe", 
                    cmdLine: "C:\\Program Files\\Game\\game.exe",
                    executables: [{ os: 'win32', name: 'game.exe', is_launcher: false }],
                    windowHandle: 0, fullscreenType: 0, overlay: true, sandboxed: false,
                    hidden: false, isLauncher: false
                };
                
                if (type === "STREAM") {
                    const real = Mods.StreamStore.getStreamerActiveStreamMetadata;
                    Mods.StreamStore.getStreamerActiveStreamMetadata = () => ({ id: t.id, pid, sourceName: "Orion" });
                    var cleanupHook = () => Mods.StreamStore.getStreamerActiveStreamMetadata = real;
                } else {
                    Patcher.add(game);
                    var cleanupHook = () => Patcher.remove(game);
                }

                Logger.updateTask(q.id, { name: t.name, type, cur: 0, max: t.target, status: "RUNNING" });
                Logger.log(`[${type}] Starting process: ${t.name}`, 'debug');

                const check = (d) => {
                    if (d.questId !== q.id) return;
                    const prog = d.userStatus.progress?.[key]?.value ?? d.userStatus.streamProgressSeconds ?? 0;
                    Logger.updateTask(q.id, { name: t.name, type, cur: prog, max: t.target, status: "RUNNING" });
                    if (prog >= t.target) {
                        finish();
                        Tasks.finish(q, t);
                    }
                };

                const finish = () => {
                    cleanupHook();
                    Mods.Dispatcher.unsubscribe(CONST.EVT.HEARTBEAT, check);
                    resolve();
                };

                Mods.Dispatcher.subscribe(CONST.EVT.HEARTBEAT, check);
            });
        },

        async ACTIVITY(q, t) {
            const chan = Mods.ChanStore.getSortedPrivateChannels()[0]?.id ?? Object.values(Mods.GuildChanStore.getAllGuilds()).find(g => g?.VOCAL?.length)?.VOCAL[0]?.channel?.id;
            if (!chan) return Logger.log(`No voice channel found for ${t.name}`, 'err');
            
            const key = `call:${chan}:${rnd(1000,9999)}`;
            let cur = 0;
            Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });

            while (cur < t.target) {
                try {
                    const r = await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: false });
                    cur = r.body.progress?.PLAY_ACTIVITY?.value ?? cur + 20;
                    Logger.updateTask(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
                    if (cur >= t.target) {
                        await Traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: true });
                        break;
                    }
                } catch {}
                await sleep(20000);
            }
            Tasks.finish(q, t);
        },

        finish(q, t) {
            Logger.updateTask(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
            Logger.log(`Completed: ${t.name}`, 'success');
            setTimeout(() => Logger.removeTask(q.id), CONFIG.REMOVE_DELAY);
        }
    };

    function loadModules() {
        try {
            const req = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]); webpackChunkdiscord_app.pop();
            const found = {
                StreamStore: Object.values(req.c).find(x => x?.exports?.Z?.__proto__?.getStreamerActiveStreamMetadata)?.exports?.Z,
                RunStore: Object.values(req.c).find(x => x?.exports?.ZP?.getRunningGames)?.exports?.ZP,
                QuestStore: Object.values(req.c).find(x => x?.exports?.Z?.__proto__?.getQuest)?.exports?.Z,
                ChanStore: Object.values(req.c).find(x => x?.exports?.Z?.__proto__?.getAllThreadsForParent)?.exports?.Z,
                GuildChanStore: Object.values(req.c).find(x => x?.exports?.ZP?.getSFWDefaultChannel)?.exports?.ZP,
                Dispatcher: Object.values(req.c).find(x => x?.exports?.Z?.__proto__?.flushWaitQueue)?.exports?.Z,
                API: Object.values(req.c).find(x => x?.exports?.tn?.get)?.exports?.tn
            };
            if (!found.QuestStore || !found.API) throw "Core modules not found";
            Mods = found;
            Patcher.init(Mods.RunStore);
            return true;
        } catch (e) { console.error(e); return false; }
    }

    async function runConcurrent(tasks, limit) {
        const executing = [];
        for (const task of tasks) {
            const p = task().then(() => executing.splice(executing.indexOf(p), 1));
            executing.push(p);
            await sleep(500); 
            if (executing.length >= limit) await Promise.race(executing);
        }
        return Promise.all(executing);
    }

    async function main() {
        Logger.init();
        if (!loadModules()) return Logger.log('Failed to load modules', 'err');
        
        let loopCount = 1;
        while(true) {
            Logger.log(`Starting Cycle #${loopCount}...`, 'info');
            const getQuests = () => (Mods.QuestStore.quests instanceof Map ? [...Mods.QuestStore.quests.values()] : Object.values(Mods.QuestStore.quests));
            let quests = getQuests();
            
            const incomplete = quests.filter(q => !q.userStatus?.completedAt && new Date(q.config.expiresAt).getTime() > Date.now() && q.id !== CONST.ID);
            const toEnroll = incomplete.filter(q => !q.userStatus?.enrolledAt);

            if (toEnroll.length > 0) {
                Logger.log(`Enrolling in ${toEnroll.length} new quests...`, 'warn');
                for (const q of toEnroll) await Traffic.enqueue(`/quests/${q.id}/enroll`, { location: 1 });
                await sleep(1500); quests = getQuests(); 
            }

            const active = quests.filter(q => !q.userStatus?.completedAt && new Date(q.config.expiresAt).getTime() > Date.now() && q.id !== CONST.ID);
            if (!active.length) { Logger.log('All quests finished.', 'success'); break; }

            Logger.log(`Processing ${active.length} quests.`, 'info');
            const queue = { videos: [], complex: [] };

            active.forEach(q => {
                const cfg = q.config.taskConfig ?? q.config.taskConfigV2;
                const taskKeys = Object.keys(cfg.tasks);
                let type = null, target = 0, keyName = "";

                if (taskKeys.some(k => k.includes("PLAY"))) { type = "GAME"; keyName = taskKeys.find(k => k.includes("PLAY")); } 
                else if (taskKeys.some(k => k.includes("STREAM"))) { type = "STREAM"; keyName = taskKeys.find(k => k.includes("STREAM")); } 
                else if (taskKeys.some(k => k.includes("VIDEO"))) { type = "WATCH_VIDEO"; keyName = taskKeys.find(k => k.includes("VIDEO")); } 
                else if (taskKeys.some(k => k.includes("ACTIVITY"))) { type = "ACTIVITY"; keyName = taskKeys.find(k => k.includes("ACTIVITY")); } 
                else if (q.config.application.id) { type = "GAME"; keyName = "PLAY_ON_DESKTOP"; target = cfg.tasks[taskKeys[0]].target; }

                if (keyName && !target) target = cfg.tasks[keyName].target;
                if (!type) return Logger.log(`Unknown task type: ${q.config.messages.questName}`, 'warn');

                const tInfo = { id: q.config.application.id, name: q.config.messages.questName, target: target, type: type, originalKey: keyName };
                Logger.updateTask(tInfo.id, { name: tInfo.name, type: tInfo.type, cur: 0, max: tInfo.target, status: "QUEUE" });

                if (type === "WATCH_VIDEO") queue.videos.push(Tasks.VIDEO(q, tInfo, q.userStatus));
                else {
                    const runner = type === "STREAM" ? Tasks.STREAM : (type === "ACTIVITY" ? Tasks.ACTIVITY : Tasks.GAME);
                    queue.complex.push(() => runner(q, tInfo, q.userStatus));
                }
            });

            if (queue.videos.length > 0) {
                Logger.log(`Launching ${queue.videos.length} videos...`, 'info');
                Promise.all(queue.videos);
            }

            if (queue.complex.length > 0) {
                Logger.log(`Launching ${queue.complex.length} games (${CONFIG.GAME_CONCURRENCY} concurrent)...`, 'warn');
                await runConcurrent(queue.complex, CONFIG.GAME_CONCURRENCY);
            } else {
                await sleep(5000);
            }

            Logger.log(`Cycle #${loopCount} complete. Rescanning...`, 'success');
            await sleep(3000); loopCount++;
        }
        
        Logger.log('Orion finished. Closing in 5s...', 'success');
        setTimeout(() => { Logger.root.remove(); window.orionLock = false; }, 5000);
    }

    main().catch(e => Logger.log(e.message, 'err')).finally(() => Patcher.clean());
})();